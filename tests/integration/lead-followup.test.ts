import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { LeadService } from "@/services/lead.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(() => startTestDatabase("lead-followup"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});

async function makeLead() {
  return LeadService.createLead({
    institutionId: "INS0001",
    data: { studentName: "Test Student", phone: "9876543210" },
    source: "API",
  });
}

describe("LeadService.setFollowUp", () => {
  it("an admin can set a follow-up date on any lead", async () => {
    const lead = await makeLead();
    const admin = {
      id: "6a887abd755db527bea51204",
      name: "Admin",
      email: "admin@infinityschool.edu.in",
      role: "INSTITUTION_ADMIN" as const,
      institutionId: "INS0001",
    };

    const updated = await LeadService.setFollowUp({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      followUpAt: "2026-09-01",
      user: admin,
    });

    expect(updated.followUpAt).toContain("2026-09-01");
  });

  it("a counselor can set a follow-up only on their own assigned lead", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const lead = await makeLead();
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselor._id),
      actor,
    });

    const counselorUser = {
      id: String(counselor._id),
      name: "C",
      email: "c@infinityschool.edu.in",
      role: "COUNSELOR" as const,
      institutionId: "INS0001",
    };

    const updated = await LeadService.setFollowUp({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      followUpAt: "2026-09-01",
      user: counselorUser,
    });
    expect(updated.followUpAt).toContain("2026-09-01");
  });

  it("returns NOT_FOUND for a counselor setting a follow-up on someone else's lead", async () => {
    const counselorA = await makeUser("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const counselorB = await makeUser("INS0001", "COUNSELOR", "b@infinityschool.edu.in");
    const lead = await makeLead();
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselorA._id),
      actor,
    });

    const counselorBUser = {
      id: String(counselorB._id),
      name: "B",
      email: "b@infinityschool.edu.in",
      role: "COUNSELOR" as const,
      institutionId: "INS0001",
    };

    await expect(
      LeadService.setFollowUp({
        tenantClause: { institutionId: "INS0001" },
        id: lead.id,
        followUpAt: "2026-09-01",
        user: counselorBUser,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("clears followUpNotifiedAt whenever followUpAt changes", async () => {
    const lead = await makeLead();
    const admin = {
      id: "6a887abd755db527bea51204",
      name: "Admin",
      email: "admin@infinityschool.edu.in",
      role: "INSTITUTION_ADMIN" as const,
      institutionId: "INS0001",
    };

    await LeadService.setFollowUp({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      followUpAt: "2026-09-01",
      user: admin,
    });

    const { Lead } = await import("@/models");
    await Lead.updateOne({ _id: lead.id }, { $set: { followUpNotifiedAt: new Date() } });

    const updated = await LeadService.setFollowUp({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      followUpAt: "2026-09-15",
      user: admin,
    });

    const row = await Lead.findById(updated.id).lean();
    expect(row?.followUpNotifiedAt).toBeUndefined();
  });

  it("clearing followUpAt to null also clears followUpNotifiedAt", async () => {
    const lead = await makeLead();
    const admin = {
      id: "6a887abd755db527bea51204",
      name: "Admin",
      email: "admin@infinityschool.edu.in",
      role: "INSTITUTION_ADMIN" as const,
      institutionId: "INS0001",
    };
    await LeadService.setFollowUp({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      followUpAt: "2026-09-01",
      user: admin,
    });

    const updated = await LeadService.setFollowUp({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      followUpAt: null,
      user: admin,
    });

    expect(updated.followUpAt).toBeUndefined();
  });
});
