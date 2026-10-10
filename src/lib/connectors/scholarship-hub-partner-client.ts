import "server-only";
import { PlatformCredential } from "@/models";
import type { PlatformCredentialDoc } from "@/models";
import { credentialVaultReady, decryptCredential } from "@/lib/security/credentials";
import { createConnectorHttp } from "@/lib/connectors/http";
import type { ConnectorHttp } from "@/lib/connectors/http";
import { notFound } from "@/lib/api/errors";

const PLATFORM = "SCHOLARSHIP_HUB" as const;

export type ScholarshipHubPartnerContext = {
  baseUrl: string;
  platformKey: string;
  http: ConnectorHttp;
};

/**
 * Loads and decrypts the Scholarship Hub platform credential — the same
 * `sh_pkey_...` key Phase 1's outbound connector already uses, now also
 * what sync-back's pull (Task 4) and document proxy (Task 6) authenticate
 * with. 404s (not 500) when unconfigured, mirroring
 * `scholarship-publish.service.ts`'s own `buildContext`.
 */
export async function loadScholarshipHubPartnerContext(): Promise<ScholarshipHubPartnerContext> {
  if (!credentialVaultReady()) throw notFound("Scholarship Hub is not configured");
  const credential = await PlatformCredential.findOne({ platform: PLATFORM, active: true })
    .select("+keyEncrypted")
    .lean();
  if (!credential) throw notFound("Scholarship Hub is not configured");
  const baseUrl = credential.baseUrl;
  return {
    baseUrl,
    platformKey: decryptCredential((credential as PlatformCredentialDoc).keyEncrypted),
    http: createConnectorHttp(baseUrl),
  };
}

/**
 * The webhook signing secret, decrypted — platform-wide (Contract 1), like
 * the partner key itself. Returns null (not throw) when unset, since a
 * fresh deploy may not have registered a webhook yet — Task 5's receiver
 * decides whether that's fatal for a given request.
 */
export async function loadScholarshipHubWebhookSecret(): Promise<string | null> {
  if (!credentialVaultReady()) return null;
  const credential = await PlatformCredential.findOne({ platform: PLATFORM, active: true })
    .select("+webhookSecretEncrypted")
    .lean();
  const encrypted = (
    credential as (PlatformCredentialDoc & { webhookSecretEncrypted?: string }) | null
  )?.webhookSecretEncrypted;
  if (!encrypted) return null;
  return decryptCredential(encrypted);
}

/**
 * Streams one partner-scoped document's raw bytes from the Hub. Deliberately
 * NOT built on `ConnectorHttp` — that type always JSON-parses the response
 * body (`createConnectorHttp`'s `parseBody` does `JSON.parse` then falls
 * back to text), which would corrupt binary file bytes. This does a plain
 * authenticated `fetch` and hands back the raw `Response` so Task 6 can
 * stream its `.body` through untouched.
 */
export async function fetchScholarshipHubDocument(
  hubApplicationId: string,
  documentKey: string,
): Promise<Response> {
  const ctx = await loadScholarshipHubPartnerContext();
  const url = `${ctx.baseUrl.replace(/\/+$/, "")}/api/partner/applications/${encodeURIComponent(hubApplicationId)}/documents/${encodeURIComponent(documentKey)}/file`;
  return fetch(url, { headers: { Authorization: `Bearer ${ctx.platformKey}` } });
}
