import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Types } from "mongoose";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { Scholarship, PlatformConnection, ScholarshipApplication } from "@/models";
import * as fcm from "@/lib/push/fcm";
import { DeviceService } from "@/services/device.service";
import { upsertFromHubPayload, type HubApplicationPayload } from "@/services/scholarship-application-sync.service";

vi.mock("@/lib/push/fcm", () => ({
  sendPush: vi.fn(async () => ({ deadTokens: [] as string[] })),
}));
const sendPush = vi.mocked(fcm.sendPush);

beforeAll(async () => {
  await startTestDatabase("scholarship-application-sync");
  // The unique (institutionId, hubApplicationId) index is built asynchronously;
  // wait for it so the concurrent-insert test exercises the real constraint.
  await ScholarshipApplication.init();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  sendPush.mockReset();
  sendPush.mockResolvedValue({ deadTokens: [] });
});

async function connectedScholarship(institutionId = "INS0001") {
  await makeInstitution(institutionId);
  await PlatformConnection.create({
    institutionId,
    platform: "SCHOLARSHIP_HUB",
    status: "CONNECTED",
    externalRef: `IDAP:${institutionId}`,
  });
  const scholarshipId = new Types.ObjectId();
  const externalRef = `IDAP:${institutionId}:${scholarshipId.toHexString()}`;
  await Scholarship.create({
    _id: scholarshipId,
    institutionId,
    name: "Merit Scholarship",
    amount: "₹10,000",
    criteria: "merit",
    listing: {
      hubId: "hub-listing-1",
      externalRef,
      remoteStatus: "published",
      lastPushedAt: new Date(),
    },
  });
  return { institutionId, scholarshipId, externalRef };
}

