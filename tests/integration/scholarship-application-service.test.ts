import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Types } from "mongoose";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { ScholarshipApplication, Activity } from "@/models";
import { ScholarshipApplicationService } from "@/services/scholarship-application.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(() => startTestDatabase("scholarship-application-service"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

async function makeApplication(institutionId: string, overrides: Record<string, unknown> = {}) {
  return ScholarshipApplication.create({
    institutionId, scholarshipId: new Types.ObjectId(), externalRef: `IDAP:${institutionId}:${new Types.ObjectId().toHexString()}`,
    hubApplicationId: new Types.ObjectId().toHexString(), applicant: { name: "Asha Rao" }, hubStatus: "submitted",
    hubUpdatedAt: new Date(), lastSyncedAt: new Date(), ...overrides,
  });
}

describe("ScholarshipApplicationService.list", () => {
  it("scopes strictly to one tenant", async () => {
    await makeApplication("INS0001");
    await makeApplication("INS0002");
    const result = await ScholarshipApplicationService.list({ institutionId: "INS0001" }, {});
    expect(result.total).toBe(1);
  });

  it("filters by hubStatus and reviewStatus independently", async () => {
    await makeApplication("INS0001", { hubStatus: "withdrawn" });
    await makeApplication("INS0001", { hubStatus: "submitted", reviewStatus: "SHORTLISTED" });

    expect((await ScholarshipApplicationService.list({ institutionId: "INS0001" }, { hubStatus: "withdrawn" })).total).toBe(1);
    expect((await ScholarshipApplicationService.list({ institutionId: "INS0001" }, { reviewStatus: "SHORTLISTED" })).total).toBe(1);
  });

  it("paginates", async () => {
    for (let i = 0; i < 5; i += 1) await makeApplication("INS0001");
    const page = await ScholarshipApplicationService.list({ institutionId: "INS0001" }, { page: 2, pageSize: 2 });
    expect(page.total).toBe(5);
    expect(page.totalPages).toBe(3);
    expect(page.items).toHaveLength(2);
  });
});

describe("ScholarshipApplicationService.assign", () => {
  it("assigns and audits", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR");
    const application = await makeApplication("INS0001");

    const updated = await ScholarshipApplicationService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: String(application._id),
      assignedTo: String(counselor._id),
      actor,
    });

    expect(updated.assignedTo).toBe(String(counselor._id));
    expect(updated.assignedAt).toBeDefined();
    const activity = await Activity.find({ entityType: "SCHOLARSHIP_APPLICATION", entityId: application._id }).lean();
    expect(activity.some((a) => a.action.toLowerCase().includes("assign"))).toBe(true);
  });

  it("never reaches across tenants", async () => {
    const application = await makeApplication("INS0002");
    await expect(
      ScholarshipApplicationService.assign({
        tenantClause: { institutionId: "INS0001" },
        id: String(application._id),
        assignedTo: "someone",
        actor,
      }),
    ).rejects.toThrow();
  });
});

describe("ScholarshipApplicationService.updateReviewStatus", () => {
  it("updates reviewStatus and audits, leaving hubStatus untouched", async () => {
    const application = await makeApplication("INS0001", { hubStatus: "submitted" });

    const updated = await ScholarshipApplicationService.updateReviewStatus({
      tenantClause: { institutionId: "INS0001" },
      id: String(application._id),
      reviewStatus: "SHORTLISTED",
      actor,
    });

    expect(updated.reviewStatus).toBe("SHORTLISTED");
    expect(updated.hubStatus).toBe("submitted");
  });

  it("a withdrawn-on-Hub application can still have its reviewStatus changed (both coexist)", async () => {
    const application = await makeApplication("INS0001", { hubStatus: "withdrawn" });
    const updated = await ScholarshipApplicationService.updateReviewStatus({
      tenantClause: { institutionId: "INS0001" },
      id: String(application._id),
      reviewStatus: "APPROVED",
      actor,
    });
    expect(updated.hubStatus).toBe("withdrawn");
    expect(updated.reviewStatus).toBe("APPROVED");
  });
});
