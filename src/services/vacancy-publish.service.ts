import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution, PlatformConnection, PlatformCredential, Vacancy } from "@/models";
import type { PlatformCredentialDoc, VacancyDoc } from "@/models";
import { AppError, notFound, validationError } from "@/lib/api/errors";
import {
  PLATFORM_LABELS,
  VACANCY_CLAIM_STATES,
  type VacancyClaimState,
  type VacancyListingContract,
  type VacancyListingRemoteStatus,
} from "@/lib/constants";
import { credentialVaultReady, decryptCredential } from "@/lib/security/credentials";
import { adapterFor } from "@/lib/connectors";
import { createConnectorHttp } from "@/lib/connectors/http";
import {
  ConnectorAuthError,
  ConnectorCapExceededError,
  ConnectorRejectedError,
  type AdapterContext,
  type ConnectionState,
  type JobPushResult,
  type PlatformAdapter,
} from "@/lib/connectors/types";
import {
  buildAggregatedJobBody,
  buildSchoolJobBody,
  preflight,
  preflightPatch,
  type InstitutionPushInput,
  type RemoteJobSalary,
  type VacancyPushInput,
} from "@/lib/connectors/edufleet-vacancy-map";
import { ActivityService } from "./activity.service";

/**
 * The eduFleet vacancy push — the orchestrator.
 *
 * Three modules meet here and nothing else does: the pure mapping module
 * (`edufleet-vacancy-map.ts`) decides what a push should contain and whether
 * eduFleet would refuse it, the adapter (`edufleet.ts`) sends it and
 * classifies the answer, and this service decides *which* call to make and
 * *what to record*. It re-validates nothing `preflight` already checks and
 * builds no body of its own.
 *
 * Two structural rules govern the file:
 *
 * 1. **It must never import `vacancy.service.ts`.** Task 5 makes
 *    `VacancyService.remove` close a listing through `pushClose` below, so the
 *    dependency runs one way only; importing back would be a runtime cycle.
 *    That is why every vacancy read here goes straight to the `Vacancy` model.
 * 2. **Every query is scoped by `institutionId`.** A vacancy id alone is not
 *    an authorisation: an unscoped `findById` would let one school publish,
 *    edit or close another school's vacancy on a public jobs board. The
 *    filter is load-bearing on the reads AND on the writes.
 *
 * The economics that shape the rest: eduFleet runs `spendWrite()` BEFORE it
 * validates anything on all four job routes, so every `400` and every `409`
 * permanently burns a daily write unit without creating anything.
 *
 * **Which budget it burns is not the same question as which school pushed.**
 * Contract Two spends the school's own grant (`PartnerGrant`, 100/day), and
 * only that school pays. Contract One spends `spendWrite(auth.partner)` —
 * the **Partner** document's 500/day pool, which is IDAP's single
 * platform-wide budget shared by every school with no eduFleet connection.
 * A push that reliably fails under Contract One is therefore not a
 * per-school bug: one misconfigured institution can exhaust the pool and
 * stop every OTHER unconnected school from publishing. That asymmetry is why
 * `preflight` refuses locally rather than letting eduFleet answer, and why no
 * field eduFleet exact-match validates against a list IDAP does not control
 * ever leaves the mapping module unresolved — `district` is checked against a
 * transcribed copy of that list and omitted with a warning when it does not
 * match, so a profile typo costs reach rather than the platform's budget (see
 * `buildAggregatedJobBody`).
 *
 * Every local refusal below therefore happens before `ctx.http` exists, and
 * no failure is ever retried.
 */

const PLATFORM = "EDUFLEET" as const;
const LABEL = PLATFORM_LABELS[PLATFORM];

type Actor = { id: string; name: string };

export type VacancyListingDTO = {
  jobId: string;
  externalJobId: string;
  contract: VacancyListingContract;
  lastPushedAt: string;
  remoteStatus: VacancyListingRemoteStatus;
  claimState?: VacancyClaimState;
  blockedReason?: string;
  /** The advert's public page, when eduFleet gave one (creates only). */
  publicUrl?: string;
  /**
   * What eduFleet still holds for each bound. Surfaced — not just used
   * internally by `preflightPatch` — because it is the only honest way to
   * warn a school that clearing a salary here will NOT clear it there: an
   * update can change a bound but has no value that means "remove" it, so the
   * figure below is what the public advert keeps showing until the listing is
   * closed and republished. `experienceRequired` is here for exactly the same
   * reason and no other — it is the third field a partner update can change
   * but never remove, and unlike the bounds nothing validates against it.
   */
  remoteSalaryMin?: number;
  remoteSalaryMax?: number;
  remoteExperienceRequired?: number;
};

/**
 * What one push did. The split is deliberate and is the file's single
 * hardest-working rule:
 *
 * - **Refused before the wire → thrown `AppError`.** Nothing was sent, no
 *   write unit was spent, and the caller's request was simply not valid yet
 *   (no such vacancy, a `DRAFT`, no city, a failing `preflight`).
 * - **eduFleet answered → a returned outcome.** The push happened; a `403`
 *   or a `409` is a *state of the listing* the school needs to see and act
 *   on, not a failed request — and `BLOCKED` in particular must never latch
 *   the vacancy as dead (two of eduFleet's four `403` triggers reverse on
 *   their own).
 *
 * `NOT_LISTED` is the honest third case: there was nothing on eduFleet to
 * close, so nothing was sent and nothing failed. Task 5's `remove` depends on
 * being able to tell that apart from a close that was refused.
 */
export type VacancyPublishOutcome =
  | {
      status: "PUSHED";
      listing: VacancyListingDTO;
      /**
       * Things the advert went out WITHOUT, on a push that otherwise
       * succeeded — today, only an institution district eduFleet could not
       * recognise (`buildAggregatedJobBody`). Absent on almost every push.
       *
       * Deliberately not `blockedReason`, which the card prints and which the
       * reconciler reads as "this listing is out of step with IDAP" — writing
       * one here would make `planFor` REPUSH this vacancy on every sweep, one
       * write unit at a time, to change nothing. This is the opposite fact:
       * the push landed, and the advert simply reaches fewer teachers than it
       * could. So it is reported once, to the person who pressed Publish.
       */
      warnings?: string[];
    }
  | { status: "CLOSED"; listing: VacancyListingDTO }
  | { status: "NOT_LISTED" }
  | { status: "BLOCKED"; message: string; listing?: VacancyListingDTO }
  | {
      status: "CONFLICT";
      message: string;
      ownedByContract?: VacancyListingContract;
      listing?: VacancyListingDTO;
    };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A malformed id must read as "no such vacancy", not as a cast error —
 *  same convention as `VacancyService.toObjectId`. */
function toObjectId(vacancyId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(vacancyId)) throw notFound("Vacancy not found");
  return new Types.ObjectId(vacancyId);
}

/**
 * Bounds one remote-derived value before it is persisted and shown — the same
 * policy `edufleet.ts` states for `lastError`, applied here because
 * `listing.blockedReason` has no `maxlength` either and reaches the browser.
 */
function clip(value: string): string {
  return value.slice(0, 120);
}

/**
 * A plain thrown `Error` from an adapter call means eduFleet itself failed
 * (unreachable, misconfigured, an uncataloged 5xx). Its raw message must not
 * reach the response body verbatim, but the caller must not get the generic
 * "Something went wrong" 500 either — that hides a knowable, external,
 * actionable cause. Same 502 shape and same reasoning as
 * `connection.service.ts`'s `upstreamError`.
 */
function upstreamError(): AppError {
  return new AppError(
    "INTERNAL_ERROR",
    `${LABEL} could not be reached right now — try again shortly`,
    undefined,
    502,
  );
}

