import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { Types } from "mongoose";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Scholarship, PlatformConnection, PlatformCredential, ScholarshipApplication } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";
import { runReconciliationPull } from "@/services/scholarship-application-sync.service";

const ORIGINAL_KEY = process.env.IDAP_CREDENTIAL_KEY;

beforeAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  return startTestDatabase("scholarship-hub-reconciliation-pull");
});
afterAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = ORIGINAL_KEY;
  return stopTestDatabase();
});
beforeEach(clearDatabase);
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const institutionId = "INS0001";
  await makeInstitution(institutionId);
  await PlatformConnection.create({ institutionId, platform: "SCHOLARSHIP_HUB", status: "CONNECTED", externalRef: `IDAP:${institutionId}` });
  await PlatformCredential.create({ platform: "SCHOLARSHIP_HUB", keyEncrypted: encryptCredential("sh_pkey_test"), baseUrl: "https://hub.test", active: true });
  const scholarshipId = new Types.ObjectId();
  const externalRef = `IDAP:${institutionId}:${scholarshipId.toHexString()}`;
  await Scholarship.create({
    _id: scholarshipId, institutionId, name: "Merit", amount: "1", criteria: "merit",
    listing: { hubId: "h1", externalRef, remoteStatus: "published", lastPushedAt: new Date() },
  });
  return { institutionId, externalRef };
}

function item(externalRef: string, hubApplicationId: string, hubUpdatedAt: string) {
  return {
    hubApplicationId, externalRef, scholarshipTitle: "Merit",
    applicant: { name: "Asha Rao" }, answers: {}, documents: [],
    status: "submitted", hubUpdatedAt,
  };
}

describe("runReconciliationPull", () => {
  it("ingests every item on a single (terminal) page and advances the stored cursor", async () => {
    const { externalRef, institutionId } = await setup();
    const items = [item(externalRef, "a1", "2026-09-06T00:00:00.000Z"), item(externalRef, "a2", "2026-09-06T00:01:00.000Z")];

    // Terminal page: hasMore is false, but nextCursor is still a REAL value
    // (the list endpoint only returns null for a genuinely empty page).
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items, nextCursor: "opaque-cursor-terminal", hasMore: false }), { status: 200 })));

    const result = await runReconciliationPull();
    expect(result).toEqual({ scanned: 2, ingested: 2, cursorAdvanced: true });
    expect(await ScholarshipApplication.countDocuments({ institutionId })).toBe(2);

    const credential = await PlatformCredential.findOne({ platform: "SCHOLARSHIP_HUB" }).lean();
    expect(credential?.applicationsSyncCursor).toBe("opaque-cursor-terminal");
  });

  it("follows hasMore across multiple pages until caught up", async () => {
    const { externalRef } = await setup();
    const page1 = { items: [item(externalRef, "a1", "2026-09-06T00:00:00.000Z")], nextCursor: "opaque-cursor-1", hasMore: true };
    const page2 = { items: [item(externalRef, "a2", "2026-09-06T00:01:00.000Z")], nextCursor: "opaque-cursor-2", hasMore: false };
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify(calls.length === 1 ? page1 : page2), { status: 200 });
      }),
    );

    const result = await runReconciliationPull();
    expect(result.scanned).toBe(2);
    expect(result.ingested).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("since=opaque-cursor-1");
  });

  it("passes the previously stored cursor as `since` on the next run", async () => {
    await setup();
    await PlatformCredential.updateOne({ platform: "SCHOLARSHIP_HUB" }, { $set: { applicationsSyncCursor: "stored-cursor" } });

    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), { status: 200 });
      }),
    );

    await runReconciliationPull();
    expect(capturedUrl).toContain("since=stored-cursor");
  });

  it("is idempotent: re-ingesting the same page a second time does not create duplicates", async () => {
    const { externalRef, institutionId } = await setup();
    const items = [item(externalRef, "a1", "2026-09-06T00:00:00.000Z")];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items, nextCursor: "opaque-cursor-1", hasMore: false }), { status: 200 })));

    await runReconciliationPull();
    await runReconciliationPull();
    expect(await ScholarshipApplication.countDocuments({ institutionId })).toBe(1);
  });

  it("an empty page returns nextCursor:null and does not advance or crash on a missing cursor", async () => {
    await setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), { status: 200 })));

    const result = await runReconciliationPull();
    expect(result).toEqual({ scanned: 0, ingested: 0, cursorAdvanced: false });
  });
});
