import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { AcademicUnit, PlatformConnection, PlatformCredential, Scholarship } from "@/models";
import type { PlatformCredentialDoc, ScholarshipDoc } from "@/models";
import { AppError, notFound, validationError } from "@/lib/api/errors";
import { PLATFORM_LABELS, type ScholarshipListingRemoteStatus } from "@/lib/constants";
import { credentialVaultReady, decryptCredential } from "@/lib/security/credentials";
import { adapterFor } from "@/lib/connectors";
import { createConnectorHttp } from "@/lib/connectors/http";
import {
  ConnectorCapExceededError,
  ConnectorRejectedError,
  type AdapterContext,
  type ConnectionState,
  type PlatformAdapter,
  type ScholarshipPushResult,
} from "@/lib/connectors/types";
import { toHubScholarshipPayload } from "@/lib/connectors/scholarship-hub-mapping";
import { assertScholarshipHubPublishable } from "@/lib/validation/scholarship";
import { ActivityService } from "./activity.service";

/**
 * The Scholarship Hub publish push — the orchestrator.
 *
 * Mirrors `vacancy-publish.service.ts`'s shape (`callAdapter` classification,
 * `recordSuccess`/`recordBlockedReason`/`recordPushFailure`, the never-throw
 * `pushEdit`) but is considerably simpler than that file, because the
 * contract it sits on top of is simpler:
 *
 * - **One credential, no per-institution grant.** Every push authenticates
 *   with `ctx.platformKey` (Contract 1, shared across every institution) —
 *   there is no school-held grant to decrypt, no contract selection
 *   (`resolveTarget`'s job on the vacancy side), and therefore no
 *   `ConnectorAuthError` branch in `callAdapter` below. A revoked platform
 *   key is a hard, platform-config problem for the super-admin, not a
 *   per-institution failure — see the adapter's own docblock
 *   (`classifyScholarshipPush`) and Ruling B in the plan ledger.
 * - **One idempotent route, no claim/conflict state.** `upsertScholarship` is
 *   a `PUT` keyed by `externalRef` that Scholarship Hub itself treats as a
 *   create-or-update — unlike eduFleet's two-contract, create-vs-patch job
 *   routes, there is exactly one shape to send and its `OK` response is
 *   always the full, authoritative state of the listing. That is what lets
 *   `recordSuccess` below always replace the whole `listing` sub-document
 *   rather than needing vacancy's separate create/patch write paths.
 *
 * Still two structural rules carried over unchanged from the vacancy file:
 *
 * 1. **It must never import `connection.service.ts`.** Task 9 wires
 *    `connection.service.ts`'s `syncNow` to this file's `repush`/`pushClose`,
 *    so the dependency runs one way only; importing back would be a runtime
 *    cycle. `buildContext` and the CONNECTED-connection lookup are therefore
 *    duplicated here rather than imported, exactly as `vacancy-publish.
 *    service.ts` duplicates `connection.service.ts`'s `loadAdapterContext`.
 * 2. **Every query is scoped by `institutionId`.** A scholarship id alone is
 *    not an authorisation.
 */

const PLATFORM = "SCHOLARSHIP_HUB" as const;
const LABEL = PLATFORM_LABELS[PLATFORM];

type Actor = { id: string; name: string };

export type ScholarshipListingDTO = {
  hubId: string;
  externalRef: string;
  slug?: string;
  publicUrl?: string;
  remoteStatus: ScholarshipListingRemoteStatus;
  lastPushedAt: string;
  blockedReason?: string;
};

/**
 * What one push did — PARALLEL to `VacancyPublishOutcome`, not a copy of it:
 * Scholarship Hub has no `CONFLICT` case at all (idempotent by `externalRef`,
 * no claim state), so that arm simply does not exist here.
 */
export type ScholarshipPublishOutcome =
  | { status: "PUSHED"; listing: ScholarshipListingDTO }
  | { status: "CLOSED"; listing: ScholarshipListingDTO }
  | { status: "NOT_LISTED" }
  | { status: "BLOCKED"; message: string; listing?: ScholarshipListingDTO };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A malformed id must read as "no such scholarship", not as a cast error —
 *  same convention as `scholarship.service.ts`'s own `toObjectId`. */