/**
 * What a school is told, and what the Integrations card must say, when
 * eduFleet refuses the grant IDAP is holding for it. Exported so the three
 * entry points that have to render it — the publish route's thrown error,
 * `pushEdit`'s `blockedReason`, and the delete's refusal — all say the same
 * sentence rather than three near-misses.
 */
export const GRANT_REVOKED_MESSAGE =
  `Your ${LABEL} connection was revoked, so IDAP can no longer post as your school. Reconnect to ${LABEL} from Integrations, then try again.`;

/** A 409, not a 502: nothing is wrong with eduFleet and nothing will change
 *  by waiting — the school has to reconnect. */
function grantRevokedError(): AppError {
  return new AppError("CONFLICT", GRANT_REVOKED_MESSAGE);
}

/**
 * H3. eduFleet has refused this school's grant, so IDAP must stop treating
 * the connection as live — the same two writes `connection.service.ts` makes
 * from `refresh` and `syncNow`: drop the ciphertext eduFleet already rejected,
 * and set `DISCONNECTED`, which is the status that re-offers "Request
 * connection" on the card.
 *
 * Duplicated rather than imported, and that is forced rather than chosen:
 * `connection.service.ts` imports THIS file (its sync worklist calls
 * `repush`/`pushClose`), so importing it back would close a runtime cycle.
 * The same reason `buildContext` duplicates `loadAdapterContext`.
 *
 * Conditional on the row still being `CONNECTED`, for two reasons. It cannot
 * resurrect or invent a row for a school that has none, and it makes the
 * write idempotent, so the audit entry below is written by whichever caller
 * actually observed the transition rather than by every one that follows it.
 *
 * TENANT-SENSITIVE: `institutionId` scopes the write like every other here. A
 * revocation is about exactly one school's grant, and a filter that matched
 * only on `platform` would disconnect every school on IDAP.
 */
async function disconnectRevokedGrant(
  institutionId: string,
  message: string,
  actor: Actor,
): Promise<void> {
  const flipped = await PlatformConnection.findOneAndUpdate(
    { institutionId, platform: PLATFORM, status: "CONNECTED" },
    { $set: { status: "DISCONNECTED", lastError: clip(message) }, $unset: { grantTokenEncrypted: "" } },
  ).lean();
  if (!flipped) return;
  // The same entry `refresh` and `syncNow` write for the same fact. A record
  // that only said "a push failed" would leave the next person guessing why
  // the school is suddenly disconnected.
  await ActivityService.record({
    institutionId,
    entityType: "PLATFORM_CONNECTION",
    entityRef: PLATFORM,
    action: "Connection revoked remotely",
    description: clip(message),
    performedBy: actor.id,
    performedByName: actor.name,
  });
}

/**
 * Runs one adapter call and sorts what comes back out of it into three kinds.
 *
 * `ConnectorAuthError` **disconnects the connection and is then rethrown** —
 * this is H3, and the docblock this replaces asserted the opposite. It used
 * to say the error "passes through untouched ... because the connection
 * service's existing handler discriminates it". That handler exists in
 * `syncNow` and `refresh` and is reached from neither of this service's three
 * other entry points: on publish it reached `handleApiError` and the school
 * saw "Something went wrong. Please try again."; on an edit `pushEdit`'s
 * catch-all swallowed it into `blockedReason`; on a delete it became a
 * truthful refusal that still disconnected nothing. In all three the row kept
 * `status: "CONNECTED"` and a ciphertext eduFleet had already refused, so
 * the card still read Connected and nothing told the school to reconnect. The
 * comment was not merely wrong, it was the reason nobody added a handler.
 *
 * It is still RETHROWN, unchanged, and that is load-bearing: `syncNow` is the
 * reconciler's only revocation detector, and it discriminates this exact type
 * to carry out the steps the sweep had already accumulated. Converting it
 * here would retire that path silently. The three non-sync callers translate
 * it themselves into wording their own surface can act on.
 *
 * This is only ever a GRANT revocation. `classifyJobPush` raises
 * `ConnectorAuthError` on a `401 revoked` only when the credential sent was
 * the school's grant; a revoked platform key takes the plain-`Error` path
 * precisely so it can never touch a school's connection status.
 *
 * `AppError` passes through untouched — it is a refusal this service raised.
 *
 * `ConnectorRejectedError` — a 400 — becomes a VALIDATION_ERROR carrying
 * eduFleet's own words, deliberately NOT the 502 below. The 502 says "try
 * again shortly", which is true of an outage and false of a 400: the same
 * body will be refused identically, and `spendWrite` takes another daily unit
 * for each attempt. Copy that invites a retry on a deterministic refusal is
 * how a school's whole day disappears.
 *
 * Everything else really is a transport or server failure, and gets the 502.
 */
async function callAdapter(
  institutionId: string,
  actor: Actor,
  run: () => Promise<JobPushResult>,
): Promise<JobPushResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConnectorAuthError) {
      await disconnectRevokedGrant(institutionId, error.message, actor);
      throw error;
    }
    if (error instanceof AppError) throw error;
    // M4. A spent daily cap gets its own answer, and a 429 rather than the
    // 502 below: nothing is wrong with eduFleet, so "could not be reached"
    // is false, and nothing changes by retrying, so "try again shortly" is
    // the one instruction that cannot work. The adapter has already worded
    // WHICH budget — the school's own grant, or the platform-wide pool — and
    // when it resets, because only it knows which credential was sent.
    if (error instanceof ConnectorCapExceededError) {
      throw new AppError("RATE_LIMITED", error.message);
    }
    if (error instanceof ConnectorRejectedError) {
      const said = error.detail ?? error.reason;
      throw validationError(
        said
          ? `${LABEL} refused this vacancy: ${clip(said)}. Publishing it again unchanged will be refused again.`
          : `${LABEL} refused this vacancy. Publishing it again unchanged will be refused again.`,
      );
    }
    throw upstreamError();
  }
}

type JobAdapter = PlatformAdapter &
  Required<Pick<PlatformAdapter, "createJob" | "patchJob" | "closeJob">>;

/** The registry lookup, with the optional job methods proven present once
 *  rather than asserted at each of the three call sites. */
function jobAdapter(): JobAdapter {
  let adapter: PlatformAdapter;
  try {
    adapter = adapterFor(PLATFORM);
  } catch {
    throw validationError(`${LABEL} integration is not available yet`);
  }
  if (!adapter.createJob || !adapter.patchJob || !adapter.closeJob) {
    throw validationError(`${LABEL} does not support publishing vacancies`);
  }
  return adapter as JobAdapter;
}

/**
 * The platform key and base URL, decrypted. 404s (not a 500) when eduFleet
 * has no active credential or the vault is unconfigured — from the caller's
 * side those are indistinguishable from "not set up yet". Mirrors
 * `connection.service.ts`'s `loadAdapterContext`, deliberately duplicated
 * rather than imported: that helper is private, and importing the connection
 * service to reach it would couple two services that Task 7 is about to make
 * point the other way.
 */
async function buildContext(): Promise<AdapterContext> {
  if (!credentialVaultReady()) throw notFound(`${LABEL} is not configured`);
  const credential = await PlatformCredential.findOne({ platform: PLATFORM, active: true })
    .select("+keyEncrypted")
    .lean();
  if (!credential) throw notFound(`${LABEL} is not configured`);
  const baseUrl = credential.baseUrl;
  return {
    baseUrl,
    platformKey: decryptCredential((credential as PlatformCredentialDoc).keyEncrypted),
    http: createConnectorHttp(baseUrl),
  };
}

// ---------------------------------------------------------------------------
// Loading the three rows this service reads
// ---------------------------------------------------------------------------

/** TENANT-SENSITIVE: `institutionId` is what makes a vacancy id an
 *  authorisation rather than a guess. Never relax this to `findById`. */
