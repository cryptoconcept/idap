import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { loadScholarshipHubWebhookSecret } from "@/lib/connectors/scholarship-hub-partner-client";
import { runReconciliationPull } from "@/services/scholarship-application-sync.service";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { jsonError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RATE_LIMIT = { limit: 60, windowSeconds: 60 };
/** How far a signature's timestamp may drift from "now" before it's treated as a replay. */
const SIGNATURE_WINDOW_SECONDS = 300;
const MAX_BODY_BYTES = 10_000;

const webhookPayloadSchema = z.object({
  event: z.literal("application.changed"),
  externalRef: z.string(),
  hubApplicationId: z.string(),
  changedAt: z.string(),
});

/**
 * Verifies against `${timestampHeader}.${rawBody}` (Stripe-style) — NOT the
 * raw body alone. The timestamp value is the literal `X-SH-Timestamp`
 * header string, taken as-is (not re-formatted), concatenated with a `.`
 * then the exact raw body text — not a re-`JSON.stringify`d one, which
 * could differ in whitespace/key order from what was actually signed.
 * Covering the timestamp in the signature is what makes the replay window
 * below meaningful: a captured valid signature can no longer be replayed
 * with a fresh `X-SH-Timestamp`, because changing the timestamp changes
 * what the signature must cover.
 *
 * Mirrors `verifySecret`'s (`src/lib/security/tokens.ts`)
 * length-check-before-`timingSafeEqual` shape: `timingSafeEqual` throws on
 * unequal-length buffers, so the length check must come first.
 */
function verifySignature(rawBody: string, timestampHeader: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const signedPayload = `${timestampHeader}.${rawBody}`;
  const expectedHex = createHmac("sha256", secret).update(signedPayload).digest("hex");
  const candidate = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (candidate.length === 0 || candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/**
 * IDAP's first externally-reachable inbound POST receiver. Order of checks
 * is deliberate: rate limit and body-size cap first (cheap, protects
 * against flooding before any crypto work), THEN signature — which now
 * requires the raw `X-SH-Timestamp` header value as an input, so that
 * header is read (but NOT yet validated as "recent") before the signature
 * check runs — THEN the replay-window check on that same timestamp value,
 * THEN shape validation, THEN the actual work. No branch below the
 * signature check can be reached without a valid HMAC over this exact
 * body AND this exact timestamp.
 */
export async function POST(request: Request) {
  const ip = getClientIp(request);
  const limit = await consumeRateLimit(`webhook:scholarship-hub:${ip}`, RATE_LIMIT.limit, RATE_LIMIT.windowSeconds);
  if (!limit.allowed) {
    return jsonError("RATE_LIMITED", "Too many webhook deliveries.", { headers: rateLimitHeaders(limit) });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  const secret = await loadScholarshipHubWebhookSecret();
  if (!secret) return new Response(null, { status: 401 });

  const timestampHeader = request.headers.get("x-sh-timestamp");
  if (!timestampHeader || !verifySignature(rawBody, timestampHeader, request.headers.get("x-sh-signature"), secret)) {
    return new Response(null, { status: 401 });
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_WINDOW_SECONDS) {
    return new Response(null, { status: 401 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return new Response(null, { status: 400 });
  }
  const result = webhookPayloadSchema.safeParse(parsedBody);
  if (!result.success) return new Response(null, { status: 400 });

  try {
    await runReconciliationPull();
  } catch (error) {
    console.error("[webhook] scholarship-hub triggered pull failed", error);
    return new Response(null, { status: 500 });
  }

  return jsonSuccess({ received: true });
}
