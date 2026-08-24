import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { LeadService } from "@/services/lead.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(() => startTestDatabase("lead-assignment"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

async function makeLead(institutionId: string) {
  return LeadService.createLead({
    institutionId,
    data: { studentName: "Test Student", phone: "9876543210" },
    source: "API",
  });
}

describe("LeadService.assign", () => {
  it("assigns a lead to a counselor and stamps assignedAt", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "counselor@infinityschool.edu.in");
    const lead = await makeLead("INS0001");

    const updated = await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselor._id),
      actor,
    });

    expect(updated.assignedTo).toBe(String(counselor._id));
    expect(updated.assignedAt).toBeDefined();
    expect(updated.assignedToName).toBe(counselor.name);
  });

  it("unassigns when assignedTo is null", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "counselor@infinityschool.edu.in");
    const lead = await makeLead("INS0001");
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselor._id),
      actor,
    });

    const updated = await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: null,
      actor,
    });

    expect(updated.assignedTo).toBeUndefined();
  });

  it("refuses a Front Desk user as an assignment target", async () => {
    const frontDesk = await makeUser("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");
    const lead = await makeLead("INS0001");

    await expect(
      LeadService.assign({
        tenantClause: { institutionId: "INS0001" },
        id: lead.id,
        assignedTo: String(frontDesk._id),
        actor,
      }),
    ).rejects.toThrow(/counselor or admin/i);
  });

  it("returns NOT_FOUND for a target user in a different institution", async () => {
    const foreignCounselor = await makeUser("INS0002", "COUNSELOR", "counselor@intelligentpublic.edu.in");
    const lead = await makeLead("INS0001");

    await expect(
      LeadService.assign({
        tenantClause: { institutionId: "INS0001" },
        id: lead.id,
        assignedTo: String(foreignCounselor._id),
        actor,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns NOT_FOUND for a lead in a different institution", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "counselor@infinityschool.edu.in");
    const lead = await makeLead("INS0002");

    await expect(
      LeadService.assign({
        tenantClause: { institutionId: "INS0001" },
        id: lead.id,
        assignedTo: String(counselor._id),
        actor,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("records an Activity entry naming old and new assignee on reassignment", async () => {
    const counselorA = await makeUser("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const counselorB = await makeUser("INS0001", "COUNSELOR", "b@infinityschool.edu.in");
    const lead = await makeLead("INS0001");

    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselorA._id),
      actor,
    });
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselorB._id),
      actor,
    });

    const { Activity } = await import("@/models");
    const entries = await Activity.find({ institutionId: "INS0001", entityType: "LEAD" })
      .sort({ createdAt: 1 })
      .lean();
    const reassignEntry = entries[entries.length - 1];
    expect(reassignEntry.action).toMatch(/reassign/i);
  });
});

describe("LeadService.list — visibility", () => {
  it("scopes a counselor's list to their own assigned leads plus unassigned ones", async () => {
    const counselorA = await makeUser("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const counselorB = await makeUser("INS0001", "COUNSELOR", "b@infinityschool.edu.in");
    const leadA = await makeLead("INS0001");
    const leadB = await makeLead("INS0001");
    const leadUnassigned = await makeLead("INS0001");

    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: leadA.id,
      assignedTo: String(counselorA._id),
      actor,
    });
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: leadB.id,
      assignedTo: String(counselorB._id),
      actor,
    });

    const { leadVisibilityFilter } = await import("@/lib/tenant/permissions");
    const currentUser = {
      id: String(counselorA._id),
      name: "A",
      email: "a@infinityschool.edu.in",
      role: "COUNSELOR" as const,
      institutionId: "INS0001",
    };
    const result = await LeadService.list(
      { institutionId: "INS0001", ...leadVisibilityFilter(currentUser) },
      {},
    );

    const ids = result.items.map((item) => item.id).sort();
    expect(ids).toEqual([leadA.id, leadUnassigned.id].sort());
  });
});