async function loadVacancy(institutionId: string, vacancyId: string): Promise<VacancyDoc> {
  const row = await Vacancy.findOne({
    _id: toObjectId(vacancyId),
    institutionId,
  }).lean<VacancyDoc>();
  if (!row) throw notFound("Vacancy not found");
  return row;
}

async function loadInstitution(institutionId: string) {
  const row = await Institution.findOne({ institutionId }).lean();
  if (!row) throw notFound("Institution not found");
  return row;
}

/**
 * Rule 2 — the city gate, at publish.
 *
 * NOT the connect-time gate at `connection.service.ts:320`: that one blocks
 * *connecting*, and a school that never connects still publishes through
 * Contract One, so nothing on that path has ever asked for a city. Both
 * contracts need one — Contract One requires `city` outright, and Contract
 * Two's `createJob` defaults `location` to `""` with no fallback to the
 * school's own eduFleet record before throwing "Job needs a location or
 * branch" (`jobs.ts:38,59`) — and because `spendWrite` runs first, finding
 * that out remotely costs a write unit every time.
 *
 * `preflight` also refuses a locationless push, deliberately: this gate is
 * about the *wording*. It names the one field and where to fix it, which is
 * what a school admin can act on, so it runs first and its exact message is
 * what surfaces.
 */
function assertCity(city: string | null | undefined): void {
  if (!city?.trim()) {
    throw validationError("Add a city to the institution profile before publishing to eduFleet Exchange");
  }
}

// ---------------------------------------------------------------------------
// Contract selection (rule 1)
// ---------------------------------------------------------------------------

type PushTarget = { contract: VacancyListingContract; connection: ConnectionState };

/**
 * Rule 1 — which contract this push uses.
 *
 * A `CONNECTED` eduFleet connection **holding a grant** means Contract Two:
 * the school posts as itself and already owns the result. Anything else —
 * no row, a row still awaiting approval, or a `CONNECTED` row whose
 * ciphertext is gone — means Contract One under the platform key, which
 * produces an `aggregated` listing the school may later claim. Both halves
 * are checked: a `CONNECTED` row with no grant would otherwise send a
 * Contract Two request with no credential at all.
 *
 * `pinned` is the contract an existing listing was created under, and it
 * **wins over this selection**. eduFleet fixes a job's `origin` at creation
 * and the two contracts address and authorise it differently — Contract One
 * PATCHes by `externalJobId` under the platform key and filters
 * `origin: "aggregated"`, Contract Two PATCHes by eduFleet's own `_id` under
 * the grant. Re-selecting on today's connection state would send a school's
 * existing listing to the endpoint that cannot see it: a 404 at best, and at
 * worst a create that 409s and burns a unit. So selection governs the FIRST
 * push only; every later one follows the listing.
 *
 * The one case that leaves is a school that published under its own grant and
 * has since disconnected. Its listing can only be reached with a grant IDAP
 * no longer holds, so this refuses in words that name the fix instead of
 * letting the adapter throw "requires a grant token" into a 502.
 */
async function resolveTarget(
  institutionId: string,
  pinned?: VacancyListingContract,
): Promise<PushTarget> {
  // TENANT-SENSITIVE: a neighbouring school's grant must never decide, or
  // authorise, this institution's push.
  const row = await PlatformConnection.findOne({ institutionId, platform: PLATFORM })
    .select("+grantTokenEncrypted")
    .lean();

  const grantToken =
    row?.status === "CONNECTED" && row.grantTokenEncrypted
      ? decryptCredential(row.grantTokenEncrypted)
      : undefined;

  const connection: ConnectionState = {
    institutionId,
    externalRef: row?.externalRef ?? institutionId,
    remoteRequestId: row?.remoteRequestId ?? undefined,
    grantToken,
    scopes: row?.scopes ?? undefined,
  };

  const contract: VacancyListingContract = pinned ?? (grantToken ? "SCHOOL_POSTED" : "AGGREGATED");
  if (contract === "SCHOOL_POSTED" && !grantToken) {
    throw validationError(
      `This listing was published from your own ${LABEL} account — reconnect to ${LABEL} to update or close it`,
    );
  }

  return { contract, connection };
}

// ---------------------------------------------------------------------------
// Mapping-module inputs
// ---------------------------------------------------------------------------

/**
 * `externalJobId` is passed in rather than taken from the vacancy: it is the
 * vacancy id only for a vacancy's FIRST listing. `VacancyPushInput.vacancyId`
 * is the field Task 2's builders emit as `externalJobId`, so this is the one
 * place the id being pushed under is chosen.
 */
function toVacancyInput(vacancy: VacancyDoc, externalJobId: string): VacancyPushInput {
  return {
    vacancyId: externalJobId,
    title: vacancy.title,
    subject: vacancy.subject,
    description: vacancy.description,
    salaryMin: vacancy.salaryMin ?? undefined,
    salaryMax: vacancy.salaryMax ?? undefined,
    experienceRequired: vacancy.experienceRequired ?? undefined,
    // M2. `?? undefined`, NOT `?.length ? … : undefined`. An empty array and
    // an absent one are different facts and the wire treats them differently:
    // `[]` is "the school removed every benefit", which eduFleet CAN apply
    // (`sanitizeFacilities([])` returns `[]` on both PATCH routes), while
    // absent is "IDAP has nothing to say", which leaves eduFleet's copy
    // alone. Collapsing the two was why unticking every benefit spent a write
    // unit, changed nothing on the public advert, and warned nobody.
    facilities: vacancy.facilities ?? undefined,
  };
}

/**
 * `district` is passed through **raw**, exactly as the school typed it, and
 * that is required rather than lazy: `buildAggregatedJobBody` is what
 * resolves it against eduFleet's 31 keys, and it can only name the value in
 * its warning if it sees the original. Pre-cleaning it here would put the
 * same decision in two places, which is how the two spellings of a rule
 * drift apart.
 *
 * `state` needs no such care — eduFleet never validates it, it only reads it
 * to decide whether the district check applies at all.
 */
function toInstitutionInput(institution: {
  institutionName: string;
  city?: string | null;
  district?: string | null;
  state?: string | null;
}): InstitutionPushInput {
  return {
    institutionName: institution.institutionName,
    city: institution.city ?? undefined,
    district: institution.district ?? undefined,
    state: institution.state ?? undefined,
    // `branchId` is left undefined on purpose: IDAP has no source for an
    // eduFleet branch id, and inventing one from any other field would 400
    // with "Selected branch not found" after spending a write unit.
  };
}

/**
 * Rule 3 — the quota shield.
 *
 * Every reason `preflight` returns is a `400` that would otherwise have cost
 * a write unit, since `spendWrite` runs before eduFleet validates. All of
 * them come back at once (the whole punch list, not one round trip per fixed
 * field) and NOTHING is sent: this throws before `buildContext` has even
 * decrypted a credential.
 */
function refuse(reasons: string[]): void {
  if (reasons.length === 0) return;
  throw validationError(
    reasons.length === 1
      ? reasons[0]
      : `This vacancy cannot be published to ${LABEL} yet — ${reasons.length} things need fixing`,
    reasons,
  );
}

function assertPreflight(
  vacancy: VacancyPushInput,
  institution: InstitutionPushInput,
  contract: VacancyListingContract,
): void {
  refuse(preflight(vacancy, institution, contract));
}

/**
 * The same shield over an update, which refuses a different set because a
 * PATCH sends a different body — see `preflightPatch`. The extra input is
 * what eduFleet already holds: it validates the merged record, so the bounds
 * IDAP is NOT sending are as capable of causing a 400 as the ones it is.
 */
