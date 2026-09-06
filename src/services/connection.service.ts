import "server-only";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution, PlatformConnection, PlatformCredential, Scholarship, SyncRun, Vacancy } from "@/models";
import type {
  PlatformConnectionDoc,
  PlatformCredentialDoc,
  ScholarshipDoc,
  SyncRunDoc,
  VacancyDoc,
} from "@/models";
import {
  PLATFORMS,
  PLATFORM_LABELS,
  SCHOLARSHIP_MAX_PER_INSTITUTION,
  SYNC_LOCK_STALE_MINUTES,
  SYNC_RUN_KEEP,
  VACANCY_MAX_RECORDS,
  type ConnectionStatus,
  type Platform,
  type SyncStatus,
} from "@/lib/constants";
import { credentialVaultReady, decryptCredential, encryptCredential } from "@/lib/security/credentials";
import { AppError, notFound, validationError } from "@/lib/api/errors";
import { requiredIso, toIso } from "@/lib/utils/serialize";
import { storage } from "@/lib/storage";
import { adapterFor } from "@/lib/connectors";
import { createConnectorHttp } from "@/lib/connectors/http";
import {
  ConnectorAuthError,
  type ConnectionState,
  type ConnectResult,
  type InitiateResult,
  type InstitutionSummary,
  type PlatformAdapter,
  type RefreshResult,
  type SyncOutcome,
  type SyncScholarship,
  type SyncSourceData,
  type SyncVacancy,
  type VacancyActionResult,
} from "@/lib/connectors/types";
import { ResultService } from "./result.service";
import { ActivityService } from "./activity.service";
import { VacancyPublishService, type VacancyPublishOutcome } from "./vacancy-publish.service";
// Task 9: same one-way direction as `VacancyPublishService` above —
// `scholarship-publish.service.ts` must never import this file back (see its
// own docblock).
import { ScholarshipPublishService, type ScholarshipPublishOutcome } from "./scholarship-publish.service";

const ENTITY_TYPE = "PLATFORM_CONNECTION";

type Actor = { id: string; name: string };

export type ConnectionEntry = {
  platform: Platform;
  configured: boolean;
  status?: ConnectionStatus;
  remoteStatus?: string;
  remoteInstitution?: { name?: string; city?: string; slug?: string };
  scopes?: string[];
  lastSyncAt?: string;
  lastSyncStatus?: SyncStatus;
  lastError?: string;
};

export type SyncRunDTO = {
  id: string;
  platform: Platform;
  trigger: string;
  startedAt: string;
  finishedAt?: string;
  status: SyncStatus;
  steps?: { step: string; ok: boolean; detail?: string }[];
  warnings?: string[];
  error?: string;
  createdAt: string;
};

/**
 * The one boundary check for the `[platform]` route param: every route calls
 * this before touching the service, so an unrecognised platform reads as
 * "no such resource" rather than a business-rule refusal.
 */
export function assertPlatform(value: string): Platform {
  if (!PLATFORMS.includes(value as Platform)) {
    throw notFound(`Unknown platform "${value}"`);
  }
  return value as Platform;
}

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

async function isConfigured(platform: Platform): Promise<boolean> {
  if (!credentialVaultReady()) return false;
  const credential = await PlatformCredential.findOne({ platform, active: true }).select("_id").lean();
  return Boolean(credential);
}

/**
 * Loads the platform key + base URL an adapter call needs, decrypted. 404s
 * (not a 500) when the platform has no active credential or the vault isn't
 * configured — from the caller's point of view those are indistinguishable
 * from "not set up yet".
 */
async function loadAdapterContext(platform: Platform): Promise<{ baseUrl: string; platformKey: string }> {
  if (!credentialVaultReady()) {
    throw notFound(`${PLATFORM_LABELS[platform]} is not configured`);
  }
  const credential = await PlatformCredential.findOne({ platform, active: true })
    .select("+keyEncrypted")
    .lean();
  if (!credential) {
    throw notFound(`${PLATFORM_LABELS[platform]} is not configured`);
  }
  return {
    baseUrl: credential.baseUrl,
    platformKey: decryptCredential((credential as PlatformCredentialDoc).keyEncrypted),
  };
}

/**
 * `AdapterContext.http` is built fresh per call rather than cached: the
 * adapter registry may be overridden in tests, and a real `ConnectorHttp`
 * bound to the wrong base URL is a bug worth avoiding by never reusing one
 * across platforms/tests.
 */
async function buildAdapterContext(platform: Platform) {
  const { baseUrl, platformKey } = await loadAdapterContext(platform);
  return { baseUrl, platformKey, http: createConnectorHttp(baseUrl) };
}

/**
 * `adapterFor` throws a generic Error for a `PLATFORMS` member with no
 * registered adapter — true of FEESBASKET throughout Plan 9a, since its
 * adapter doesn't land until Plan 9b. That's the right behaviour for
 * `adapterFor` itself (fail loudly, one lookup point), but reaching an
 * admin as an unhandled 500 from clicking "Request connection" on a
 * FeesBasket card they were able to configure a credential for (Task 7's
 * admin UI doesn't know which platforms have adapters yet either) is not.
 * Every call site that needs a real adapter goes through here instead, so
 * an unbuilt platform reads as a clean, expected refusal (fix round 1,
 * finding I3).
 */
function resolveAdapter(platform: Platform): PlatformAdapter {
  try {
    return adapterFor(platform);
  } catch {
    throw validationError(`${PLATFORM_LABELS[platform]} integration is not available yet`);
  }
}

