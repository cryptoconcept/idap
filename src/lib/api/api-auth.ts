import "server-only";
import type { NextRequest } from "next/server";
import { connectToDatabase } from "@/lib/db/mongoose";
import { ApiClient, Institution } from "@/models";
import { verifySecret } from "@/lib/security/tokens";
import { AppError, forbidden, unauthorized } from "@/lib/api/errors";
import type { ApiPermission } from "@/lib/constants";

export type ApiAuthContext = {
  clientId: string;
  clientName: string;
  keyId: string;
  institutionId: string;
  institutionName: string;
  permissions: ApiPermission[];
};

type Credentials = { keyId: string; secret: string };

/**
 * Two accepted credential shapes:
 *   Authorization: Bearer <keyId>.<secret>
 *   X-API-KEY: <keyId> + X-API-SECRET: <secret>
 */
function readCredentials(request: NextRequest): Credentials | null {
  const headerKey = request.headers.get("x-api-key");
  const headerSecret = request.headers.get("x-api-secret");
  if (headerKey && headerSecret) {
    return { keyId: headerKey.trim(), secret: headerSecret.trim() };
  }

  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    const separator = token.indexOf(".");
    if (separator > 0) {
      return { keyId: token.slice(0, separator), secret: token.slice(separator + 1) };
    }
  }

  return null;
}

/**
 * Authenticates an external API caller and derives the tenant from the
 * credential itself. A body-supplied institutionId is never consulted.
 */
export async function authenticateApiClient(
  request: NextRequest,
  requiredPermission: ApiPermission,
): Promise<ApiAuthContext> {
  const credentials = readCredentials(request);
  if (!credentials?.keyId || !credentials.secret) {
    throw unauthorized(
      "Missing API credentials. Send `Authorization: Bearer <keyId>.<secret>` or the X-API-KEY / X-API-SECRET headers.",
    );
  }

  await connectToDatabase();
  const client = await ApiClient.findOne({ keyId: credentials.keyId })
    .select("+secretHash")
    .lean();

  if (!client || !verifySecret(credentials.secret, client.secretHash)) {
    throw unauthorized("Invalid API credentials");
  }

  if (!client.active || client.revokedAt) {
    throw forbidden("These API credentials have been revoked");
  }

  if (!client.permissions?.includes(requiredPermission)) {
    throw forbidden(`This API key is not permitted to perform ${requiredPermission}`);
  }

  const institution = await Institution.findOne({ institutionId: client.institutionId })
    .select("institutionId institutionName active")
    .lean();

  if (!institution) throw forbidden("Institution not found for these credentials");
  if (!institution.active) {
    throw new AppError("INACTIVE_INSTITUTION", "This institution account is currently inactive");
  }

  // Usage tracking must never fail the request it is measuring.
  void ApiClient.updateOne(
    { _id: client._id },
    { $set: { lastUsedAt: new Date() }, $inc: { requestCount: 1 } },
  ).catch(() => undefined);

  return {
    clientId: String(client._id),
    clientName: client.name,
    keyId: client.keyId,
    institutionId: client.institutionId,
    institutionName: institution.institutionName,
    permissions: (client.permissions ?? []) as ApiPermission[],
  };
}