function assertPreflightPatch(vacancy: VacancyPushInput, remote: RemoteJobSalary): void {
  refuse(preflightPatch(vacancy, remote));
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * The only fields either contract's PATCH actually applies
 * (`PartnerJobPatch`, `SchoolJobPatch`). Everything else in a create body —
 * `externalJobId`, `subject`, `institutionName`, `city`, `state`
 * — is read by neither update path and would be silently ignored, which is
 * the one failure mode this plan keeps refusing to ship: a school edits a
 * field, sees "saved", and eduFleet never hears about it.
 *
 * `status` is absent by construction. `patchJob` throws on a body carrying
 * one, because Contract Two's PATCH short-circuits the instant `status` is
 * present and silently discards every other field while returning a 200 that
 * echoes the PRE-patch values. Closing goes through `closeJob` alone.
 *
 * Two limits worth stating rather than discovering: a `subject` change never
 * reaches eduFleet (neither PATCH route accepts one — the listing must be
 * closed and re-published to change it), and clearing a salary bound in IDAP
 * leaves eduFleet's copy as it was, since the mapping module omits absent
 * keys and eduFleet reads `undefined` as "not mentioned".
 *
 * `facilities` is deliberately NOT a third such limit, and the difference is
 * worth naming because it looks like one. The salary bounds and
 * `experienceRequired` are unclearable because eduFleet's patch types declare
 * `number`, never `null`, and both routes gate on `!== undefined` — there is
 * no value that means "remove". Facilities is an array, and `[]` IS that
 * value: both routes run `sanitizeFacilities(patch.facilities)`, which
 * returns `[]` for `[]`, so eduFleet really does clear them. IDAP used to be
 * unable to say it, which was IDAP's limitation rather than eduFleet's;
 * `toVacancyInput` and the mapping module's own `sanitizeFacilities` now
 * carry an empty array through instead of collapsing it to absent.
 */
/**
 * Exported so `vacancy.service.ts` can decide whether an edit is worth pushing
 * at all WITHOUT keeping a second copy of this list. A duplicate that drifted
 * would fail in one of two silent ways: a key added here but not there means
 * an edit eduFleet would have accepted never gets sent, and a key added there
 * but not here means a write unit spent on a body that changes nothing.
 */
export const EDUFLEET_PATCHABLE_KEYS = [
  "title",
  "description",
  "salaryMin",
  "salaryMax",
  "experienceRequired",
  "facilities",
] as const;

function toPatchBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of EDUFLEET_PATCHABLE_KEYS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

/**
 * How each contract addresses an existing job — the two are opposites, and
 * getting it backwards is a silent 404 against a listing that is very much
 * alive. Contract One's `updatePartnerJob` looks the job up by
 * `partnerExternalJobId`; Contract Two's `updateSchoolJob` looks it up by
 * `_id`, which is the `jobId` eduFleet returned when it created the job.
 *
 * Both halves are read from the stored listing, never rebuilt. The external
 * id used to be derivable — it was the vacancy id — and stops being so the
 * first time a closed listing is republished under a fresh one; deriving it
 * after that would address the school's PREVIOUS, closed advert.
 */
/**
 * One definition of "eduFleet is still showing this advert to teachers", used
 * by every caller that has to decide between pushing, closing and refusing.
 *
 * A type predicate rather than a plain boolean so the narrowing survives the
 * `const live = …` alias in `pushFields` — the alternative was this same
 * condition written twice, and "is the listing live?" is exactly the kind of
 * rule that must not be able to drift between two spellings.
 */
function isListingLive(
  listing: VacancyDoc["listing"] | undefined,
): listing is NonNullable<VacancyDoc["listing"]> {
  return listing !== undefined && listing !== null && listing.remoteStatus !== "closed";
}

function addressOf(listing: {
  jobId: string;
  externalJobId: string;
  contract: VacancyListingContract;
}): string {
  return listing.contract === "SCHOOL_POSTED" ? listing.jobId : listing.externalJobId;
}

/**
 * The `externalJobId` for the next listing this vacancy gets.
 *
 * The first is the vacancy id itself, which keeps the common case
 * recognisable on both sides. Every later one is suffixed, because eduFleet
 * never releases the id: a closed job still matches the dedupe pre-check
 * (`partner-jobs.ts:126`, `partner-school-jobs.ts:67`) and still occupies the
 * unique index (`models/Job.ts:82-91`), neither of which filters on status,
 * so reusing it would 409 — burning a write unit to be told what IDAP could
 * have known locally.
 *
 * The suffix is safe to send as-is: `partnerExternalJobId` is declared
 * `{type: String, trim: true}` with no `maxlength`, `match` or enum, neither
 * create path validates it beyond a non-empty trim, and the published
 * contract types it as a bare string. `-2` adds only ASCII digits and a
 * hyphen, which also survive Contract One's URL path segment
 * (`/api/partner/jobs/{externalJobId}`) untouched.
 */
function nextExternalJobId(vacancyId: string, previous: string | undefined): string {
  if (!previous) return vacancyId;
  const suffixed = new RegExp(`^${vacancyId}-(\\d+)$`).exec(previous);
  if (suffixed) return `${vacancyId}-${Number(suffixed[1]) + 1}`;
  // `previous` is always an id this function minted, so the only remaining
  // case is the first republish (`previous === vacancyId`). Anything else
  // would still get a strictly different id rather than a guaranteed clash.
  return previous === vacancyId ? `${vacancyId}-2` : `${previous}-2`;
}

// ---------------------------------------------------------------------------
// Recording the answer
// ---------------------------------------------------------------------------

const KNOWN_CLAIM_STATES = new Set<string>(VACANCY_CLAIM_STATES);

/**
 * `VACANCY_CLAIM_STATES` now mirrors eduFleet's `CLAIM_STATUSES` in full,
 * `withdrawn` included — the free list read behind a `403 claimed`
 * (`edufleet.ts`'s `resolveClaimState`) reports all four, and dropping one
 * would turn "eduFleet took this advert down" into "state unknown".
 *
 * The guard itself stays for the reason it was written: storing a value
 * outside the enum verbatim would fail the model's own validation on save —
 * AFTER the job went live, leaving a public advert IDAP recorded no id for.
 * An unrecognised value is dropped instead, which every reader treats as
 * "unknown", never as "unclaimed".
 */
function toClaimState(value: string | undefined): VacancyClaimState | undefined {
  return value !== undefined && KNOWN_CLAIM_STATES.has(value)
    ? (value as VacancyClaimState)
    : undefined;
}

/**
 * Exported for `vacancy.service.ts`'s `serialize`, so the listing a school
 * sees on its dashboard is built by the same function as the one a push
 * returns — one shape, not two that drift. The dependency runs
 * `vacancy.service → vacancy-publish.service` only, which is the direction
 * that already exists (Task 5's `remove` calls `pushClose`); this file still
 * imports nothing back.
 *
 * `?? undefined` on the numbers, never `||`: a stored bound of `0` is a real
 * figure eduFleet holds and must not read as "no bound".
 */
export function toListingDTO(listing: NonNullable<VacancyDoc["listing"]>): VacancyListingDTO {
  return {
    jobId: listing.jobId,
    externalJobId: listing.externalJobId,
    contract: listing.contract as VacancyListingContract,
    lastPushedAt: listing.lastPushedAt.toISOString(),
    remoteStatus: (listing.remoteStatus as VacancyListingRemoteStatus | undefined) ?? "active",
    claimState: (listing.claimState as VacancyClaimState | undefined) ?? undefined,
    blockedReason: listing.blockedReason ?? undefined,
    publicUrl: listing.publicUrl ?? undefined,
    remoteSalaryMin: listing.remoteSalaryMin ?? undefined,
    remoteSalaryMax: listing.remoteSalaryMax ?? undefined,
    remoteExperienceRequired: listing.remoteExperienceRequired ?? undefined,
  };
}

/** What eduFleet holds for a listing, for `preflightPatch` to merge against. */
function remoteSalaryOf(listing: NonNullable<VacancyDoc["listing"]>): RemoteJobSalary {
  return {
    salaryMin: listing.remoteSalaryMin ?? undefined,
    salaryMax: listing.remoteSalaryMax ?? undefined,
  };
}

/**
 * eduFleet's `403` reasons, in words a school admin can act on (spec §9).
 *
 * The single reason `claimed` covers FOUR states on Contract One's PATCH
 * (`claimed`, `claim_pending`, `withdrawn`, `hiddenPendingReview`) with two
 * different futures, so the reason alone can only be worded vaguely — which
 * is what the last arm below still does, honestly, when nothing better is
 * known. When the adapter's free list read established the actual claim
 * state, `claimState` is passed and the wording says the true thing instead:
 * whether this is over, and whose it is now.
 *
 * `upgrade_required` clears the moment the school frees a slot or upgrades;
 * `hiddenPendingReview` reverses when a takedown request is rejected. Neither
 * is terminal and neither may be worded as if it were.
 */
function blockedMessage(reason: string, claimState?: VacancyClaimState): string {
  switch (reason) {
    case "claimed":
      switch (claimState) {
        case "claimed":
          return `Your school has claimed this advert on ${LABEL}, so it belongs to your ${LABEL} account now — IDAP can no longer change or close it. Edit or close it there.`;
        case "withdrawn":
          return `${LABEL} has taken this advert down, so IDAP can no longer change or close it. Take it up on ${LABEL} if that was not expected.`;
        case "claim_pending":
          return `A claim on this advert is awaiting review on ${LABEL}, so it will not accept changes until that is decided. If the claim is rejected the advert comes back under IDAP's control and the next sync will bring it into step.`;
        default:
          return `${LABEL} will not accept changes to this listing right now — the school has claimed it, or a claim or takedown is awaiting review there. Manage it on ${LABEL}, or try again once that clears.`;
      }
    case "not_found":
      return `${LABEL} no longer has this advert, so IDAP cannot update or close it. Nothing is live over there any more — publish this vacancy again to create a new advert, or delete it here.`;
    case "upgrade_required":
      return `Your ${LABEL} plan has no room for another live listing — close one there or upgrade the plan, then try again.`;
    case "insufficient_scope":
      return `Your ${LABEL} connection does not allow IDAP to post jobs — reconnect to ${LABEL} to grant it.`;
    case "school_unavailable":
      return `${LABEL} is not accepting posts for your school right now — check the school's account there.`;
    default:
      return `${LABEL} refused this push (${clip(reason)}).`;
  }
}

/** eduFleet reports ownership as `"platform"`/`"school"` (`PartnerJobError`),
 *  which are its names for IDAP's `AGGREGATED`/`SCHOOL_POSTED`. */
function toContract(remote: string): VacancyListingContract | undefined {
  if (remote === "platform") return "AGGREGATED";
  if (remote === "school") return "SCHOOL_POSTED";
  return undefined;
}

/**
 * Rule 6 — a `409 duplicate_external_job` names the contract that owns the
 * row, and IDAP trusts that over its own assumption. `externalJobId`
 * uniqueness is `(partnerId, externalJobId)` and shared across both
 * contracts, so the collision can belong to the endpoint IDAP did NOT just
 * call — retrying against the "obvious" one would 404, and the 409 has
 * already spent a write unit either way.
 */
function conflictMessage(ownedByContract: string): string {
  switch (toContract(ownedByContract)) {
    case "AGGREGATED":
      return `This vacancy is already on ${LABEL} as a listing IDAP published with its platform key — claim it on ${LABEL} rather than publishing it again.`;
    case "SCHOOL_POSTED":
      return `This vacancy is already on ${LABEL} under your school's own account — manage it there rather than publishing it again.`;
    default:
      return `This vacancy is already on ${LABEL} under another partner contract (${clip(ownedByContract)}) — manage it there rather than publishing it again.`;
  }
}

async function record(
  institutionId: string,
  vacancy: VacancyDoc,
  action: string,
  description: string,
  actor: Actor,
): Promise<void> {
  await ActivityService.record({
    institutionId,
    entityType: "VACANCY",
    entityId: vacancy._id,
    entityRef: institutionId,
    action,
    description,
    performedBy: actor.id,
    performedByName: actor.name,
  });
}

/**
 * Rule 5 — a `403`, and rule 6's `409`, are RECORDED, never latched.
 *
 * `listing.blockedReason` is the only field written; `jobId`, `contract`,
 * `claimState` and `lastPushedAt` are all left exactly as they were, so the
 * next push still knows what it is pushing to and can simply succeed. Two of
 * eduFleet's four `403` triggers reverse without IDAP doing anything, so a
 * listing that "failed once" must stay a live, retryable listing.
 *
 * A refusal on a *create* has no listing to write to, and this deliberately
 * does not invent one: the block requires a `jobId` eduFleet never issued,
 * and a fabricated one would show the school a "published" vacancy pointing
 * at nothing. The reason still reaches the caller, in the returned outcome.
 */
async function recordBlockedReason(
  institutionId: string,
  vacancy: VacancyDoc,
  message: string,
  claimState?: VacancyClaimState,
  /**
   * L2. Set to `"closed"` on a `404`, and only there. eduFleet does not have
   * this job under this partner, so from IDAP's side the advert is not live —
   * and recording that is what stops the reconciler repushing a listing that
   * will 404 again on every sync, one unit each. It also puts the school back
   * in control: a closed listing is republished as a NEW one, and `remove`
   * can delete the row without a close it can never make.
   */
  remoteStatus?: VacancyListingRemoteStatus,
): Promise<VacancyListingDTO | undefined> {
  if (!vacancy.listing) return undefined;
  const updated = await Vacancy.findOneAndUpdate(
    { _id: vacancy._id, institutionId },
    {
      $set: {
        "listing.blockedReason": message,
        ...(remoteStatus ? { "listing.remoteStatus": remoteStatus } : {}),
        // The one field a `403` may write besides the reason, and only when
        // the adapter actually established it. This is what makes the three
        // claimed-listing behaviours reachable at all: the delete's
        // close-first exception, the reconciler's skip and the card's
        // read-only state all read `claimState`, and before this the only
        // thing that could ever write it was a SUCCESS body — which never
        // carries one. Absent claimState leaves whatever is stored alone
        // rather than writing "unknown" over a state already established.
        ...(claimState ? { "listing.claimState": claimState } : {}),
      },
    },
    { new: true },
  ).lean<VacancyDoc>();
  return updated?.listing ? toListingDTO(updated.listing) : undefined;
}

/**
 * Records why an edit's push never landed, in the same field a `403` uses and
 * for the same reason: it is "why this listing is currently out of step with
 * IDAP", and the next successful push clears it (`recordSuccess` `$unset`s it
 * unconditionally). Without this, a school edits a title, IDAP saves it, the
 * PATCH is refused — and nothing anywhere says so.
 *
 * Two guards, both load-bearing:
 *
 * - `listing: { $exists: true }` — `updateOne` runs no validators, so a bare
 *   `$set` on `listing.blockedReason` against a vacancy with no listing would
 *   CREATE a listing sub-document holding nothing but a reason: no `jobId`, no
 *   `externalJobId`, and therefore a vacancy that reads as "published" in the
 *   DTO and on the card while pointing at nothing. Same rule as
 *   `recordBlockedReason`, which refuses to invent a block for the same reason.
 * - `institutionId` — TENANT-SENSITIVE, exactly like every other write here.
 */
async function recordPushFailure(
  institutionId: string,
  vacancyId: string,
  message: string,
): Promise<void> {
  await Vacancy.updateOne(
    { _id: toObjectId(vacancyId), institutionId, listing: { $exists: true } },
    { $set: { "listing.blockedReason": clip(message) } },
  );
}

/**
 * Everything one successful push needs to leave behind. Assembled by the
 * caller that made the push, because only it knows which shape it sent.
 */
type PushShape = {
  kind: "PUSHED" | "CLOSED";
  contract: VacancyListingContract;
  /** The id this push was made under — a fresh one whenever `create`. */
  externalJobId: string;
  /** True when this replaced (or first created) the listing block. */
  create: boolean;
  /**
   * The three "changeable but not clearable" fields as eduFleet holds them
   * AFTER this push. Absent on a close, which changes none of them and must
   * not overwrite what is recorded.
   *
   * Wider than `RemoteJobSalary` on purpose: `preflightPatch` needs only the
   * bounds (they are the pair eduFleet cross-validates), but the school's
   * dashboard needs the experience figure too, to name the number their public
   * advert will keep showing when they clear it here. Structurally assignable
   * to `RemoteJobSalary`, so `preflightPatch` keeps taking exactly what it
   * needs and nothing more.
   */
  remote?: RemoteJobSalary & { experienceRequired?: number };
};

/** A successful push: the listing block is created (on a create) or refreshed
 *  (on a patch/close), and any recorded block is cleared — the push that just
 *  worked is proof the refusal is over. */
async function recordSuccess(
  institutionId: string,
  vacancy: VacancyDoc,
  shape: PushShape,
  result: Extract<JobPushResult, { kind: "OK" }>,
): Promise<VacancyListingDTO> {
  const now = new Date();
  const claimState = toClaimState(result.claimState);
  const remoteStatus: VacancyListingRemoteStatus = shape.kind === "CLOSED" ? "closed" : "active";

  // A create replaces the whole sub-document — including on a republish, where
  // the previous block described a different, now-closed advert and keeping
  // any of it would mean pointing at both. A patch/close touches only the
  // fields it actually learned about. `$set` on `listing` and `$unset` on
  // `listing.blockedReason` are conflicting paths in one update, so the two
  // shapes stay separate rather than being merged.
  const update = shape.create
    ? {
        $set: {
          listing: {
            jobId: result.jobId,
            externalJobId: shape.externalJobId,
            contract: shape.contract,
            lastPushedAt: now,
            remoteStatus,
            claimState: claimState ?? "unclaimed",
            // Only a create ever carries one, which is exactly why it is
            // recorded here and nowhere else: the patch branch below touches
            // named paths only, so the URL minted with the listing survives
            // every later push untouched. A create that somehow answered
            // without one leaves the field absent rather than stale — this
            // branch replaces the whole sub-document, so there is no previous
            // URL to carry over, and any there was described a different,
            // now-closed advert.
            publicUrl: result.publicUrl,
            remoteSalaryMin: shape.remote?.salaryMin,
            remoteSalaryMax: shape.remote?.salaryMax,
            remoteExperienceRequired: shape.remote?.experienceRequired,
          },
        },
      }
    : {
        $set: {
          "listing.lastPushedAt": now,
          "listing.remoteStatus": remoteStatus,
          ...(claimState ? { "listing.claimState": claimState } : {}),
          // Only the values eduFleet now holds; the absent ones are `$unset`
          // below rather than written as null, so "eduFleet has no maximum"
          // and "IDAP never asked" stay the same absent state.
          ...(shape.remote?.salaryMin !== undefined
            ? { "listing.remoteSalaryMin": shape.remote.salaryMin }
            : {}),
          ...(shape.remote?.salaryMax !== undefined
            ? { "listing.remoteSalaryMax": shape.remote.salaryMax }
            : {}),
          ...(shape.remote?.experienceRequired !== undefined
            ? { "listing.remoteExperienceRequired": shape.remote.experienceRequired }
            : {}),
        },
        $unset: {
          "listing.blockedReason": "",
          ...(shape.remote && shape.remote.salaryMin === undefined
            ? { "listing.remoteSalaryMin": "" }
            : {}),
          ...(shape.remote && shape.remote.salaryMax === undefined
            ? { "listing.remoteSalaryMax": "" }
            : {}),
          ...(shape.remote && shape.remote.experienceRequired === undefined
            ? { "listing.remoteExperienceRequired": "" }
            : {}),
        },
      };

  const updated = await Vacancy.findOneAndUpdate({ _id: vacancy._id, institutionId }, update, {
    new: true,
  }).lean<VacancyDoc>();
  /* c8 ignore next */
  if (!updated?.listing) throw notFound("Vacancy not found");
  return toListingDTO(updated.listing);
}

/**
 * Rule 6, second half — a `409` hands back the id of the job that already
 * holds this `externalJobId`, and IDAP adopts it when it has nowhere else
 * recorded.
 *
 * This is not a fabricated listing: every field comes from the wire (the
 * existing job's `jobId` and the contract eduFleet says owns it) or from the
 * id this push was made under. It matters because the collision IS the
 * recovery path. A create that succeeded remotely and then lost its local
 * write leaves a live, public advert with no listing block — and from there
 * `pushClose` would answer `NOT_LISTED` with no HTTP call, which Task 5 reads
 * as "safe to delete". The vacancy would go, the advert would stay up, and
 * the only id that could ever have closed it was on this 409.
 *
 * `remoteStatus` is recorded as `active` because that is the state that
 * keeps the advert addressable, and it is what a duplicate almost always is;
 * if the existing job turns out to be closed, the close pushed against it is
 * a harmless second `status: "closed"` (`jobs.ts:closeJob` assigns and saves
 * unconditionally), which is the right way round for a guess to be wrong.
 */
async function adoptConflict(
  institutionId: string,
  vacancy: VacancyDoc,
  externalJobId: string,
  result: Extract<JobPushResult, { kind: "CONFLICT" }>,
  message: string,
): Promise<VacancyListingDTO | undefined> {
  const contract = toContract(result.ownedByContract);
  // No id, or a contract IDAP has no name for, means nothing addressable to
  // record — and a listing block that cannot be addressed is worse than none,
  // since it would read as "published" everywhere it is shown.
  if (!result.jobId || !contract) return undefined;

  const updated = await Vacancy.findOneAndUpdate(
    { _id: vacancy._id, institutionId },
    {
      $set: {
        listing: {
          jobId: result.jobId,
          externalJobId,
          contract,
          lastPushedAt: new Date(),
          remoteStatus: "active",
          blockedReason: message,
        },
      },
    },
    { new: true },
  ).lean<VacancyDoc>();
  return updated?.listing ? toListingDTO(updated.listing) : undefined;
}

/** Turns one classified answer into an outcome, and records it. */
async function settle(
  institutionId: string,
  vacancy: VacancyDoc,
  shape: PushShape,
  result: JobPushResult,
  actor: Actor,
): Promise<VacancyPublishOutcome> {
  if (result.kind === "OK") {
    const listing = await recordSuccess(institutionId, vacancy, shape, result);
    await record(
      institutionId,
      vacancy,
      shape.kind === "CLOSED" ? "Vacancy closed on eduFleet" : "Vacancy published to eduFleet",
      `${vacancy.title} — ${LABEL} job ${listing.jobId}`,
      actor,
    );
    return shape.kind === "CLOSED" ? { status: "CLOSED", listing } : { status: "PUSHED", listing };
  }

  if (result.kind === "BLOCKED") {
    const claimState = toClaimState(result.claimState);
    const message = blockedMessage(result.reason, claimState);
    const listing = await recordBlockedReason(
      institutionId,
      vacancy,
      message,
      claimState,
      // L2: the one BLOCKED reason that also settles what eduFleet is showing.
      result.reason === "not_found" ? "closed" : undefined,
    );
    await record(institutionId, vacancy, "eduFleet push blocked", `${vacancy.title} — ${result.detail}`, actor);
    return { status: "BLOCKED", message, listing };
  }

  const message = conflictMessage(result.ownedByContract);
  // An existing listing keeps its own identity and only records the reason;
  // a vacancy with none adopts the id the 409 just handed back.
  const listing = vacancy.listing
    ? await recordBlockedReason(institutionId, vacancy, message)
    : await adoptConflict(institutionId, vacancy, shape.externalJobId, result, message);
  await record(institutionId, vacancy, "eduFleet push conflicted", `${vacancy.title} — ${result.detail}`, actor);
  return {
    status: "CONFLICT",
    message,
    ownedByContract: toContract(result.ownedByContract),
    listing,
  };
}

// ---------------------------------------------------------------------------
// The two pushes
// ---------------------------------------------------------------------------

/**
 * Create or update the listing for one vacancy.
 *
 * Which of the two it is turns on whether the advert eduFleet holds is still
 * live, not merely on whether a listing block exists. A listing whose
 * `remoteStatus` is `closed` points at a job no teacher can see and no
 * partner contract can revive — Contract Two's PATCH accepts only `"closed"`,
 * and `patchJob` refuses a `status` key on both contracts by design. PATCHing
 * fields onto it would get a cheerful 200 back and put IDAP in the worst
 * available state: a vacancy that reports "published" over an advert that is
 * dead. So a closed listing is republished as a NEW one, which is the spec's
 * own decision (§7: reopening creates a new listing rather than reviving the
 * old one) and the only thing eduFleet actually offers.
 *
 * `allowCreate` is false for `repush`: an edit must never be what first puts
 * a vacancy on a public jobs board, nor what puts it back on one (spec §10 —
 * a vacancy is pushed only by an explicit school action).
 */
async function pushFields(
  institutionId: string,
  vacancy: VacancyDoc,
  actor: Actor,
  allowCreate: boolean,
): Promise<VacancyPublishOutcome> {
  const listing = vacancy.listing ?? undefined;
  const live = isListingLive(listing);

  if (!live && !allowCreate) {
    throw validationError(
      listing
        ? `This listing was closed on ${LABEL} — publish this vacancy again to create a new one`
        : `Publish this vacancy to ${LABEL} before updating its listing`,
    );
  }

  const institution = await loadInstitution(institutionId);

  const { contract, connection } = await resolveTarget(
    institutionId,
    live ? (listing.contract as VacancyListingContract) : undefined,
  );

  // The two shapes diverge here, and every difference below follows from one
  // fact: a create sends the whole record, an update sends six fields.
  // `vacancy.listing` rather than the narrowed `listing` on the false branch:
  // `isListingLive` is a type predicate, so `!live` narrows the alias away
  // entirely and the previous id — the one a republish must not reuse — has to
  // be read from the unnarrowed source.
  const externalJobId = live
    ? listing.externalJobId
    : nextExternalJobId(String(vacancy._id), vacancy.listing?.externalJobId);
  const vacancyInput = toVacancyInput(vacancy, externalJobId);
  const institutionInput = toInstitutionInput(institution);

  const { body, warnings } =
    contract === "SCHOOL_POSTED"
      ? buildSchoolJobBody(vacancyInput, institutionInput)
      : buildAggregatedJobBody(vacancyInput, institutionInput);

  if (live) {
    // No city gate and no full preflight on an update. Neither PATCH route
    // reads `city`, `institutionName` or `subject`, so refusing a title or
    // salary edit because one of those is missing would refuse a request that
    // does not contain them — a refusal that prevents no rejection and saves
    // no write unit, while leaving a school unable to correct a typo on a
    // live public advert. The create path below still checks all of it, which
    // is where those fields are actually sent.
    assertPreflightPatch(vacancyInput, remoteSalaryOf(listing)); // rule 3, patch-shaped
  } else {
    assertCity(institution.city); // rule 2 — before anything else can spend a unit
    assertPreflight(vacancyInput, institutionInput, contract); // rule 3 — still no HTTP
  }

  const adapter = jobAdapter();
  const ctx = await buildContext();

  const result = await callAdapter(institutionId, actor, () =>
    live
      ? adapter.patchJob(ctx, connection, addressOf({ ...listing, contract }), toPatchBody(body), contract)
      : adapter.createJob(ctx, connection, body, contract),
  );

  const outcome = await settle(
    institutionId,
    vacancy,
    {
      kind: "PUSHED",
      contract,
      externalJobId,
      create: !live,
      // What eduFleet holds once this lands: on a create, exactly what was
      // sent; on an update, the merge of what was sent over what it already
      // had, since an omitted bound leaves the stored one alone and no value
      // means "clear it" (see `preflightPatch`).
      // `toPatchBody` forwards these two straight from `body`, so reading
      // them here is reading exactly what was sent.
      remote: live
        ? {
            salaryMin: (body.salaryMin as number | undefined) ?? listing.remoteSalaryMin ?? undefined,
            salaryMax: (body.salaryMax as number | undefined) ?? listing.remoteSalaryMax ?? undefined,
            experienceRequired:
              (body.experienceRequired as number | undefined) ??
              listing.remoteExperienceRequired ??
              undefined,
          }
        : {
            salaryMin: body.salaryMin as number | undefined,
            salaryMax: body.salaryMax as number | undefined,
            experienceRequired: body.experienceRequired as number | undefined,
          },
    },
    result,
    actor,
  );

  // A warning is attached to a CREATE that landed, and only there.
  //
  // Not to an update: `toPatchBody` keeps `EDUFLEET_PATCHABLE_KEYS`, and
  // `district` is not one of them because no update route reads it — so on an
  // edit the same sentence would name a field this request never carried,
  // hung off a title change that worked. Not to a `BLOCKED` or a `CONFLICT`
  // either: there is no advert, so "this advert was published without a
  // district" is not yet true, and the message the school must read is the
  // one about the push that did not land.
  return !live && outcome.status === "PUSHED" && warnings.length > 0
    ? { ...outcome, warnings }
    : outcome;
}

/**
 * Close the listing for one vacancy, if it has one.
 *
 * Neither the city gate nor `preflight` runs here, and that is a deliberate
 * reading of rules 2 and 3 rather than an omission. A close sends
 * `{status: "closed"}` and nothing else — it carries none of the fields
 * either check describes, so neither can prevent a single `400` (Contract
 * One re-checks only the values already stored on eduFleet's own copy;
 * Contract Two routes straight to its own `closeJob`). What gating a close on
 * them WOULD do is strand a live public advert on eduFleet the moment a
 * school clears its city — unclosable, and by Task 5 undeletable too. That is
 * the exact harm the close path exists to prevent, so the shield stays on the
 * pushes whose bodies it actually describes.
 */
async function pushCloseFor(
  institutionId: string,
  vacancy: VacancyDoc,
  actor: Actor,
): Promise<VacancyPublishOutcome> {
  // M1: `isListingLive`, not `if (!listing)`. "Nothing to close" is a
  // question about the ADVERT, and a listing whose `remoteStatus` is already
  // `closed` points at one no teacher can see. Sending the close anyway cost
  // two things. A write unit, on the ordinary close-then-delete sequence, to
  // tell eduFleet something it already did. And — worse — an undeletable row:
  // a `SCHOOL_POSTED` listing that is already closed, on a school that has
  // since disconnected, hit `resolveTarget`'s "reconnect to update or close
  // it" throw, which `remove` reads as a failed close and refuses the delete
  // over. There was nothing left to protect; the advert was already down.
  //
  // `NOT_LISTED` is the correct arm rather than a fabricated `CLOSED`: no
  // HTTP call was made and nothing changed, and `remove` already reads it as
  // safe-to-delete for exactly that reason.
  //
  // `isListingLive` is a type predicate, so this both decides and narrows —
  // the same idiom `pushFields` uses, and the reason "is this listing live?"
  // has exactly one spelling in this file.
  const listing = vacancy.listing ?? undefined;
  if (!isListingLive(listing)) return { status: "NOT_LISTED" };

  const contract = listing.contract as VacancyListingContract;
  const { connection } = await resolveTarget(institutionId, contract);

  const adapter = jobAdapter();
  const ctx = await buildContext();

  const result = await callAdapter(institutionId, actor, () =>
    adapter.closeJob(ctx, connection, addressOf({ ...listing, contract }), contract),
  );

  // `create: false` and no `remote`: a close changes none of the three, and
  // writing the pair again from a body that never carried one would erase what
  // eduFleet still holds. `kind: "CLOSED"` is what flips `remoteStatus`, which
  // is what lets a later publish know to mint a new listing.
  return settle(
    institutionId,
    vacancy,
    { kind: "CLOSED", contract, externalJobId: listing.externalJobId, create: false },
    result,
    actor,
  );
}

/**
 * Rule 4's `DRAFT` branch, shared by `publish` and `repush` (fix round 1).
 *
 * The refusal below exists to keep a half-written vacancy off a public jobs
 * board. That is a rule about CREATING an advert, and applying it to a
 * *close* inverts it: a school that moves a published vacancy back to Draft —
 * one click, and the status control offers `DRAFT` for every vacancy
 * unconditionally — would be left with a live public advert and a button that
 * refuses to take it down, telling them to set the vacancy Open, which is the
 * opposite of what they just asked for.
 *
 * So a `DRAFT` vacancy still holding a live listing closes it. That is exactly
 * the reasoning `pushCloseFor` already records for the city gate and
 * `preflight`: gating a close on a rule about pushes "would strand a live
 * public advert on eduFleet ... That is the exact harm the close path exists
 * to prevent." A close carries none of the vacancy's own fields — it sends
 * `{status: "closed"}` and nothing else — so nothing half-written can reach
 * eduFleet through it.
 *
 * With no live listing there is genuinely nothing to do but refuse, and the
 * original wording is right: the only thing a `DRAFT` vacancy can do next is
 * become `OPEN`.
 *
 * Not a way back in, either: closing is one-way on both contracts, and
 * `pushFields`'s `allowCreate` is what governs re-publishing. This branch can
 * only ever take an advert down.
 */
async function draftAction(
  institutionId: string,
  vacancy: VacancyDoc,
  actor: Actor,
): Promise<VacancyPublishOutcome> {
  if (isListingLive(vacancy.listing ?? undefined)) {
    return pushCloseFor(institutionId, vacancy, actor);
  }
  throw validationError(`Set this vacancy to Open before publishing it to ${LABEL}`);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const VacancyPublishService = {
  /**
   * The school's explicit publish action.
   *
   * Rule 4 lives here: `DRAFT` is refused outright (a half-written vacancy
   * must never reach a public jobs board), `OPEN` is created or updated, and
   * `FILLED`/`CLOSED` push a close instead — a vacancy that is no longer
   * hiring must not stay live on eduFleet just because someone pressed the
   * wrong button.
   */
  async publish(institutionId: string, vacancyId: string, actor: Actor): Promise<VacancyPublishOutcome> {
    await connectToDatabase();
    const vacancy = await loadVacancy(institutionId, vacancyId);

    // H3. `callAdapter` has already dropped the dead ciphertext and flipped
    // the connection to DISCONNECTED by the time this catch runs; what is
    // left is telling the school. Untranslated, a `ConnectorAuthError` is not
    // an `AppError`, so `handleApiError` falls through every branch to
    // "Something went wrong. Please try again." — a 500 for the one failure
    // the school can actually fix, on a card still reading Connected.
    // Translated only HERE and not inside `pushFields`, because `repush`
    // shares that path and `syncNow` needs the raw error to reach its own
    // revocation handler.
    try {
      if (vacancy.status === "DRAFT") return await draftAction(institutionId, vacancy, actor);
      if (vacancy.status === "FILLED" || vacancy.status === "CLOSED") {
        return await pushCloseFor(institutionId, vacancy, actor);
      }
      return await pushFields(institutionId, vacancy, actor, true);
    } catch (error) {
      if (error instanceof ConnectorAuthError) throw grantRevokedError();
      throw error;
    }
  },

  /**
   * Push the vacancy's current values to a listing it already has — the hook
   * an edit uses. Identical to `publish` in every respect but one: it never
   * creates. A vacancy the school never chose to publish stays unpublished,
   * whatever is edited on it — and so does one whose listing was closed,
   * since putting that back on a public jobs board is a new publication, not
   * an edit.
   */
  async repush(institutionId: string, vacancyId: string, actor: Actor): Promise<VacancyPublishOutcome> {
    await connectToDatabase();
    const vacancy = await loadVacancy(institutionId, vacancyId);

    if (vacancy.status === "DRAFT") return draftAction(institutionId, vacancy, actor);
    if (vacancy.status === "FILLED" || vacancy.status === "CLOSED") {
      return pushCloseFor(institutionId, vacancy, actor);
    }
    return pushFields(institutionId, vacancy, actor, false);
  },

  /**
   * Spec §7's "**Edit** after publish issues a `PATCH`" — the hook
   * `VacancyService.update` calls once a local edit has been written.
   *
   * It is `repush` with one difference, and the difference is the whole point:
   * **it never throws.** By the time this runs the school's edit is already
   * saved, and the two facts they need are independent — "your change was
   * saved" and "eduFleet was/was not told". Letting a push failure propagate
   * would collapse them into one: the PATCH route would answer 4xx, the
   * dashboard would report the edit as failed, and the school would re-enter a
   * change that is already stored. So every failure is recorded on the listing
   * instead, where it reaches them as `blockedReason` on the card — the same
   * place, and the same wording, a `403` already lands in.
   *
   * `BLOCKED` and `CONFLICT` need nothing here: `settle` has already written
   * their reason to the listing. Only a THROWN refusal — a preflight the merged
   * salary fails, a `SCHOOL_POSTED` listing whose grant is gone, eduFleet
   * unconfigured, a 400, a 502 — arrives with nothing recorded, which is what
   * the catch is for.
   *
   * Deciding WHETHER an edit is worth pushing is deliberately not done here.
   * That needs the patch itself — which fields the school actually touched —
   * and the patch never leaves `vacancy.service.ts`. This method assumes the
   * caller already decided, and `repush`'s own `allowCreate: false` remains the
   * backstop that keeps an edit from ever CREATING a listing.
   */
  async pushEdit(institutionId: string, vacancyId: string, actor: Actor): Promise<void> {
    try {
      await this.repush(institutionId, vacancyId, actor);
    } catch (error) {
      await recordPushFailure(
        institutionId,
        vacancyId,
        // H3. The connection is already disconnected by the time this runs
        // (`callAdapter`), but the raw message — "eduFleet: this school's
        // grant has been revoked" — describes the fault rather than the fix.
        // The card is where the school reads this, so it says what to do.
        error instanceof ConnectorAuthError
          ? GRANT_REVOKED_MESSAGE
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  },

  /**
   * Close this vacancy's listing on eduFleet, whatever its IDAP status.
   * Returns `NOT_LISTED` — with no HTTP call at all — when there is nothing
   * to close, which is how Task 5's `remove` tells "already retracted" apart
   * from "the close was refused".
   */
  async pushClose(institutionId: string, vacancyId: string, actor: Actor): Promise<VacancyPublishOutcome> {
    await connectToDatabase();
    const vacancy = await loadVacancy(institutionId, vacancyId);
    return pushCloseFor(institutionId, vacancy, actor);
  },
};
