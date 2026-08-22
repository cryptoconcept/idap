import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { ApiClient, Institution, type ApiClientDoc } from "@/models";
import { ActivityService } from "./activity.service";
import { generateKeyId, generateSecret, hashSecret } from "@/lib/security/tokens";
import { notFound } from "@/lib/api/errors";
import { requiredIso, toIso } from "@/lib/utils/serialize";
import type { ApiClientDTO } from "@/lib/types";
import type { ApiPermission } from "@/lib/constants";

function serialize(row: ApiClientDoc, institutionName?: string): ApiClientDTO {
  return {
    id: String(row._id),
    institutionId: row.institutionId,
    institutionName,
    name: row.name,
    keyId: row.keyId,
    active: Boolean(row.active) && !row.revokedAt,
    permissions: (row.permissions ?? []) as ApiPermission[],
    lastUsedAt: toIso(row.lastUsedAt),
    requestCount: row.requestCount ?? 0,
    createdAt: requiredIso(row.createdAt),
    revokedAt: toIso(row.revokedAt),
  };
}

export const ApiClientService = {
  /**
   * Creates a credential pair. The plaintext secret is returned exactly once —
   * only its HMAC is stored, so it can never be recovered afterwards.
   */
  async create(input: {
    institutionId: string;
    name: string;
    permissions: ApiPermission[];
    actor: { id: string; name: string };
  }): Promise<{ client: ApiClientDTO; keyId: string; secret: string; bearerToken: string }> {
    await connectToDatabase();
    const keyId = generateKeyId();
    const secret = generateSecret();

    const created = await ApiClient.create({
      institutionId: input.institutionId,
      name: input.name,
      keyId,
      secretHash: hashSecret(secret),
      active: true,
      permissions: input.permissions,
      createdBy: new Types.ObjectId(input.actor.id),
    });

    await ActivityService.record({
      institutionId: input.institutionId,
      entityType: "API_CLIENT",
      entityId: created._id,
      entityRef: keyId,
      action: "API key created",
      description: `API key "${input.name}" created`,
      performedBy: input.actor.id,
      performedByName: input.actor.name,
    });

    return {
      client: serialize(created.toObject() as ApiClientDoc),
      keyId,
      secret,
      bearerToken: `${keyId}.${secret}`,
    };
  },

  async list(tenantClause: Record<string, unknown>): Promise<ApiClientDTO[]> {
    await connectToDatabase();
    const rows = await ApiClient.find(tenantClause).sort({ createdAt: -1 }).lean();
    const ids = [...new Set(rows.map((row) => row.institutionId))];
    const institutions = ids.length
      ? await Institution.find({ institutionId: { $in: ids } })
          .select("institutionId institutionName")
          .lean()
      : [];
    const names = new Map(institutions.map((row) => [row.institutionId, row.institutionName]));
    return rows.map((row) => serialize(row as ApiClientDoc, names.get(row.institutionId)));
  },

  async revoke(input: {
    tenantClause: Record<string, unknown>;
    id: string;
    actor: { id: string; name: string };
  }): Promise<ApiClientDTO> {
    await connectToDatabase();
    if (!Types.ObjectId.isValid(input.id)) throw notFound("API key not found");

    const updated = await ApiClient.findOneAndUpdate(
      { _id: new Types.ObjectId(input.id), ...input.tenantClause },
      { $set: { active: false, revokedAt: new Date() } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("API key not found");

    await ActivityService.record({
      institutionId: updated.institutionId,
      entityType: "API_CLIENT",
      entityId: updated._id,
      entityRef: updated.keyId,
      action: "API key revoked",
      description: `API key "${updated.name}" revoked`,
      performedBy: input.actor.id,
      performedByName: input.actor.name,
    });

    return serialize(updated as ApiClientDoc);
  },
};
