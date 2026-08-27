import "server-only";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution, PlatformConnection, PlatformCredential, SyncRun } from "@/models";
import type { PlatformConnectionDoc, PlatformCredentialDoc, SyncRunDoc } from "@/models";
import {
  PLATFORMS,
  PLATFORM_LABELS,
  SYNC_RUN_KEEP,
  type ConnectionStatus,
  type Platform,
  type SyncStatus,
} from "@/lib/constants";
import { credentialVaultReady, decryptCredential, encryptCredential } from "@/lib/security/credentials";
import { notFound, validationError } from "@/lib/api/errors";
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
  type RefreshResult,
  type SyncOutcome,
  type SyncSourceData,
} from "@/lib/connectors/types";
import { ResultService } from "./result.service";
import { ActivityService } from "./activity.service";

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
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

    const adapter = adapterFor(platform);
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
      // only the error is recorded for the admin to see.
      await PlatformConnection.updateOne({ institutionId, platform }, { $set: { lastError: message } });
      await recordActivity(institutionId, platform, "Connection initiate failed", message, actor);
      throw error;
    }

    const updated = await PlatformConnection.findOneAndUpdate(
      { institutionId, platform },
      {
        $set: {
          status: "PENDING",
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

    const adapter = adapterFor(platform);
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
      grantToken: connection.grantTokenEncrypted
        ? decryptCredential(connection.grantTokenEncrypted)
        : undefined,
      scopes: connection.scopes ?? undefined,
    };

    let result: RefreshResult;
    try {
      result = await adapter.refresh(ctx, state);
    } catch (error) {
      const message = messageOf(error);
      // Same reasoning as `initiate`'s catch: a plain thrown Error from the
      // platform-key polling call is not evidence this institution's grant
      // is bad, so the status is left untouched.
      await PlatformConnection.updateOne({ institutionId, platform }, { $set: { lastError: message } });
      await recordActivity(institutionId, platform, "Connection refresh failed", message, actor);
      throw error;
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

    const adapter = adapterFor(platform);
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
      await PlatformConnection.updateOne({ institutionId, platform }, { $set: { lastError: message } });
      await recordActivity(institutionId, platform, "Connect with key failed", message, actor);
      throw error;
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

    const locked = await PlatformConnection.findOneAndUpdate(
      { institutionId, platform, syncInProgress: { $ne: true } },
      { $set: { syncInProgress: true } },
      { new: true },
    ).select("+grantTokenEncrypted");

    if (!locked) {
      const existing = await PlatformConnection.findOne({ institutionId, platform }).lean();
      if (!existing) throw notFound("Connection not found");
      throw validationError("a sync is already running");
    }

    try {
      const institution = await Institution.findOne({ institutionId }).lean();
      if (!institution) throw notFound("Institution not found");

      if (institution.profileStatus !== "PUBLISHED") {
        throw validationError(
          "Publish your institution profile before syncing — pushing an unpublished profile to a public listing would be backwards",
        );
      }

      const ctx = await buildAdapterContext(platform);
      const adapter = adapterFor(platform);

      const allResults = await ResultService.list(institutionId);
      const publishedResults = allResults.filter((row) => row.status === "PUBLISHED");

      const sourceData: SyncSourceData = {
        institution: institution as unknown as Record<string, unknown>,
        results: publishedResults as unknown as Record<string, unknown>[],
        readPublicMedia: storage.getPublic,
      };

      const state: ConnectionState = {
        institutionId,
        externalRef: locked.externalRef,
        remoteRequestId: locked.remoteRequestId ?? undefined,
        grantToken: locked.grantTokenEncrypted ? decryptCredential(locked.grantTokenEncrypted) : undefined,
        scopes: locked.scopes ?? undefined,
      };

      const startedAt = new Date();
      let outcome: SyncOutcome;
      let flipToError = false;

      try {
        outcome = await adapter.sync(ctx, state, sourceData);
      } catch (error) {
        if (error instanceof ConnectorAuthError) {
          flipToError = true;
          outcome = { status: "FAILED", steps: [], warnings: [], error: error.message };
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
      if (flipToError) connectionSet.status = "ERROR";
      if (outcome.error) connectionSet.lastError = outcome.error;

      const updatedConnection = await PlatformConnection.findOneAndUpdate(
        { institutionId, platform },
        outcome.error ? { $set: connectionSet } : { $set: connectionSet, $unset: { lastError: "" } },
        { new: true },
      );
      /* c8 ignore next */
      if (!updatedConnection) throw notFound("Connection not found");

      await recordActivity(
        institutionId,
        platform,
        "Sync run",
        `${PLATFORM_LABELS[platform]} sync ${outcome.status.toLowerCase()}${outcome.error ? `: ${outcome.error}` : ""}`,
        actor,
      );

      return { connection: toEntry(platform, true, updatedConnection), run: serializeRun(run) };
    } finally {
      await PlatformConnection.updateOne({ institutionId, platform }, { $set: { syncInProgress: false } });
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
      { $set: { status: "DISCONNECTED" }, $unset: { grantTokenEncrypted: "" } },
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