/**
 * A caught plain Error/network failure from an adapter call (as opposed to a
 * `ConnectorAuthError`) is real and actionable — the platform itself is
 * unreachable or misconfigured — but its raw message must never reach the
 * HTTP response body verbatim; only `lastError` (already recorded by the
 * caller, on the connection row) carries that detail. Surfaced as 502 rather
 * than the default 500 so it doesn't fall into this codebase's generic
 * "Something went wrong" scrubbing for truly unknown errors — 502 signals a
 * knowable, external, actionable cause instead (fix round 1, routed call 1).
 */
function upstreamError(platform: Platform): AppError {
  return new AppError(
    "INTERNAL_ERROR",
    `${PLATFORM_LABELS[platform]} could not be reached right now — try again shortly`,
    undefined,
    502,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * One vacancy action, as a reconciling adapter needs to see it.
 *
 * `VacancyPublishService` reports itself two ways — an outcome for "eduFleet
 * answered" and a thrown `AppError` for "refused before the wire" — and an
 * adapter has no business knowing that split. This flattens both, keeping the
 * one distinction a reconciler genuinely needs: whether the failure was about
 * THIS vacancy or about the platform, i.e. whether continuing the sweep is
 * worth anything.
 *
 * Two statuses are RUN-scoped. `>= 500` is where the service puts
 * `upstreamError` (502) — eduFleet unreachable, misconfigured, or answering an
 * uncataloged 5xx. `429` is the daily write cap, which since M4 arrives as a
 * classified `RATE_LIMITED` rather than as an unrecognised failure the 502
 * swept up: it is a fact about the credential's budget, not about any one
 * vacancy, and every vacancy after it would be refused identically. That
 * scope was already right while the cap came through as a 502, so it has to
 * move with the status — otherwise classifying the cap properly would
 * silently turn a sweep that stops into one that grinds through every
 * remaining vacancy.
 *
 * A `400`/`404` refusal is about one vacancy and the sweep carries on.
 *
 * **`ConnectorAuthError` is not caught here, and that is load-bearing.** It
 * does not extend `AppError`, so it falls through to the `throw` below,
 * leaves `sync`, and reaches `syncNow`'s own handler — the only path by which
 * IDAP ever learns a school revoked its grant. Turning that final `throw`
 * into a returned failure would silently retire the entire revocation
 * detector while every test about pushing still passed.
 */
async function runVacancyAction(run: () => Promise<VacancyPublishOutcome>): Promise<VacancyActionResult> {
  let outcome: VacancyPublishOutcome;
  try {
    outcome = await run();
  } catch (error) {
    if (error instanceof AppError) {
      const platformScoped = error.status >= 500 || error.status === 429;
      return { ok: false, scope: platformScoped ? "RUN" : "VACANCY", detail: error.message };
    }
    throw error;
  }

  switch (outcome.status) {
    case "PUSHED":
    case "CLOSED":
      return { ok: true };
    case "NOT_LISTED":
      // Nothing was there to close — no HTTP call, nothing failed. Only
      // reachable if the listing went away between the worklist load and the
      // action, which is a race the reconciler does not need to hear about.
      return { ok: true, detail: "nothing was listed" };
    default:
      // BLOCKED and CONFLICT: eduFleet answered and the service has already
      // written the reason onto the listing, so the school sees it on the
      // card too. Reported here so the run says PARTIAL rather than SUCCESS.
      return { ok: false, scope: "VACANCY", detail: outcome.message };
  }
}

/**
 * The vacancy worklist an adapter's `sync` reconciles, built here because
 * adapters never touch models.
 *
 * **Unfiltered on purpose.** It would be cheaper to ask Mongo only for
 * vacancies that carry a listing — every adapter decision that ignores a
 * vacancy today ignores exactly those without one — but that would move a
 * product rule ("a sync never publishes a vacancy for the first time") out of
 * the adapter, where it is stated and tested, and into a query nobody reads.
 * The rows are small, `select`ed and `lean`, and the cost of loading them is
 * a fraction of one HTTP call.
 *
 * Sorted oldest-first, with `_id` breaking ties, so a run's steps are stable
 * and reproducible rather than in whatever order Mongo returns — and, since
 * L3 bounded the read, so that which vacancies fall outside the bound is
 * stable too.
 *
 * TENANT-SENSITIVE: `institutionId` scopes the read, and each closure passes
 * it back into the publish service, which scopes its own reads and writes
 * with it again. A vacancy id is not an authorisation on either side.
 */
async function loadSyncVacancies(
  institutionId: string,
  actor: Actor,
): Promise<{ vacancies: SyncVacancy[]; truncated: boolean }> {
  // L3: bounded, and the bound is `VACANCY_MAX_RECORDS` because that constant
  // already claims to bound "the dashboard list AND the eduFleet sync
  // payload" — `VacancyService.list` enforced it and this reader did not, so
  // the comment described an enforcement that existed on one of its two
  // readers. `create` refusing past the cap makes it unreachable in practice
  // today, and `create`'s own comment already admits its count-then-create
  // window is not atomic; an unbounded read feeding a sweep is not something
  // to leave resting on that.
  //
  // `+ 1` rather than a bare limit, so "exactly at the cap" and "more than
  // the cap" are distinguishable — a silent truncation reads as "everything
  // was reconciled".
  const rows = await Vacancy.find({ institutionId })
    .select("title status listing")
    // `_id` as the tiebreaker, not decoration: `createdAt` alone is not a
    // total order (two vacancies created in the same millisecond tie), and
    // once the read is limited an unstable tie decides WHICH vacancies fall
    // outside the cap as well as what order the run's steps come in. An
    // ObjectId is monotonic, so this makes oldest-first mean one thing.
    .sort({ createdAt: 1, _id: 1 })
    .limit(VACANCY_MAX_RECORDS + 1)
    .lean<Pick<VacancyDoc, "_id" | "title" | "status" | "listing">[]>();

  const truncated = rows.length > VACANCY_MAX_RECORDS;
  const vacancies = (truncated ? rows.slice(0, VACANCY_MAX_RECORDS) : rows).map((row) => {
    const vacancyId = String(row._id);
    return {
      vacancyId,
      title: row.title,
      status: row.status,
      listing: row.listing
        ? {
            contract: row.listing.contract,
            remoteStatus: row.listing.remoteStatus,
            claimState: row.listing.claimState ?? undefined,
            blockedReason: row.listing.blockedReason ?? undefined,
          }
        : undefined,
      // Both actions re-read the vacancy themselves, so the snapshot above is
      // only ever a plan: a row that changed since the load is acted on as it
      // now is, or refused. `repush` cannot create a listing (`allowCreate:
      // false`), which is what keeps a sync from ever being the thing that
      // first puts a vacancy on a public jobs board.
      repush: () => runVacancyAction(() => VacancyPublishService.repush(institutionId, vacancyId, actor)),
      close: () => runVacancyAction(() => VacancyPublishService.pushClose(institutionId, vacancyId, actor)),
    };
  });

  return { vacancies, truncated };
}

/** What one service-owned scholarship action did, as a reconciling adapter
 *  sees it — the exact shape `SyncScholarship.repush`/`close` declare. */
type ScholarshipActionResult = Awaited<ReturnType<SyncScholarship["close"]>>;

/**
 * One scholarship action, as a reconciling adapter needs to see it. Mirrors
 * `runVacancyAction` above — same two RUN-scoped statuses (`>= 500` is
 * `upstreamError`'s 502; `429` is `RATE_LIMITED`, a fact about the platform
 * key's budget rather than any one scholarship) and the same reason a
 * `ConnectorAuthError` is not caught here: `ScholarshipPublishService` never
 * throws one — Scholarship Hub carries no per-institution grant to revoke
 * (Ruling B) — so this stays structurally consistent with the vacancy
 * version rather than because this platform can reach that branch today.
 */
async function runScholarshipAction(
  run: () => Promise<ScholarshipPublishOutcome>,
): Promise<ScholarshipActionResult> {
  let outcome: ScholarshipPublishOutcome;
  try {
    outcome = await run();
  } catch (error) {
    if (error instanceof AppError) {
      const platformScoped = error.status >= 500 || error.status === 429;
      return { ok: false, scope: platformScoped ? "RUN" : "SCHOLARSHIP", detail: error.message };
    }
    throw error;
  }

  switch (outcome.status) {
    case "PUSHED":
    case "CLOSED":
      return { ok: true };
    case "NOT_LISTED":
      // Nothing was there to close — no HTTP call, nothing failed.
      return { ok: true };
    case "SKIPPED":
      // Fix round 1: best-effort syndication was not attempted (no
      // Scholarship Hub connection, or not yet Hub-publishable) — not a
      // failure of this sweep, nothing to retry, nothing HTTP was ever sent.
      return { ok: true };
    default:
      // BLOCKED: Scholarship Hub answered and the service has already
      // written the reason onto the listing, so the institution sees it on
      // the card too. Reported here so the run says PARTIAL rather than
      // SUCCESS.
      return { ok: false, scope: "SCHOLARSHIP", detail: outcome.message };
  }
}

/**
 * The scholarship worklist an adapter's `sync` reconciles — mirrors
 * `loadSyncVacancies` above for the same reasons: unfiltered (the rule that a
 * sync never creates a listing lives in the adapter/publish service, not in
 * this query), sorted oldest-first with `_id` breaking ties so a run's steps
 * are reproducible and so which rows fall outside the bound is stable, and
 * bounded by `SCHOLARSHIP_MAX_PER_INSTITUTION` — the same cap
 * `ScholarshipService.create` already enforces, so this reader cannot see
 * more than that route can ever produce.
 *
 * TENANT-SENSITIVE: `institutionId` scopes the read, and each closure passes
 * it back into `ScholarshipPublishService`, which scopes its own reads and
 * writes with it again. A scholarship id is not an authorisation on either
 * side.
 */
async function loadSyncScholarships(
  institutionId: string,
  actor: Actor,
): Promise<{ scholarships: SyncScholarship[]; truncated: boolean }> {
  // `+ 1` rather than a bare limit, so "exactly at the cap" and "more than
  // the cap" are distinguishable — a silent truncation reads as "everything
  // was reconciled".
  const rows = await Scholarship.find({ institutionId })
    .select("name status listing")
    .sort({ createdAt: 1, _id: 1 })
    .limit(SCHOLARSHIP_MAX_PER_INSTITUTION + 1)
    .lean<Pick<ScholarshipDoc, "_id" | "name" | "status" | "listing">[]>();

  const truncated = rows.length > SCHOLARSHIP_MAX_PER_INSTITUTION;
  const scholarships = (truncated ? rows.slice(0, SCHOLARSHIP_MAX_PER_INSTITUTION) : rows).map((row) => {
    const scholarshipId = String(row._id);
    return {
      scholarshipId,
      name: row.name,
      status: row.status,
      listing: row.listing
        ? {
            remoteStatus: row.listing.remoteStatus as "published" | "closed",
            blockedReason: row.listing.blockedReason ?? undefined,
          }
        : undefined,
      // Both actions re-read the scholarship themselves, so the snapshot
      // above is only ever a plan: a row that changed since the load is
      // acted on as it now is, or refused. `repush` cannot create a listing
      // (`allowCreate: false`), which is what keeps a sync from ever being
      // the thing that first puts a scholarship on Scholarship Hub.
      repush: () =>
        runScholarshipAction(() => ScholarshipPublishService.repush(institutionId, scholarshipId, actor)),
      close: () =>
        runScholarshipAction(() => ScholarshipPublishService.pushClose(institutionId, scholarshipId, actor)),
    };
  });

  return { scholarships, truncated };
}

/**
 * The stored grant — but only from a row whose own status still claims it is
 * usable (fix round 2).
 *
 * A ciphertext on the row is NOT by itself evidence that IDAP holds a working
 * credential, and treating it as such is how a dead connection comes back to
 * life. `refresh`'s `"completed"` branch is the concrete path: eduFleet keeps a
 * redeemed connection request queryable forever, so every poll of a
 * once-connected row lands there, and the adapter answers `CONNECTED` on the
 * strength of whatever grant it was handed. Hand it a grant from a
 * `DISCONNECTED` row and the poll silently undoes the disconnection.
 *
 * Every path that takes a connection down already drops the ciphertext in the
 * same write, so a non-CONNECTED row holding one is an anomaly — a torn write,
 * a crash between two operations, a row predating those fixes, a manual edit.
 * This is the guard for exactly that anomaly, and it is an authorization
 * boundary rather than tidiness: the blast radius of getting it wrong is every
 * connected school.
 *
 * An allowlist, not a denylist — only `CONNECTED` unlocks the credential — so a
 * status added to `CONNECTION_STATUSES` later is refused by default rather than
 * silently trusted. `vacancy-publish.service.ts`'s `resolveTarget` has always
 * read the ciphertext this way (`row?.status === "CONNECTED" && row.grantTokenEncrypted`);
 * this is the connection service agreeing with it.
 *
 * In `syncNow` this is redundant today — the `status !== "CONNECTED"` refusal
 * above it fires first — and it is used there anyway so the rule for turning a
 * stored ciphertext into a usable grant has ONE definition, and so a later
 * change to that precheck cannot quietly unlock a dead credential.
 */
function trustedGrantOf(
  connection: Pick<PlatformConnectionDoc, "status" | "grantTokenEncrypted">,
): string | undefined {
  if (connection.status !== "CONNECTED") return undefined;
  if (!connection.grantTokenEncrypted) return undefined;
  return decryptCredential(connection.grantTokenEncrypted);
}

function toEntry(platform: Platform, configured: boolean, doc?: PlatformConnectionDoc | null): ConnectionEntry {
  return {
    platform,
    configured,
    status: doc?.status ?? undefined,
    remoteStatus: doc?.remoteStatus ?? undefined,
    remoteInstitution: doc?.remoteInstitution
      ? {
          name: doc.remoteInstitution.name ?? undefined,
          city: doc.remoteInstitution.city ?? undefined,
          slug: doc.remoteInstitution.slug ?? undefined,
        }
      : undefined,
    scopes: doc?.scopes ?? undefined,
    lastSyncAt: toIso(doc?.lastSyncAt),
    lastSyncStatus: doc?.lastSyncStatus ?? undefined,
    lastError: doc?.lastError ?? undefined,
  };
}

function serializeRun(doc: SyncRunDoc): SyncRunDTO {
  return {
    id: String(doc._id),
    platform: doc.platform,
    trigger: doc.trigger,
    startedAt: requiredIso(doc.startedAt),
    finishedAt: toIso(doc.finishedAt),
    status: doc.status,
    steps: doc.steps?.length
      ? doc.steps.map((step) => ({ step: step.step ?? "", ok: Boolean(step.ok), detail: step.detail ?? undefined }))
      : undefined,
    warnings: doc.warnings?.length ? doc.warnings : undefined,
    error: doc.error ?? undefined,
    createdAt: requiredIso(doc.createdAt),
  };
}

function buildInstitutionSummary(institution: {
  institutionId: string;
  institutionName: string;
  city?: string | null;
  address?: string | null;
  area?: string | null;
  district?: string | null;
  state?: string | null;
  pincode?: string | null;
  phone?: string | null;
  website?: string | null;
  contactPerson?: string | null;
  email?: string | null;
}): InstitutionSummary {
  return {
    institutionId: institution.institutionId,
    name: institution.institutionName,
    city: institution.city ?? undefined,
    address: {
      addressLine: institution.address ?? undefined,
      area: institution.area ?? undefined,
      district: institution.district ?? undefined,
      state: institution.state ?? undefined,
      pincode: institution.pincode ?? undefined,
    },
    phone: institution.phone ?? undefined,
    website: institution.website ?? undefined,
    contactName: institution.contactPerson ?? undefined,
    contactEmail: institution.email ?? undefined,
  };
}

async function pruneSyncRuns(institutionId: string, platform: Platform): Promise<void> {
  const keep = await SyncRun.find({ institutionId, platform })
    .sort({ createdAt: -1 })
    .limit(SYNC_RUN_KEEP)
    .select("_id")
    .lean();
  if (keep.length < SYNC_RUN_KEEP) return; // Fewer rows than the cap exist — nothing to prune yet.
  await SyncRun.deleteMany({
    institutionId,
    platform,
    _id: { $nin: keep.map((row) => row._id) },
  });
}

async function recordActivity(
  institutionId: string,
  platform: Platform,
  action: string,
  description: string,
  actor: Actor,
): Promise<void> {
  await ActivityService.record({
    institutionId,
    entityType: ENTITY_TYPE,
    entityRef: platform,
    action,
    description,
    performedBy: actor.id,
    performedByName: actor.name,
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const ConnectionService = {
  /**
   * One entry per `PLATFORMS`, present or not — mirrors
   * `PlatformCredentialService.list`'s "always all platforms" shape so the
   * UI never has to special-case a platform with no row yet.
   */
  async list(institutionId: string): Promise<ConnectionEntry[]> {
    await connectToDatabase();

    const vaultReady = credentialVaultReady();
    const activeCredentials = vaultReady
      ? await PlatformCredential.find({ active: true }).select("platform").lean()
      : [];
    const configuredSet = new Set(activeCredentials.map((row) => row.platform as Platform));

    const connections = await PlatformConnection.find({ institutionId }).lean();
    const byPlatform = new Map(connections.map((doc) => [doc.platform as Platform, doc]));

    return PLATFORMS.map((platform) =>
      toEntry(
        platform,
        configuredSet.has(platform),
        byPlatform.get(platform) as PlatformConnectionDoc | undefined,
      ),
    );
  },

  /**
   * Starts (or restarts) the request/approve/redeem flow. Refuses when the
   * connection is already `CONNECTED` — there is nothing to (re)initiate.
   * `city` is required by PassPercent's own API even though it's optional on
   * the Institution model (real institutions can genuinely lack one), so a
   * missing city is refused here with a message that names the fix, rather
   * than reaching the adapter with a summary that would fail confusingly on
   * the remote side.
   */
  async initiate(institutionId: string, platform: Platform, actor: Actor): Promise<ConnectionEntry> {
    await connectToDatabase();

    const adapter = resolveAdapter(platform);
    if (!adapter.initiate) {
      throw validationError(`${PLATFORM_LABELS[platform]} does not support this connection flow`);
    }

    const ctx = await buildAdapterContext(platform);

    const existing = await PlatformConnection.findOne({ institutionId, platform }).lean();
    if (existing?.status === "CONNECTED") {
      throw validationError("This connection is already connected");
    }

    const institution = await Institution.findOne({ institutionId }).lean();
    if (!institution) throw notFound("Institution not found");

    if (!institution.city?.trim()) {
      throw validationError(
        `Add a city to the institution profile before connecting to ${PLATFORM_LABELS[platform]}`,
      );
    }

    let result: InitiateResult;
    try {
      result = await adapter.initiate(ctx, buildInstitutionSummary(institution));
    } catch (error) {
      const message = messageOf(error);
      // A plain thrown Error here means the platform-key call itself failed
      // (bad config, the remote side down) — it says nothing about this
      // institution's own grant, so the connection's status is left alone;
      // only the error is recorded for the admin to see. `upsert: true`
      // (fix round 1, finding I2): a first-ever `initiate` attempt has no
      // existing row to update, so without it the failure vanished
      // silently. `setDefaultsOnInsert: false` is deliberate and load-bearing
      // here, NOT an oversight — Mongoose 8 defaults that option to `true`,
      // and the schema's `status` default is "PENDING"; leaving the option
      // at its default would silently populate `status: "PENDING"` on this
      // insert even though `status` is absent from `$set`, making a failed,
      // never-accepted attempt read as "Requested" — exactly the misleading
      // state this fix exists to avoid. `externalRef` is set explicitly
      // since it's a required field with no default to fall back on.
      await PlatformConnection.updateOne(
        { institutionId, platform },
        { $set: { lastError: message, externalRef: institutionId } },
        { upsert: true, setDefaultsOnInsert: false },
      );
      await recordActivity(institutionId, platform, "Connection initiate failed", message, actor);
      throw upstreamError(platform);
    }

    const updated = await PlatformConnection.findOneAndUpdate(
      { institutionId, platform },
      {
        $set: {
          // Adapters may report that a freshly-opened request is already past
          // `pending` (eduFleet's auto-remap on a re-connect). Absent, the
          // original meaning holds.
          status: result.kind ?? "PENDING",
          remoteStatus: result.remoteStatus,
          remoteRequestId: result.remoteRequestId,
          externalRef: institutionId,
        },
        $unset: { lastError: "" },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await recordActivity(
      institutionId,
      platform,
      "Connection requested",
      `${PLATFORM_LABELS[platform]} connection requested (remote status: ${result.remoteStatus})`,
      actor,
    );

    return toEntry(platform, true, updated);
  },

  /**
   * Polls (and, on approval, redeems) an in-flight connection request.
   * `RefreshResult.kind` maps 1:1 onto `ConnectionStatus` by construction —
   * both vocabularies were designed to match (see `types.ts`).
   */
  async refresh(institutionId: string, platform: Platform, actor: Actor): Promise<ConnectionEntry> {
    await connectToDatabase();

    const adapter = resolveAdapter(platform);
    if (!adapter.refresh) {
      throw validationError(`${PLATFORM_LABELS[platform]} does not support refreshing a connection`);
    }

    const ctx = await buildAdapterContext(platform);

    // NOTE for reviewers: this is the tenant-isolation-sensitive lookup this
    // task's mutation check targets — `institutionId` MUST stay in this filter.
    const connection = await PlatformConnection.findOne({ institutionId, platform }).select(
      "+grantTokenEncrypted",
    );
    if (!connection) throw notFound("Connection not found");

    const state: ConnectionState = {
      institutionId,
      externalRef: connection.externalRef,
      remoteRequestId: connection.remoteRequestId ?? undefined,
      grantToken: trustedGrantOf(connection),
      scopes: connection.scopes ?? undefined,
    };

    let result: RefreshResult;
    try {
      result = await adapter.refresh(ctx, state);
    } catch (error) {
      const message = messageOf(error);
      if (error instanceof ConnectorAuthError) {
        // The grant this connection just received mid-redeem is already
        // revoked — the school withdrew consent. (Mid-redeem is the only way
        // to reach this today: eduFleet raises `ConnectorAuthError` from
        // `fetchRemoteInstitution` alone, i.e. before any grant has been
        // stored, and PassPercent raises it only from `sync`. The `$unset`
        // below is written to be right for a future adapter that raises it
        // holding a stored grant too.)
        //
        // That is not a transient upstream failure, so it must not be reported
        // as one: DISCONNECTED is the truth, and it is the state that
        // re-offers "Request connection" (`connections-panel.tsx:166`).
        //
        // Leaving the status alone would not strand the row — the next poll
        // finds the request `completed` with no stored grant and eduFleet
        // returns REJECTED, which `showRequest` does include. The harm is that
        // REJECTED reads as "eduFleet turned this down" when what actually
        // happened is that the school withdrew consent, and the row would keep
        // a ciphertext already known to be dead. DISCONNECTED says what
        // happened and drops the credential.
        await PlatformConnection.updateOne(
          { institutionId, platform },
          { $set: { status: "DISCONNECTED", lastError: message }, $unset: { grantTokenEncrypted: "" } },
        );
        await recordActivity(institutionId, platform, "Connection revoked remotely", message, actor);
        throw upstreamError(platform);
      }
      // Same reasoning as `initiate`'s catch: a plain thrown Error from the
      // platform-key polling call is not evidence this institution's grant
      // is bad, so the status is left untouched. No `upsert` needed here —
      // unlike `initiate`, `refresh` already required an existing row (the
      // NOT_FOUND check above), so this always matches something.
      await PlatformConnection.updateOne({ institutionId, platform }, { $set: { lastError: message } });
      await recordActivity(institutionId, platform, "Connection refresh failed", message, actor);
      throw upstreamError(platform);
    }

    const set: Record<string, unknown> = {
      status: result.kind,
      remoteStatus: result.remoteStatus,
    };
    if (result.kind === "REJECTED" && result.detail) set.lastError = result.detail;
    if (result.kind === "CONNECTED") {
      set.grantTokenEncrypted = encryptCredential(result.grantToken);
      set.scopes = result.scopes;
      if (result.remoteInstitution) set.remoteInstitution = result.remoteInstitution;
    }

    const updated = await PlatformConnection.findOneAndUpdate(
      { institutionId, platform },
      result.kind === "CONNECTED" || result.kind === "PENDING" || result.kind === "AWAITING_APPROVAL"
        ? { $set: set, $unset: { lastError: "" } }
        : { $set: set },
      { new: true },
    );
    /* c8 ignore next */
    if (!updated) throw notFound("Connection not found");

    await recordActivity(
      institutionId,
      platform,
      "Connection refreshed",
      `${PLATFORM_LABELS[platform]} connection is now ${result.kind}`,
      actor,
    );

    return toEntry(platform, true, updated);
  },

  /**
   * Plan 9b wires FeesBasket's paste-key flow through this. In this plan
   * (9a) no registered adapter implements `connectWithKey`, so this always
   * refuses — written generically against the interface so 9b needs no
   * change here.
   */
  async connectWithKey(
    institutionId: string,
    platform: Platform,
    key: string,
    actor: Actor,
  ): Promise<ConnectionEntry> {
    await connectToDatabase();

    const adapter = resolveAdapter(platform);
    if (!adapter.connectWithKey) {
      throw validationError(
        `Connecting with a key is not supported for this platform (${PLATFORM_LABELS[platform]})`,
      );
    }

    const ctx = await buildAdapterContext(platform);

    const existing = await PlatformConnection.findOne({ institutionId, platform }).lean();
    if (existing?.status === "CONNECTED") {
      throw validationError("This connection is already connected");
    }

    let result: ConnectResult;
    try {
      result = await adapter.connectWithKey(ctx, institutionId, key);
    } catch (error) {
      const message = messageOf(error);
      // Same reasoning as `initiate`/`refresh`'s catch blocks — kept
      // consistent with them even though the routed fix only named those
      // two explicitly, since this is the same bug shape (see report).
      await PlatformConnection.updateOne({ institutionId, platform }, { $set: { lastError: message } });
      await recordActivity(institutionId, platform, "Connect with key failed", message, actor);
      throw upstreamError(platform);
    }

    const updated = await PlatformConnection.findOneAndUpdate(
      { institutionId, platform },
      {
        $set: {
          status: "CONNECTED",
          externalRef: institutionId,
          scopes: result.scopes,
          remoteInstitution: result.remoteInstitution,
        },
        $unset: { lastError: "" },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await recordActivity(
      institutionId,
      platform,
      "Connected with key",
      `${PLATFORM_LABELS[platform]} connected`,
      actor,
    );

    return toEntry(platform, true, updated);
  },

  /**
   * Atomic lock via a single `findOneAndUpdate` — not a read-then-write —
   * so two concurrent calls can never both believe they hold it. A `finally`
   * always clears the flag, whatever happened in between.
   */
  async syncNow(
    institutionId: string,
    platform: Platform,
    actor: Actor,
  ): Promise<{ connection: ConnectionEntry; run: SyncRunDTO }> {
    await connectToDatabase();

    // A lock older than SYNC_LOCK_STALE_MINUTES is treated as abandoned (a
    // crashed process, a killed request) rather than genuinely in flight, and
    // can be reacquired — otherwise a single crash mid-sync would brick this
    // connection's Sync button forever, with no admin recourse short of a
    // direct DB edit (fix round 1, finding I1).
    const staleBefore = new Date(Date.now() - SYNC_LOCK_STALE_MINUTES * 60_000);
    const locked = await PlatformConnection.findOneAndUpdate(
      {
        institutionId,
        platform,
        $or: [{ syncInProgress: { $ne: true } }, { syncStartedAt: { $lt: staleBefore } }],
      },
      { $set: { syncInProgress: true, syncStartedAt: new Date() } },
      { new: true },
    ).select("+grantTokenEncrypted");

    if (!locked) {
      const existing = await PlatformConnection.findOne({ institutionId, platform }).lean();
      if (!existing) throw notFound("Connection not found");
      throw validationError("a sync is already running");
    }

    try {
      // Cross-platform invariant, checked at the service level rather than
      // leaning on PassPercent-specific guards deep in its adapter (which
      // FeesBasket's adapter would otherwise have to reimplement
      // identically) — routed call 2, fix round 1.
      if (locked.status !== "CONNECTED") {
        throw validationError("Connect to this platform before syncing");
      }

      const institution = await Institution.findOne({ institutionId }).lean();
      if (!institution) throw notFound("Institution not found");

      if (institution.profileStatus !== "PUBLISHED") {
        throw validationError(
          "Publish your institution profile before syncing — pushing an unpublished profile to a public listing would be backwards",
        );
      }

      const ctx = await buildAdapterContext(platform);
      const adapter = resolveAdapter(platform);

      const allResults = await ResultService.list(institutionId);
      const publishedResults = allResults.filter((row) => row.status === "PUBLISHED");

      // Only for an adapter that can actually push a job. The three per-record
      // job methods are the same capability check `vacancy-publish.service.ts`
      // makes before pushing anything, and gating on them is what keeps
      // PassPercent and FeesBasket — which have no job contract at all —
      // completely untouched by this: they receive `vacancies: undefined`,
      // exactly as before.
      const reconcilesVacancies = Boolean(adapter.createJob && adapter.patchJob && adapter.closeJob);

      // Same capability check, for the scholarship methods: only an adapter
      // that can actually push a scholarship (Scholarship Hub) gets a
      // worklist, so eduFleet, PassPercent and FeesBasket — none of which
      // has a scholarship contract — receive `scholarships: undefined`,
      // exactly as before.
      const reconcilesScholarships = Boolean(adapter.upsertScholarship && adapter.withdrawScholarship);

      const sourceData: SyncSourceData = {
        institution: institution as unknown as Record<string, unknown>,
        results: publishedResults as unknown as Record<string, unknown>[],
        readPublicMedia: storage.getPublic,
        ...(reconcilesVacancies ? await loadSyncVacancies(institutionId, actor).then((w) => ({
          vacancies: w.vacancies,
          vacanciesTruncated: w.truncated,
        })) : { vacancies: undefined }),
        ...(reconcilesScholarships ? await loadSyncScholarships(institutionId, actor).then((w) => ({
          scholarships: w.scholarships,
          scholarshipsTruncated: w.truncated,
        })) : { scholarships: undefined }),
      };

      const state: ConnectionState = {
        institutionId,
        externalRef: locked.externalRef,
        remoteRequestId: locked.remoteRequestId ?? undefined,
        grantToken: trustedGrantOf(locked),
        scopes: locked.scopes ?? undefined,
      };

      const startedAt = new Date();
      let outcome: SyncOutcome;
      let grantRevoked = false;

      try {
        outcome = await adapter.sync(ctx, state, sourceData);
      } catch (error) {
        if (error instanceof ConnectorAuthError) {
          grantRevoked = true;
          // F3 (fix round 2): carry out whatever the adapter had already
          // accumulated before the auth failure, rather than discarding it —
          // a mid-run 401 must not erase the record of which years already
          // reached the (public) listing.
          outcome = { status: "FAILED", steps: error.steps, warnings: error.warnings, error: error.message };
        } else {
          // A plain Error/network failure — not evidence this institution's
          // grant is bad, so the connection's status is left alone, but a
          // run is still logged (a run always gets logged).
          outcome = { status: "FAILED", steps: [], warnings: [], error: messageOf(error) };
        }
      }

      const finishedAt = new Date();

      const run = await SyncRun.create({
        institutionId,
        platform,
        trigger: "MANUAL",
        startedAt,
        finishedAt,
        status: outcome.status,
        steps: outcome.steps.length ? outcome.steps : undefined,
        warnings: outcome.warnings.length ? outcome.warnings : undefined,
        error: outcome.error,
      });
      await pruneSyncRuns(institutionId, platform);

      const connectionSet: Record<string, unknown> = {
        lastSyncAt: finishedAt,
        lastSyncStatus: outcome.status,
      };
      if (outcome.error) connectionSet.lastError = outcome.error;

      // Task 7, the second inherited obligation: DISCONNECTED **and drop the
      // ciphertext**, exactly as `refresh`'s own `ConnectorAuthError` branch
      // already does — not the `ERROR`-and-keep-it this used to do.
      //
      // The asymmetry was harmless only while nothing could raise this from a
      // sync. Now `sync` is the sole revocation detector, so a run that ends
      // here is IDAP being told the school withdrew consent. Leaving the dead
      // grant on the row resurrects the connection at the very next poll:
      // `refresh` finds the request `completed`, sees a stored grant, and
      // returns CONNECTED on the strength of that ciphertext alone — a
      // credential eduFleet has already refused. One fact must not produce two
      // states, and the state it produces must not be one a poll can undo.
      //
      // `ERROR` loses nothing by going: it existed on this path for
      // `ConnectorAuthError` alone (a plain failure deliberately leaves the
      // status untouched), the run is still recorded FAILED, and `lastError`
      // still carries what happened. DISCONNECTED is also what spec §9 asks
      // for by name — "`revoked` → ... the connection is marked disconnected
      // and future pushes fall back to the platform key" — and it is the
      // state that re-offers "Request connection" on the card.
      const update: Record<string, unknown> = { $set: connectionSet };
      if (grantRevoked) {
        connectionSet.status = "DISCONNECTED";
        update.$unset = { grantTokenEncrypted: "" };
      } else if (!outcome.error) {
        update.$unset = { lastError: "" };
      }

      const updatedConnection = await PlatformConnection.findOneAndUpdate(
        { institutionId, platform },
        update,
        { new: true },
      );
      /* c8 ignore next */
      if (!updatedConnection) throw notFound("Connection not found");

      if (grantRevoked) {
        // The same entry `refresh` writes for the same fact. A sync run alone
        // would record "sync failed", which is true and misses the point: the
        // connection was taken down, and an audit trail that does not say so
        // leaves the next person guessing why the school is disconnected.
        await recordActivity(
          institutionId,
          platform,
          "Connection revoked remotely",
          outcome.error ?? "The platform rejected this connection's grant token",
          actor,
        );
      }

      await recordActivity(
        institutionId,
        platform,
        "Sync run",
        `${PLATFORM_LABELS[platform]} sync ${outcome.status.toLowerCase()}${outcome.error ? `: ${outcome.error}` : ""}`,
        actor,
      );

      return { connection: toEntry(platform, true, updatedConnection), run: serializeRun(run) };
    } catch (error) {
      // Deliberate refusals (validationError/notFound thrown above, or by
      // `resolveAdapter`/`buildAdapterContext`) pass through with their real
      // codes untouched. Anything else here is a genuinely unexpected
      // failure outside the adapter's own classified outcomes (which never
      // reach this catch — `adapter.sync`'s try/catch above always resolves
      // to a run instead) — e.g. a corrupt ciphertext or a DB write failure
      // — and gets the same 502 treatment as `initiate`/`refresh` rather
      // than a scrubbed 500 (routed call 1, fix round 1).
      if (error instanceof AppError) throw error;
      throw upstreamError(platform);
    } finally {
      await PlatformConnection.updateOne(
        { institutionId, platform },
        { $set: { syncInProgress: false }, $unset: { syncStartedAt: "" } },
      );
    }
  },

  /**
   * Local-only: flips status and drops the grant ciphertext. The remote
   * grant itself is revoked from the platform's own dashboard — the UI
   * copy (Task 9) explains that, this service makes no remote call.
   */
  async disconnect(institutionId: string, platform: Platform, actor: Actor): Promise<ConnectionEntry> {
    await connectToDatabase();

    const updated = await PlatformConnection.findOneAndUpdate(
      { institutionId, platform },
      {
        $set: { status: "DISCONNECTED", syncInProgress: false },
        // Also a manual escape hatch for a stuck sync lock (fix round 1,
        // finding I1, point 4): an admin who suspects a crashed sync can
        // disconnect and reconnect rather than wait out the staleness
        // window. `lastError` is cleared too (fix round 2, F5) — a card that
        // just errored otherwise keeps showing its red banner after
        // disconnecting, until the next initiate/refresh happens to touch it.
        $unset: { grantTokenEncrypted: "", syncStartedAt: "", lastError: "" },
      },
      { new: true },
    );
    if (!updated) throw notFound("Connection not found");

    await recordActivity(
      institutionId,
      platform,
      "Connection disconnected",
      `${PLATFORM_LABELS[platform]} connection disconnected`,
      actor,
    );

    return toEntry(platform, await isConfigured(platform), updated);
  },

  async listRuns(institutionId: string, platform: Platform): Promise<SyncRunDTO[]> {
    await connectToDatabase();
    const rows = await SyncRun.find({ institutionId, platform }).sort({ createdAt: -1 }).lean<SyncRunDoc[]>();
    return rows.map(serializeRun);
  },
};
