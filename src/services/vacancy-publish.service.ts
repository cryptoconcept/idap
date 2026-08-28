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
} from "@/lib/constants";
import { credentialVaultReady, decryptCredential } from "@/lib/security/credentials";
import { adapterFor } from "@/lib/connectors";
import { createConnectorHttp } from "@/lib/connectors/http";
import {
  ConnectorAuthError,
  type AdapterContext,
  type ConnectionState,
  type JobPushResult,
  type PlatformAdapter,
} from "@/lib/connectors/types";
import {
  buildAggregatedJobBody,
  buildSchoolJobBody,
  preflight,
  type InstitutionPushInput,
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
 * permanently burns one of the school's daily write units (100/day on a
 * grant, 500/day on the platform key) without creating anything. Every local
 * refusal below therefore happens before `ctx.http` exists, and no failure is
 * ever retried.
 */

const PLATFORM = "EDUFLEET" as const;
const LABEL = PLATFORM_LABELS[PLATFORM];

type Actor = { id: string; name: string };

export type VacancyListingDTO = {
  jobId: string;
  contract: VacancyListingContract;
  lastPushedAt: string;
  claimState?: VacancyClaimState;
  blockedReason?: string;
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
  | { status: "PUSHED"; listing: VacancyListingDTO }
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
 * Runs one adapter call, letting exactly two things through untouched:
 * `ConnectorAuthError` (rule 7 — the connection service's existing handler
 * discriminates it to flip the connection out of `CONNECTED`; swallowing it
 * here would leave IDAP holding a credential it already knows is dead) and
 * `AppError` (a refusal this service itself raised). Everything else becomes
 * the 502 above.
 */
async function callAdapter(run: () => Promise<JobPushResult>): Promise<JobPushResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConnectorAuthError) throw error;
    if (error instanceof AppError) throw error;
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

