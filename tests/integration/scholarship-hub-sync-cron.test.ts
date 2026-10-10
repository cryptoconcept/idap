import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { PlatformCredential } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";

const ORIGINAL_SECRET = process.env.CRON_SECRET;
const ORIGINAL_KEY = process.env.IDAP_CREDENTIAL_KEY;

beforeAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  return startTestDatabase("scholarship-hub-sync-cron");
});
afterAll(() => {
  process.env.CRON_SECRET = ORIGINAL_SECRET;
  process.env.IDAP_CREDENTIAL_KEY = ORIGINAL_KEY;
  return stopTestDatabase();
});
beforeEach(async () => {
  await clearDatabase();
  process.env.CRON_SECRET = "test-cron-secret";
});
afterEach(() => vi.unstubAllGlobals());

function cronRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  return { headers } as unknown as Request;
}

describe("GET /api/cron/scholarship-hub-sync", () => {
  it("401s without the correct CRON_SECRET", async () => {
    const { GET } = await import("@/app/api/cron/scholarship-hub-sync/route");
    expect((await GET(cronRequest("wrong"))).status).toBe(401);
    expect((await GET(cronRequest())).status).toBe(401);
  });

  it("runs the pull and returns its summary when authorized", async () => {
    await PlatformCredential.create({
      platform: "SCHOLARSHIP_HUB", keyEncrypted: encryptCredential("sh_pkey_test"),
      baseUrl: "https://hub.test", active: true,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), { status: 200 })));

    const { GET } = await import("@/app/api/cron/scholarship-hub-sync/route");
    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; scanned: number };
    expect(body.success).toBe(true);
    expect(body.scanned).toBe(0);
  });
});