function toObjectId(scholarshipId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(scholarshipId)) throw notFound("Scholarship not found");
  return new Types.ObjectId(scholarshipId);
}

/** Bounds a remote-derived value before it is persisted and shown — same
 *  policy as `vacancy-publish.service.ts`'s `clip`. */
function clip(value: string): string {
  return value.slice(0, 120);
}

function externalRefOf(institutionId: string, scholarshipId: string): string {
  return `IDAP:${institutionId}:${scholarshipId}`;
}

/**
 * A plain thrown `Error` from an adapter call means Scholarship Hub itself
 * failed (unreachable, misconfigured, an uncataloged 5xx, or — per Ruling B —
 * a revoked platform key, which `classifyScholarshipPush` deliberately throws
 * as a plain `Error` rather than a typed auth error). Same 502 shape and
 * reasoning as `vacancy-publish.service.ts`'s `upstreamError`.
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
 * Runs one adapter call and sorts what comes back out of it into three
 * kinds. Deliberately has NO `ConnectorAuthError` branch — see this file's
 * docblock and Ruling B: Scholarship Hub's platform key is Contract 1, and a
 * 401 against it throws a plain `Error` (never `ConnectorAuthError`), so it
 * falls straight to the generic 502 below rather than disconnecting any
 * institution's row.
 *
 * `AppError` passes through untouched — it is a refusal this service raised.
 *
 * `ConnectorCapExceededError` becomes a 429: nothing is wrong with
 * Scholarship Hub and nothing changes by retrying immediately.
 *
 * `ConnectorRejectedError` — a 422 — becomes a `VALIDATION_ERROR` carrying
 * the Hub's own words, deliberately NOT the 502 below: the identical body
 * will be refused identically, and copy that invites a retry on a
 * deterministic refusal is actively misleading.
 *
 * Everything else is a transport or server failure, and gets the 502.
 */
async function callAdapter(run: () => Promise<ScholarshipPushResult>): Promise<ScholarshipPushResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ConnectorCapExceededError) {
      throw new AppError("RATE_LIMITED", error.message);
    }
    if (error instanceof ConnectorRejectedError) {
      const said = error.detail ?? error.reason;
      throw validationError(
        said
          ? `${LABEL} refused this scholarship: ${clip(said)}. Publishing it again unchanged will be refused again.`
          : `${LABEL} refused this scholarship. Publishing it again unchanged will be refused again.`,
      );
    }
    throw upstreamError();
  }
}

type ScholarshipHubAdapter = PlatformAdapter &
  Required<Pick<PlatformAdapter, "upsertScholarship" | "withdrawScholarship">>;

/** The registry lookup, with the optional scholarship methods proven present
 *  once rather than asserted at each of the two call sites. */
function scholarshipAdapter(): ScholarshipHubAdapter {
  let adapter: PlatformAdapter;
  try {
    adapter = adapterFor(PLATFORM);
  } catch {
    throw validationError(`${LABEL} integration is not available yet`);
  }
  if (!adapter.upsertScholarship || !adapter.withdrawScholarship) {
    throw validationError(`${LABEL} does not support publishing scholarships`);
  }
  return adapter as ScholarshipHubAdapter;
}

/**
 * The platform key and base URL, decrypted. 404s (not a 500) when
 * Scholarship Hub has no active credential or the vault is unconfigured.
 * Duplicated from `connection.service.ts`'s `loadAdapterContext` rather than
 * imported — see this file's docblock, rule 1. Identical in shape to
 * `vacancy-publish.service.ts`'s own `buildContext`.
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

/**
 * The CONNECTED-connection gate. Scholarship Hub carries no per-institution
 * grant (every push authenticates with `ctx.platformKey`), so unlike
 * vacancy's `resolveTarget` this never decrypts anything from the row — it
 * exists solely to enforce "only push when the institution has a CONNECTED
 * SCHOLARSHIP_HUB connection", which is the switch that lets an institution
 * be provisioned on the Hub (`initiate`/`refresh`) before anything of theirs
 * is ever pushed.
 *
 * TENANT-SENSITIVE: `institutionId` scopes the lookup, exactly like every
 * other read/write in this file.
 */
