import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { PlatformCredential } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";

const ORIGINAL_KEY = process.env.IDAP_CREDENTIAL_KEY;
const SECRET = "sh_whsec_test";

beforeAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  return startTestDatabase("scholarship-hub-webhook");
});
afterAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = ORIGINAL_KEY;
  return stopTestDatabase();
});
beforeEach(clearDatabase);
afterEach(() => vi.unstubAllGlobals());

async function withSecret() {
  await PlatformCredential.create({
    platform: "SCHOLARSHIP_HUB",
    keyEncrypted: encryptCredential("sh_pkey_test"),
    webhookSecretEncrypted: encryptCredential(SECRET),
    baseUrl: "https://hub.test",
    active: true,
  });
}

/**
 * Signs `${timestampSeconds}.${rawBody}` (Stripe-style) — the Hub's
 * dispatcher signs this exact concatenation, not the raw body alone, so the
 * timestamp itself is covered by the signature and can't be swapped onto a
 * captured valid signature to defeat the replay window.
 */
function sign(body: string, timestampSeconds: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex")}`;
}

function webhookRequest(body: string, opts: { signature?: string; timestamp?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.signature !== undefined) headers.set("x-sh-signature", opts.signature);
  if (opts.timestamp !== undefined) headers.set("x-sh-timestamp", opts.timestamp);
  return new Request("https://idap.test/api/webhooks/scholarship-hub", { method: "POST", headers, body });
}

const validPayload = JSON.stringify({
  event: "application.changed",
  externalRef: "IDAP:INS0001:507f1f77bcf86cd799439011",
  hubApplicationId: "507f191e810c19729de860ea",
  changedAt: new Date().toISOString(),
});

describe("POST /api/webhooks/scholarship-hub", () => {
  it("401s when no webhook secret has been configured yet", async () => {
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    const response = await POST(webhookRequest(validPayload, { signature: sign(validPayload, now), timestamp: now }));
    expect(response.status).toBe(401);
  });

  it("401s on a missing or malformed signature header", async () => {
    await withSecret();
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    expect((await POST(webhookRequest(validPayload, { timestamp: now }))).status).toBe(401);
    expect((await POST(webhookRequest(validPayload, { signature: "not-a-real-signature", timestamp: now }))).status).toBe(401);
  });

  it("401s when the signature was computed with the wrong secret", async () => {
    await withSecret();
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    const response = await POST(webhookRequest(validPayload, { signature: sign(validPayload, now, "sh_whsec_wrong"), timestamp: now }));
    expect(response.status).toBe(401);
  });

  it("401s on a timestamp outside the replay window, even when genuinely signed with that stale timestamp", async () => {
    await withSecret();
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    // A real sender would sign `${old}.${body}` and send `X-SH-Timestamp: old`
    // together — consistent, validly-signed, but stale. This must fail at
    // the replay-window check, not the signature check.
    const old = String(Math.floor(Date.now() / 1000) - 10_000);
    const response = await POST(webhookRequest(validPayload, { signature: sign(validPayload, old), timestamp: old }));
    expect(response.status).toBe(401);
  });

  it("400s on a well-signed but malformed body", async () => {
    await withSecret();
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    const badBody = JSON.stringify({ event: "application.changed" }); // missing required fields
    const response = await POST(webhookRequest(badBody, { signature: sign(badBody, now), timestamp: now }));
    expect(response.status).toBe(400);
  });

  it("verifies against the RAW body, not a re-serialized one (whitespace matters)", async () => {
    await withSecret();
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    // Same JSON content, different literal bytes (extra space) — the
    // signature was computed over `validPayload`, so it must NOT verify
    // against this semantically-equal-but-byte-different body.
    const respaced = validPayload.replace('"event"', '"event" ');
    const response = await POST(webhookRequest(respaced, { signature: sign(validPayload, now), timestamp: now }));
    expect(response.status).toBe(401);
  });

  it("401s when the signature was computed over a DIFFERENT timestamp than the one sent in the header", async () => {
    await withSecret();
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    const otherTimestamp = String(Number(now) - 1);
    // Proves the timestamp is genuinely covered by the signature: signing
    // with one timestamp and presenting a different one in the header (even
    // one still inside the replay window) must fail verification — a
    // captured valid signature can no longer be replayed with a fresh
    // X-SH-Timestamp.
    const response = await POST(webhookRequest(validPayload, { signature: sign(validPayload, otherTimestamp), timestamp: now }));
    expect(response.status).toBe(401);
  });

  it("triggers a reconciliation pull and returns 200 on a validly signed, well-formed ping", async () => {
    await withSecret();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    const response = await POST(webhookRequest(validPayload, { signature: sign(validPayload, now), timestamp: now }));

    expect(response.status).toBe(200);
    // The pull hit the Hub's list endpoint — proof it actually ran, not just
    // returned 200 without doing anything.
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("returns 500 (so the Hub retries) when the triggered pull itself fails", async () => {
    await withSecret();
    // Force a real throw (not just a non-2xx response) to simulate a
    // network failure, which is what makes runReconciliationPull itself
    // reject rather than just returning a PARTIAL/short result.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    const response = await POST(webhookRequest(validPayload, { signature: sign(validPayload, now), timestamp: now }));
    expect(response.status).toBe(500);
  });
});