function payloadFor(externalRef: string, overrides: Partial<HubApplicationPayload> = {}): HubApplicationPayload {
  return {
    hubApplicationId: new Types.ObjectId().toHexString(),
    externalRef,
    scholarshipTitle: "Merit Scholarship",
    applicant: { name: "Asha Rao", email: "asha@example.com" },
    answers: { why: "need it" },
    documents: [],
    status: "submitted",
    hubUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("upsertFromHubPayload", () => {
  it("inserts a new row as reviewStatus NEW and fires the notification", async () => {
    const { externalRef, institutionId } = await connectedScholarship();
    // dispatch() short-circuits when the institution has no registered device,
    // so register one — otherwise sendPush is never reached.
    const user = await makeUser(institutionId, "INSTITUTION_ADMIN", "admin-sync@example.test");
    await DeviceService.register({
      userId: String(user._id),
      institutionId,
      deviceId: "install-sync-1",
      pushToken: "token-sync-1",
      platform: "android",
    });
    const payload = payloadFor(externalRef);

    const outcome = await upsertFromHubPayload(payload);
    expect(outcome.kind).toBe("INSERTED");

    const row = await ScholarshipApplication.findOne({ institutionId, hubApplicationId: payload.hubApplicationId }).lean();
    expect(row?.reviewStatus).toBe("NEW");
    expect(row?.hubStatus).toBe("submitted");
    expect(row?.applicant.name).toBe("Asha Rao");
    await vi.waitFor(() => expect(sendPush).toHaveBeenCalledTimes(1));
  });

  it("replaying the same payload updates, never duplicates, and never touches reviewStatus", async () => {
    const { externalRef, institutionId } = await connectedScholarship();
    const payload = payloadFor(externalRef);
    await upsertFromHubPayload(payload);

    const row = await ScholarshipApplication.findOne({ institutionId, hubApplicationId: payload.hubApplicationId });
    row!.reviewStatus = "SHORTLISTED";
    await row!.save();

    const later = payloadFor(externalRef, {
      hubApplicationId: payload.hubApplicationId,
      status: "under_review",
      hubUpdatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const outcome = await upsertFromHubPayload(later);
    expect(outcome.kind).toBe("UPDATED");

    const updated = await ScholarshipApplication.findOne({ institutionId, hubApplicationId: payload.hubApplicationId }).lean();
    expect(updated?.hubStatus).toBe("under_review"); // Hub-owned field DID update
    expect(updated?.reviewStatus).toBe("SHORTLISTED"); // IDAP-owned field untouched
    expect(await ScholarshipApplication.countDocuments({})).toBe(1);
  });

  it("the ordering guard: a stale payload (older hubUpdatedAt) never reverts a newer one", async () => {
    const { externalRef, institutionId } = await connectedScholarship();
    const hubApplicationId = new Types.ObjectId().toHexString();
    const now = new Date();
    await upsertFromHubPayload(
      payloadFor(externalRef, { hubApplicationId, status: "under_review", hubUpdatedAt: now.toISOString() }),
    );

    const stale = payloadFor(externalRef, {
      hubApplicationId,
      status: "submitted",
      hubUpdatedAt: new Date(now.getTime() - 5000).toISOString(),
    });
    const outcome = await upsertFromHubPayload(stale);
    expect(outcome.kind).toBe("STALE");

    const row = await ScholarshipApplication.findOne({ institutionId, hubApplicationId }).lean();
    expect(row?.hubStatus).toBe("under_review"); // unchanged by the stale write
  });

  it("skips (does not throw) when the institution has no CONNECTED SCHOLARSHIP_HUB connection", async () => {
    await makeInstitution("INS0002");
    const scholarshipId = new Types.ObjectId();
    const externalRef = `IDAP:INS0002:${scholarshipId.toHexString()}`;
    await Scholarship.create({
      _id: scholarshipId, institutionId: "INS0002", name: "X", amount: "1", criteria: "x",
      listing: { hubId: "h2", externalRef, remoteStatus: "published", lastPushedAt: new Date() },
    });
    // No PlatformConnection created — institution never connected.

    const outcome = await upsertFromHubPayload(payloadFor(externalRef));
    expect(outcome).toEqual({ kind: "SKIPPED", reason: "NOT_CONNECTED" });
    expect(await ScholarshipApplication.countDocuments({})).toBe(0);
  });

  it("skips a malformed externalRef", async () => {
    const outcome = await upsertFromHubPayload(payloadFor("not-a-real-ref"));
    expect(outcome).toEqual({ kind: "SKIPPED", reason: "MALFORMED_REF" });
  });

  it("skips when the local scholarship's listing.externalRef does not match the payload's (forged/stale ref)", async () => {
    const { institutionId, scholarshipId } = await connectedScholarship();
    const forgedRef = `IDAP:${institutionId}:${scholarshipId.toHexString()}`;
    // Overwrite the scholarship's real listing.externalRef to something else,
    // simulating a stale/forged ping that no longer matches reality.
    await Scholarship.updateOne({ _id: scholarshipId }, { $set: { "listing.externalRef": "IDAP:INS0001:000000000000000000000000" } });

    const outcome = await upsertFromHubPayload(payloadFor(forgedRef));
    expect(outcome).toEqual({ kind: "SKIPPED", reason: "REF_MISMATCH" });
  });

  it("skips when the referenced scholarship does not exist locally", async () => {
    await makeInstitution("INS0003");
    await PlatformConnection.create({ institutionId: "INS0003", platform: "SCHOLARSHIP_HUB", status: "CONNECTED", externalRef: "IDAP:INS0003" });
    const fakeRef = `IDAP:INS0003:${new Types.ObjectId().toHexString()}`;

    const outcome = await upsertFromHubPayload(payloadFor(fakeRef));
    expect(outcome).toEqual({ kind: "SKIPPED", reason: "SCHOLARSHIP_NOT_FOUND" });
  });

  it("two concurrent inserts of the same new application never produce two rows", async () => {
    const { externalRef, institutionId } = await connectedScholarship();
    const payload = payloadFor(externalRef);

    const results = await Promise.all([upsertFromHubPayload(payload), upsertFromHubPayload(payload)]);
    expect(results.map((r) => r.kind).sort()).toEqual(["INSERTED", "UPDATED"].sort());
    expect(await ScholarshipApplication.countDocuments({ institutionId, hubApplicationId: payload.hubApplicationId })).toBe(1);
  });
});