async function requireConnection(institutionId: string): Promise<ConnectionState> {
  const row = await PlatformConnection.findOne({ institutionId, platform: PLATFORM }).lean();
  if (!row || row.status !== "CONNECTED") {
    throw validationError(`Connect to ${LABEL} before publishing scholarships`);
  }
  return {
    institutionId,
    externalRef: row.externalRef ?? institutionId,
    remoteRequestId: row.remoteRequestId ?? undefined,
    scopes: row.scopes ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Loading the rows this service reads
// ---------------------------------------------------------------------------

/** TENANT-SENSITIVE: `institutionId` is what makes a scholarship id an
 *  authorisation rather than a guess. Never relax this to `findById`. */
async function loadScholarship(institutionId: string, scholarshipId: string): Promise<ScholarshipDoc> {
  const row = await Scholarship.findOne({
    _id: toObjectId(scholarshipId),
    institutionId,
  }).lean<ScholarshipDoc>();
  if (!row) throw notFound("Scholarship not found");
  return row;
}

/**
 * The academic unit's `pathLabel`, for `toHubScholarshipPayload`'s
 * `classOrCourse` — same one-query-per-push lookup `scholarship.service.ts`'s
 * `withLabels`/`offer.service.ts` use, just for a single row instead of a
 * list. Absent `academicUnitId` means the scholarship is institution-wide, so
 * nothing is looked up and `classOrCourse` stays `undefined` — which
 * `toHubScholarshipPayload` reads as "fall back to `eligibility.
 * classesOrCourses`", exactly as Task 6 intends.
 */
async function classOrCourseFor(
  institutionId: string,
  academicUnitId: Types.ObjectId | null | undefined,
): Promise<string | undefined> {
  if (!academicUnitId) return undefined;
  const unit = await AcademicUnit.findOne({ _id: academicUnitId, institutionId })
    .select("pathLabel")
    .lean<{ pathLabel: string } | null>();
  return unit?.pathLabel;
}

// ---------------------------------------------------------------------------
// Recording the answer
// ---------------------------------------------------------------------------

/** One definition of "Scholarship Hub is still showing this listing" — same
 *  role as `vacancy-publish.service.ts`'s `isListingLive`. */
function isListingLive(
  listing: ScholarshipDoc["listing"] | undefined,
): listing is NonNullable<ScholarshipDoc["listing"]> {
  return listing !== undefined && listing !== null && listing.remoteStatus !== "closed";
}

/** Exported for `scholarship.service.ts`'s own serializer, so the listing a
 *  school sees on its dashboard is built by the same function as the one a
 *  push returns — one shape, not two that drift (same rationale as
 *  `vacancy-publish.service.ts`'s exported `toListingDTO`). */
export function toScholarshipListingDTO(listing: NonNullable<ScholarshipDoc["listing"]>): ScholarshipListingDTO {
  return {
    hubId: listing.hubId,
    externalRef: listing.externalRef,
    slug: listing.slug || undefined,
    publicUrl: listing.publicUrl || undefined,
    remoteStatus: (listing.remoteStatus as ScholarshipListingRemoteStatus | undefined) ?? "published",
    lastPushedAt: listing.lastPushedAt.toISOString(),
    blockedReason: listing.blockedReason || undefined,
  };
}

async function record(
  institutionId: string,
  scholarship: ScholarshipDoc,
  action: string,
  description: string,
  actor: Actor,
): Promise<void> {
  await ActivityService.record({
    institutionId,
    entityType: "SCHOLARSHIP",
    entityId: scholarship._id,
    entityRef: institutionId,
    action,
    description,
    performedBy: actor.id,
    performedByName: actor.name,
  });
}

/**
 * A successful push. Scholarship Hub's `upsertScholarship` is a single
 * idempotent `PUT` whose `OK` response is always the listing's full,
 * authoritative state (`hubId`/`slug`/`publicUrl`/`remoteStatus`) — unlike
 * eduFleet's create-vs-patch split, there is no "which fields did THIS call
 * actually change" question to answer, so the whole `listing` sub-document is
 * replaced on every successful push. That replacement is also what clears a
 * previously recorded `blockedReason`: the new object simply does not carry
 * one, so a bare `$set: { listing: {...} }` is sufficient — combining it with
 * an `$unset: { "listing.blockedReason": "" }` in the SAME update would
 * conflict with MongoDB (a modifier on `listing.blockedReason` and a
 * replacement of `listing` itself in one update document are mutually
 * exclusive paths), so no such `$unset` is issued here or needed.
 */
async function recordSuccess(
  institutionId: string,
  scholarship: ScholarshipDoc,
  externalRef: string,
  result: Extract<ScholarshipPushResult, { kind: "OK" }>,
): Promise<ScholarshipListingDTO> {
  const updated = await Scholarship.findOneAndUpdate(
    { _id: scholarship._id, institutionId },
    {
      $set: {
        listing: {
          hubId: result.hubId,
          externalRef,
          slug: result.slug || undefined,
          publicUrl: result.publicUrl,
          remoteStatus: result.remoteStatus,
          lastPushedAt: new Date(),
        },
      },
    },
    { new: true },
  ).lean<ScholarshipDoc>();
  /* c8 ignore next */
  if (!updated?.listing) throw notFound("Scholarship not found");
  return toScholarshipListingDTO(updated.listing);
}

/**
 * A close (or a withdraw that came back `NOT_FOUND` — see `settle` below).
 * Deliberately a NARROW update — only `remoteStatus`/`lastPushedAt` — rather
 * than `recordSuccess`'s full replace: `withdrawScholarship`'s own `OK`
 * response never carries `slug`/`publicUrl` (`classifyScholarshipPush`
 * defaults them to `""`/`undefined` on that route), and replacing the whole
 * sub-document with those blanks would erase the real values a school might
 * still want to see on an already-closed listing's history.
 */
async function recordClosed(institutionId: string, scholarship: ScholarshipDoc): Promise<ScholarshipListingDTO> {
  const updated = await Scholarship.findOneAndUpdate(
    { _id: scholarship._id, institutionId },
    { $set: { "listing.remoteStatus": "closed", "listing.lastPushedAt": new Date() } },
    { new: true },
  ).lean<ScholarshipDoc>();
  /* c8 ignore next */
  if (!updated?.listing) throw notFound("Scholarship not found");
  return toScholarshipListingDTO(updated.listing);
}

/**
 * A `BLOCKED` push (a `409 MODERATION_HOLD`, never thrown — a hold can lift,
 * so a caller must be able to retry). RECORDED, never latched, same as
 * vacancy's `recordBlockedReason`: only `blockedReason`/`lastPushedAt` are
 * touched on an EXISTING listing, so a listing that "failed once" stays a
 * live, retryable listing.
 *
 * Unlike vacancy's version, a `BLOCKED` response on a scholarship that has no
 * listing yet is NOT dropped silently. `scholarshipHubMissingFields` already
 * gates every field the Hub itself validates before this call is ever made,
 * so a `BLOCKED` reaching here is a moderation hold on otherwise-valid
 * content — not a fabricated success. A minimal listing carrying the
 * `externalRef` and the reason (no `hubId`: Scholarship Hub never issues one
 * for a create it holds) lets the card show WHY nothing is live yet, and
 * gives `repush` something to retry against. If Scholarship Hub in fact
 * created nothing, a later `pushClose` against this `externalRef` answers
 * `NOT_FOUND`, which `settle` already reads as an already-closed success —
 * so recording this minimal listing costs nothing if the guess is wrong.
 */
async function recordBlockedReason(
  institutionId: string,
  scholarship: ScholarshipDoc,
  externalRef: string,
  message: string,
): Promise<ScholarshipListingDTO | undefined> {
  const now = new Date();
  if (scholarship.listing) {
    const updated = await Scholarship.findOneAndUpdate(
      { _id: scholarship._id, institutionId },
      { $set: { "listing.blockedReason": message, "listing.lastPushedAt": now } },
      { new: true },
    ).lean<ScholarshipDoc>();
    return updated?.listing ? toScholarshipListingDTO(updated.listing) : undefined;
  }

  const updated = await Scholarship.findOneAndUpdate(
    { _id: scholarship._id, institutionId },
    {
      $set: {
        listing: {
          hubId: "",
          externalRef,
          remoteStatus: "published",
          lastPushedAt: now,
          blockedReason: message,
        },
      },
    },
    { new: true },
  ).lean<ScholarshipDoc>();
  return updated?.listing ? toScholarshipListingDTO(updated.listing) : undefined;
}

/**
 * Records why an edit's push never landed — the same field a `BLOCKED`
 * response uses, and for the same reason: it is "why this listing is
 * currently out of step with IDAP". Mirrors `vacancy-publish.service.ts`'s
 * `recordPushFailure`, guard for guard:
 *
 * - `listing: { $exists: true }` — `updateOne` runs no validators, so a bare
 *   `$set` on `listing.blockedReason` against a scholarship with no listing
 *   would CREATE a listing sub-document holding nothing but a reason: no
 *   `hubId`, no `externalRef`, and a scholarship that reads as "published"
 *   everywhere it is shown while pointing at nothing.
 * - `institutionId` — TENANT-SENSITIVE, exactly like every other write here.
 */
async function recordPushFailure(institutionId: string, scholarshipId: string, message: string): Promise<void> {
  await Scholarship.updateOne(
    { _id: toObjectId(scholarshipId), institutionId, listing: { $exists: true } },
    { $set: { "listing.blockedReason": clip(message) } },
  );
}

// ---------------------------------------------------------------------------
// The two pushes
// ---------------------------------------------------------------------------

/**
 * Create or update the listing for one scholarship.
 *
 * `allowCreate` is false for `repush`: an edit must never be what first puts
 * a scholarship on Scholarship Hub, nor what puts it back on it after a
 * close — same rule, same reason, as `vacancy-publish.service.ts`'s
 * `pushFields`.
 */
async function pushFields(
  institutionId: string,
  scholarship: ScholarshipDoc,
  actor: Actor,
  allowCreate: boolean,
): Promise<ScholarshipPublishOutcome> {
  const listing = scholarship.listing ?? undefined;
  const live = isListingLive(listing);

  if (!live && !allowCreate) {
    throw validationError(
      listing
        ? `This listing was closed on ${LABEL} — publish this scholarship again to create a new one`
        : `Publish this scholarship to ${LABEL} before updating its listing`,
    );
  }

  // `as never`: `GateInput`/`ScholarshipLike` (Task 4/6's own param types)
  // declare several optional string/object fields without `null`, but
  // Mongoose's `InferSchemaType` types those same unrequired paths on
  // `ScholarshipDoc` as `T | null | undefined`. Both consumers already treat
  // `null` and `undefined` identically at runtime (`blank()`'s `!s` check,
  // `dropUndefined`'s `!== undefined` filter, every `??`/`||` fallback), so
  // the mismatch is purely nominal — the same bridge Task 6's own test file
  // uses (`tests/unit/scholarship-hub-mapping.test.ts`) to pass a doc-shaped
  // object into this exact function.
  assertScholarshipHubPublishable(scholarship as never);

  const externalRef = externalRefOf(institutionId, String(scholarship._id));
  const classOrCourse = await classOrCourseFor(institutionId, scholarship.academicUnitId);
  const payload = toHubScholarshipPayload(scholarship as never, classOrCourse);

  const connection = await requireConnection(institutionId);
  const adapter = scholarshipAdapter();
  const ctx = await buildContext();

  const result = await callAdapter(() => adapter.upsertScholarship(ctx, connection, externalRef, payload));

  if (result.kind === "OK") {
    const listingDTO = await recordSuccess(institutionId, scholarship, externalRef, result);
    await record(
      institutionId,
      scholarship,
      "Scholarship published to Scholarship Hub",
      `${scholarship.name} — ${LABEL} listing ${listingDTO.hubId}`,
      actor,
    );
    return { status: "PUSHED", listing: listingDTO };
  }

  if (result.kind === "BLOCKED") {
    const message = clip(result.detail || result.reason);
    const listingDTO = await recordBlockedReason(institutionId, scholarship, externalRef, message);
    await record(institutionId, scholarship, "Scholarship Hub push blocked", `${scholarship.name} — ${message}`, actor);
    return { status: "BLOCKED", message, listing: listingDTO };
  }

  // NOT_FOUND: `upsertScholarship` never actually produces this — only
  // `withdrawScholarship` special-cases a 404 into it (see the adapter's own
  // docblock) — so this arm only exists to keep the switch over
  // `ScholarshipPushResult` exhaustive. Handled defensively rather than
  // assumed unreachable: treated as "nothing to push to any more", the same
  // reading `settle`-equivalent logic gives a withdraw's own `NOT_FOUND`.
  if (!scholarship.listing) return { status: "NOT_LISTED" };
  const listingDTO = await recordClosed(institutionId, scholarship);
  return { status: "CLOSED", listing: listingDTO };
}

/**
 * Close the listing for one scholarship, if it has one. No preflight and no
 * payload here — a withdraw carries no body — mirrors
 * `vacancy-publish.service.ts`'s `pushCloseFor` for the same reason: gating a
 * close on a rule about PUSHES would strand a live public listing the moment
 * a scholarship's own content goes stale.
 *
 * `NOT_LISTED` — no HTTP call at all — is how a caller tells "already
 * retracted" apart from "the close was refused", same convention as vacancy.
 */
async function pushCloseFor(
  institutionId: string,
  scholarship: ScholarshipDoc,
  actor: Actor,
): Promise<ScholarshipPublishOutcome> {
  const listing = scholarship.listing ?? undefined;
  if (!isListingLive(listing)) return { status: "NOT_LISTED" };

  const externalRef = listing.externalRef;
  const connection = await requireConnection(institutionId);
  const adapter = scholarshipAdapter();
  const ctx = await buildContext();

  const result = await callAdapter(() => adapter.withdrawScholarship(ctx, connection, externalRef));

  if (result.kind === "BLOCKED") {
    const message = clip(result.detail || result.reason);
    const listingDTO = await recordBlockedReason(institutionId, scholarship, externalRef, message);
    await record(institutionId, scholarship, "Scholarship Hub push blocked", `${scholarship.name} — ${message}`, actor);
    return { status: "BLOCKED", message, listing: listingDTO };
  }

  // OK or NOT_FOUND — both mean "not live on Scholarship Hub any more" from
  // IDAP's side (see `classifyScholarshipPush`/`withdrawScholarship`'s own
  // docblocks: a 404 on withdraw is treated as an already-closed success,
  // never a failure).
  const listingDTO = await recordClosed(institutionId, scholarship);
  await record(
    institutionId,
    scholarship,
    "Scholarship closed on Scholarship Hub",
    `${scholarship.name} — ${LABEL} listing ${listing.hubId}`,
    actor,
  );
  return { status: "CLOSED", listing: listingDTO };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const ScholarshipPublishService = {
  /** The institution's explicit publish action — may create a new listing. */
  async publish(institutionId: string, scholarshipId: string, actor: Actor): Promise<ScholarshipPublishOutcome> {
    await connectToDatabase();
    const scholarship = await loadScholarship(institutionId, scholarshipId);
    return pushFields(institutionId, scholarship, actor, true);
  },

  /**
   * Push the scholarship's current values to a listing it already has —
   * never creates one. A scholarship the institution never chose to publish
   * stays unpublished, whatever is edited on it, and so does one whose
   * listing was closed.
   */
  async repush(institutionId: string, scholarshipId: string, actor: Actor): Promise<ScholarshipPublishOutcome> {
    await connectToDatabase();
    const scholarship = await loadScholarship(institutionId, scholarshipId);
    return pushFields(institutionId, scholarship, actor, false);
  },

  /**
   * The hook an edit uses. Identical to `repush` but **never throws**: by
   * the time this runs the institution's edit is already saved, and "your
   * change was saved" must not collapse into "and the push failed" — every
   * failure is recorded on the listing instead (`recordPushFailure`), where
   * it reaches the institution as `blockedReason`. Same rationale as
   * `vacancy-publish.service.ts`'s `pushEdit`, minus the `ConnectorAuthError`
   * translation that file needs and this platform (Ruling B) does not.
   */
  async pushEdit(institutionId: string, scholarshipId: string, actor: Actor): Promise<void> {
    try {
      await this.repush(institutionId, scholarshipId, actor);
    } catch (error) {
      await recordPushFailure(institutionId, scholarshipId, error instanceof Error ? error.message : String(error));
    }
  },

  /** Close this scholarship's listing on Scholarship Hub, whatever its IDAP
   *  status. Returns `NOT_LISTED` when there is nothing to close. */
  async pushClose(institutionId: string, scholarshipId: string, actor: Actor): Promise<ScholarshipPublishOutcome> {
    await connectToDatabase();
    const scholarship = await loadScholarship(institutionId, scholarshipId);
    return pushCloseFor(institutionId, scholarship, actor);
  },
};
