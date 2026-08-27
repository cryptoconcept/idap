import "server-only";
import { connectToDatabase } from "@/lib/db/mongoose";
import { PlatformCredential, type PlatformCredentialDoc } from "@/models";
import {
  credentialVaultReady,
  decryptCredential,
  encryptCredential,
} from "@/lib/security/credentials";
import { PLATFORMS, PLATFORM_LABELS, type Platform } from "@/lib/constants";
import { notFound, validationError } from "@/lib/api/errors";
import { requiredIso } from "@/lib/utils/serialize";
import { ActivityService } from "./activity.service";

/**
 * Platform credentials are not scoped to a tenant — they belong to the
 * platform itself — so Activity entries for them use this sentinel rather
 * than a real `institutionId`.
 */
const PLATFORM_SCOPE = "PLATFORM";
const ENTITY_TYPE = "PLATFORM_CREDENTIAL";

export type PlatformCredentialDTO = {
  platform: Platform;
  baseUrl: string | null;
  active: boolean;
  /** Last 4 characters of the decrypted key, prefixed with "…". Never the key or its ciphertext. */
  keyMasked: string | null;
  updatedAt: string | null;
};

export type PlatformCredentialListResult = {
  vaultReady: boolean;
  credentials: PlatformCredentialDTO[];
};

/** Never log or return anything but this — the last 4 characters, masked. */
function mask(plaintext: string): string {
  return `…${plaintext.slice(-4)}`;
}

/** Best-effort mask: a row whose ciphertext fails to decrypt reads as unavailable, not as a crash. */
function tryMask(keyEncrypted: string): string | null {
  try {
    return mask(decryptCredential(keyEncrypted));
  } catch {
    return null;
  }
}

function emptyRow(platform: Platform): PlatformCredentialDTO {
  return { platform, baseUrl: null, active: false, keyMasked: null, updatedAt: null };
}

export const PlatformCredentialService = {
  /**
   * Always returns one entry per `PLATFORMS`, present or not. When the vault
   * is not configured, every `keyMasked` is `null` and `vaultReady` is
   * `false` rather than throwing — the admin page degrades with an
   * explanation instead of crashing.
   */
  async list(): Promise<PlatformCredentialListResult> {
    await connectToDatabase();
    const vaultReady = credentialVaultReady();

    const rows = vaultReady
      ? await PlatformCredential.find().select("+keyEncrypted").lean()
      : await PlatformCredential.find().lean();
    const byPlatform = new Map(rows.map((row) => [row.platform as Platform, row]));

    const credentials = PLATFORMS.map((platform): PlatformCredentialDTO => {
      const row = byPlatform.get(platform);
      if (!row) return emptyRow(platform);

      return {
        platform,
        baseUrl: row.baseUrl,
        active: Boolean(row.active),
        keyMasked: vaultReady
          ? tryMask((row as PlatformCredentialDoc).keyEncrypted)
          : null,
        updatedAt: requiredIso(row.updatedAt),
      };
    });

    return { vaultReady, credentials };
  },

  /**
   * Creates or updates a platform's credential. `key` is optional: when it is
   * omitted, the existing ciphertext is carried forward untouched so that
   * editing the base URL or the active flag can never silently destroy the
   * stored secret. A brand-new credential must supply a key.
   */
  async upsert(
    platform: Platform,
    input: { key?: string; baseUrl: string; active?: boolean },
    actor: { id: string; name: string },
  ): Promise<PlatformCredentialDTO> {
    await connectToDatabase();

    const existing = await PlatformCredential.findOne({ platform }).select("+keyEncrypted");
    if (!existing && input.key === undefined) {
      throw validationError("A key is required to connect this platform for the first time");
    }
    if (input.key !== undefined && !credentialVaultReady()) {
      throw validationError(
        "IDAP_CREDENTIAL_KEY must be set before a platform key can be saved",
      );
    }

    const keyEncrypted = input.key !== undefined ? encryptCredential(input.key) : existing!.keyEncrypted;
    const active = input.active ?? existing?.active ?? true;

    const updated = await PlatformCredential.findOneAndUpdate(
      { platform },
      { $set: { baseUrl: input.baseUrl, active, keyEncrypted } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).select("+keyEncrypted");
    /* c8 ignore next */
    if (!updated) throw notFound("Platform credential not found");

    await ActivityService.record({
      institutionId: PLATFORM_SCOPE,
      entityType: ENTITY_TYPE,
      entityRef: platform,
      action: existing ? "Platform credential updated" : "Platform credential created",
      description: `${PLATFORM_LABELS[platform]} credential ${existing ? "updated" : "connected"} — base URL ${input.baseUrl}`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return {
      platform,
      baseUrl: updated.baseUrl,
      active: Boolean(updated.active),
      keyMasked: credentialVaultReady() ? tryMask(updated.keyEncrypted) : null,
      updatedAt: requiredIso(updated.updatedAt),
    };
  },

  async remove(platform: Platform, actor: { id: string; name: string }): Promise<void> {
    await connectToDatabase();
    const deleted = await PlatformCredential.findOneAndDelete({ platform }).lean();
    if (!deleted) throw notFound("Platform credential not found");

    await ActivityService.record({
      institutionId: PLATFORM_SCOPE,
      entityType: ENTITY_TYPE,
      entityRef: platform,
      action: "Platform credential removed",
      description: `${PLATFORM_LABELS[platform]} credential removed`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },
};