function toVacancyInput(vacancy: VacancyDoc): VacancyPushInput {
  return {
    vacancyId: String(vacancy._id),
    title: vacancy.title,
    subject: vacancy.subject,
    description: vacancy.description,
    salaryMin: vacancy.salaryMin ?? undefined,
    salaryMax: vacancy.salaryMax ?? undefined,
    experienceRequired: vacancy.experienceRequired ?? undefined,
    facilities: vacancy.facilities?.length ? vacancy.facilities : undefined,
  };
}

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
function assertPreflight(
  vacancy: VacancyPushInput,
  institution: InstitutionPushInput,
  contract: VacancyListingContract,
): void {
  const reasons = preflight(vacancy, institution, contract);
  if (reasons.length === 0) return;
  throw validationError(
    reasons.length === 1
      ? reasons[0]
      : `This vacancy cannot be published to ${LABEL} yet — ${reasons.length} things need fixing`,
    reasons,
  );
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * The only fields either contract's PATCH actually applies
 * (`PartnerJobPatch`, `SchoolJobPatch`). Everything else in a create body —
 * `externalJobId`, `subject`, `institutionName`, `city`, `district`, `state`
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
 */
const PATCHABLE_KEYS = [
  "title",
  "description",
  "salaryMin",
  "salaryMax",
  "experienceRequired",
  "facilities",
] as const;

function toPatchBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PATCHABLE_KEYS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

/**
 * How each contract addresses an existing job — the two are opposites, and
 * getting it backwards is a silent 404 against a listing that is very much
 * alive. Contract One's `updatePartnerJob` looks the job up by
 * `partnerExternalJobId`, which is IDAP's own vacancy id; Contract Two's
 * `updateSchoolJob` looks it up by `_id`, which is the `jobId` eduFleet
 * returned when it created the job.
 */
function addressOf(vacancyId: string, listing: { jobId: string; contract: VacancyListingContract }): string {
  return listing.contract === "SCHOOL_POSTED" ? listing.jobId : vacancyId;
}

// ---------------------------------------------------------------------------
// Recording the answer
// ---------------------------------------------------------------------------

const KNOWN_CLAIM_STATES = new Set<string>(VACANCY_CLAIM_STATES);

/**
 * eduFleet's `CLAIM_STATUSES` has four values (`Job.ts:13`); IDAP's
 * `VACANCY_CLAIM_STATES` has three — `withdrawn` (an approved takedown) is
 * eduFleet-only. Nothing these three methods call can return it today
 * (a create always answers `unclaimed`, Contract One's PATCH 403s on a
 * withdrawn job before it can answer, and Contract Two never reports a claim
 * state at all), but storing an unrecognised value verbatim would fail the
 * model's enum on save — AFTER the job went live, leaving a public advert
 * IDAP recorded no id for. Unknown values are dropped instead so the write
 * cannot fail on data eduFleet chose.
 */
function toClaimState(value: string | undefined): VacancyClaimState | undefined {
  return value !== undefined && KNOWN_CLAIM_STATES.has(value)
    ? (value as VacancyClaimState)
    : undefined;
}

function toListingDTO(listing: NonNullable<VacancyDoc["listing"]>): VacancyListingDTO {
  return {
    jobId: listing.jobId,
    contract: listing.contract as VacancyListingContract,
    lastPushedAt: listing.lastPushedAt.toISOString(),
    claimState: (listing.claimState as VacancyClaimState | undefined) ?? undefined,
    blockedReason: listing.blockedReason ?? undefined,
  };
}

/**
 * eduFleet's `403` reasons, in words a school admin can act on (spec §9).
 *
 * None of them is terminal, and the wording must not imply otherwise: the
 * single reason `claimed` covers four different states on Contract One's
 * PATCH (`claimed`, `claim_pending`, `withdrawn`, `hiddenPendingReview`), and
 * two of those — a claim awaiting an admin's decision, and a takedown pending
 * review — revert on their own. `upgrade_required` clears the moment the
 * school frees a slot or upgrades.
 */
function blockedMessage(reason: string): string {
  switch (reason) {
    case "claimed":
      return `${LABEL} will not accept changes to this listing right now — the school has claimed it, or a claim or takedown is awaiting review there. Manage it on ${LABEL}, or try again once that clears.`;
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
): Promise<VacancyListingDTO | undefined> {
  if (!vacancy.listing) return undefined;
  const updated = await Vacancy.findOneAndUpdate(
    { _id: vacancy._id, institutionId },
    { $set: { "listing.blockedReason": message } },
    { new: true },
  ).lean<VacancyDoc>();
  return updated?.listing ? toListingDTO(updated.listing) : undefined;
}

/** A successful push: the listing block is created (on a create) or refreshed
 *  (on a patch/close), and any recorded block is cleared — the push that just
 *  worked is proof the refusal is over. */
async function recordSuccess(
  institutionId: string,
  vacancy: VacancyDoc,
  contract: VacancyListingContract,
  result: Extract<JobPushResult, { kind: "OK" }>,
): Promise<VacancyListingDTO> {
  const now = new Date();
  const claimState = toClaimState(result.claimState);

  // A create replaces the whole sub-document; a patch/close touches only the
  // fields it actually learned about. `$set` on `listing` and `$unset` on
  // `listing.blockedReason` are conflicting paths in one update, so the two
  // shapes stay separate rather than being merged.
  const update = vacancy.listing
    ? {
        $set: {
          "listing.lastPushedAt": now,
          ...(claimState ? { "listing.claimState": claimState } : {}),
        },
        $unset: { "listing.blockedReason": "" },
      }
    : {
        $set: {
          listing: {
            jobId: result.jobId,
            contract,
            lastPushedAt: now,
            claimState: claimState ?? "unclaimed",
          },
        },
      };

  const updated = await Vacancy.findOneAndUpdate({ _id: vacancy._id, institutionId }, update, {
    new: true,
  }).lean<VacancyDoc>();
  /* c8 ignore next */
  if (!updated?.listing) throw notFound("Vacancy not found");
  return toListingDTO(updated.listing);
}

/** Turns one classified answer into an outcome, and records it. */
async function settle(
  institutionId: string,
  vacancy: VacancyDoc,
  contract: VacancyListingContract,
  result: JobPushResult,
  kind: "PUSHED" | "CLOSED",
  actor: Actor,
): Promise<VacancyPublishOutcome> {
  if (result.kind === "OK") {
    const listing = await recordSuccess(institutionId, vacancy, contract, result);
    await record(
      institutionId,
      vacancy,
      kind === "CLOSED" ? "Vacancy closed on eduFleet" : "Vacancy published to eduFleet",
      `${vacancy.title} — ${LABEL} job ${listing.jobId}`,
      actor,
    );
    return kind === "CLOSED" ? { status: "CLOSED", listing } : { status: "PUSHED", listing };
  }

  if (result.kind === "BLOCKED") {
    const message = blockedMessage(result.reason);
    const listing = await recordBlockedReason(institutionId, vacancy, message);
    await record(institutionId, vacancy, "eduFleet push blocked", `${vacancy.title} — ${result.detail}`, actor);
    return { status: "BLOCKED", message, listing };
  }

  const message = conflictMessage(result.ownedByContract);
  const listing = await recordBlockedReason(institutionId, vacancy, message);
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
 * Create or update the listing for one vacancy. `allowCreate` is false for
 * `repush`: an edit must never be what first puts a vacancy on a public jobs
 * board (spec §10 — a vacancy is pushed only by an explicit school action).
 */
async function pushFields(
  institutionId: string,
  vacancy: VacancyDoc,
  actor: Actor,
  allowCreate: boolean,
): Promise<VacancyPublishOutcome> {
  const listing = vacancy.listing ?? undefined;
  if (!listing && !allowCreate) {
    throw validationError(`Publish this vacancy to ${LABEL} before updating its listing`);
  }

  const institution = await loadInstitution(institutionId);
  assertCity(institution.city); // rule 2 — before anything else can spend a unit

  const { contract, connection } = await resolveTarget(
    institutionId,
    listing?.contract as VacancyListingContract | undefined,
  );

  const vacancyInput = toVacancyInput(vacancy);
  const institutionInput = toInstitutionInput(institution);
  assertPreflight(vacancyInput, institutionInput, contract); // rule 3 — still no HTTP

  const body =
    contract === "SCHOOL_POSTED"
      ? buildSchoolJobBody(vacancyInput, institutionInput)
      : buildAggregatedJobBody(vacancyInput, institutionInput);

  const adapter = jobAdapter();
  const ctx = await buildContext();

  const result = await callAdapter(() =>
    listing
      ? adapter.patchJob(
          ctx,
          connection,
          addressOf(String(vacancy._id), { jobId: listing.jobId, contract }),
          toPatchBody(body),
          contract,
        )
      : adapter.createJob(ctx, connection, body, contract),
  );

  return settle(institutionId, vacancy, contract, result, "PUSHED", actor);
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
  const listing = vacancy.listing;
  if (!listing) return { status: "NOT_LISTED" };

  const contract = listing.contract as VacancyListingContract;
  const { connection } = await resolveTarget(institutionId, contract);

  const adapter = jobAdapter();
  const ctx = await buildContext();

  const result = await callAdapter(() =>
    adapter.closeJob(
      ctx,
      connection,
      addressOf(String(vacancy._id), { jobId: listing.jobId, contract }),
      contract,
    ),
  );

  return settle(institutionId, vacancy, contract, result, "CLOSED", actor);
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

    if (vacancy.status === "DRAFT") {
      throw validationError(`Set this vacancy to Open before publishing it to ${LABEL}`);
    }
    if (vacancy.status === "FILLED" || vacancy.status === "CLOSED") {
      return pushCloseFor(institutionId, vacancy, actor);
    }
    return pushFields(institutionId, vacancy, actor, true);
  },

  /**
   * Push the vacancy's current values to a listing it already has — the hook
   * an edit uses. Identical to `publish` in every respect but one: it never
   * creates. A vacancy the school never chose to publish stays unpublished,
   * whatever is edited on it.
   */
  async repush(institutionId: string, vacancyId: string, actor: Actor): Promise<VacancyPublishOutcome> {
    await connectToDatabase();
    const vacancy = await loadVacancy(institutionId, vacancyId);

    if (vacancy.status === "DRAFT") {
      throw validationError(`Set this vacancy to Open before publishing it to ${LABEL}`);
    }
    if (vacancy.status === "FILLED" || vacancy.status === "CLOSED") {
      return pushCloseFor(institutionId, vacancy, actor);
    }
    return pushFields(institutionId, vacancy, actor, false);
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
