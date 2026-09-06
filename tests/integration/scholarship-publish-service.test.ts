import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { Scholarship, PlatformConnection, PlatformCredential } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";
import { registerAdapter, adapterFor } from "@/lib/connectors";
import type { PlatformAdapter } from "@/lib/connectors/types";
import { ScholarshipPublishService } from "@/services/scholarship-publish.service";

const VALID_VAULT_KEY = Buffer.alloc(32, 7).toString("base64");

let real: PlatformAdapter;
const actor = { id: "u1", name: "Admin" };
const upsert = vi.fn();
const withdraw = vi.fn();

beforeAll(async () => {
  await startTestDatabase("scholarship-publish");
  await Scholarship.syncIndexes();
  real = adapterFor("SCHOLARSHIP_HUB");
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  process.env.IDAP_CREDENTIAL_KEY = VALID_VAULT_KEY;
  upsert.mockReset(); withdraw.mockReset();
  registerAdapter({ ...real, upsertScholarship: upsert, withdrawScholarship: withdraw });
  // A CONNECTED SCHOLARSHIP_HUB connection + active platform credential —
  // seeded the same way tests/integration/connection-service.test.ts does
  // for PASSPERCENT (`makeCredential`/`connectedFixture`): a PlatformCredential
  // row with an encrypted key, and a PlatformConnection row already
  // CONNECTED. Scholarship Hub has no per-institution grant (Contract 1 —
  // every push authenticates with the shared platform key), so the
  // connection row here carries no `grantTokenEncrypted` at all.
  await PlatformCredential.create({
    platform: "SCHOLARSHIP_HUB",
    keyEncrypted: encryptCredential("sh_pkey_test_0000"),
    baseUrl: "https://api.scholarshiphub.test",
    active: true,
  });
  await PlatformConnection.create({
    institutionId: "INS0001",
    platform: "SCHOLARSHIP_HUB",
    status: "CONNECTED",
    externalRef: "INS0001",
  });
});
afterEach(() => {
  registerAdapter(real);
  process.env.IDAP_CREDENTIAL_KEY = VALID_VAULT_KEY;
});

function complete(institutionId: string) {
  return { institutionId, name: "Infinity Merit", status: "PUBLISHED", summary: "Merit", description: "x".repeat(220), categories: ["merit"], amount: "Up to ₹50,000", applicationMode: "platform", requiredDocuments: [{ key: "m", label: "Marksheet", required: true }], dates: { closesAt: new Date(Date.now() + 30 * 864e5) } };
}

describe("ScholarshipPublishService", () => {
  it("publish → upsert records the listing sub-doc", async () => {
    upsert.mockResolvedValue({ kind: "OK", hubId: "h1", slug: "infinity-merit", publicUrl: "https://hub.test/scholarships/infinity-merit", remoteStatus: "published" });
    const s = await Scholarship.create(complete("INS0001"));
    await ScholarshipPublishService.publish("INS0001", String(s._id), actor);
    const stored = await Scholarship.findById(s._id).lean();
    expect(stored?.listing?.hubId).toBe("h1");
    expect(stored?.listing?.remoteStatus).toBe("published");
    expect(upsert).toHaveBeenCalledOnce();
  });
  it("a BLOCKED push records blockedReason and does not throw", async () => {
    upsert.mockResolvedValue({ kind: "BLOCKED", reason: "MODERATION_HOLD", detail: "held" });
    const s = await Scholarship.create(complete("INS0001"));
    await ScholarshipPublishService.publish("INS0001", String(s._id), actor);
    expect((await Scholarship.findById(s._id).lean())?.listing?.blockedReason).toContain("held");
  });
  it("pushClose → withdraw flips remoteStatus to closed", async () => {
    upsert.mockResolvedValue({ kind: "OK", hubId: "h1", slug: "s", remoteStatus: "published" });
    withdraw.mockResolvedValue({ kind: "OK", hubId: "h1", remoteStatus: "closed" });
    const s = await Scholarship.create(complete("INS0001"));
    await ScholarshipPublishService.publish("INS0001", String(s._id), actor);
    await ScholarshipPublishService.pushClose("INS0001", String(s._id), actor);
    expect((await Scholarship.findById(s._id).lean())?.listing?.remoteStatus).toBe("closed");
  });
  it("pushEdit never throws when the adapter errors", async () => {
    upsert.mockRejectedValue(new Error("boom"));
    const s = await Scholarship.create({ ...complete("INS0001"), listing: { hubId: "h1", externalRef: "IDAP:INS0001:x", slug: "s", remoteStatus: "published", lastPushedAt: new Date() } });
    await expect(ScholarshipPublishService.pushEdit("INS0001", String(s._id), actor)).resolves.not.toThrow();
    expect((await Scholarship.findById(s._id).lean())?.listing?.blockedReason).toBeTruthy();
  });
});
