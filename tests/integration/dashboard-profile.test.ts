import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeProfiledInstitution, makeApiClient, makeUser } from "../helpers/factories";
import { Institution } from "@/models";
import { DashboardService } from "@/services/dashboard.service";
import { LeadService } from "@/services/lead.service";
import { leadVisibilityFilter } from "@/lib/tenant/permissions";

describe("dashboard profile + integration summary", () => {
  beforeAll(async () => {
    await startTestDatabase("dashboardprofile");
    await Institution.syncIndexes();
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("returns a numeric completion percent alongside the profile status", async () => {
    // A genuinely filled-in profile, so "Complete-ish" is an accurate name and
    // the percent this asserts on is not just the trivial near-empty case.
    await makeProfiledInstitution("INS0001", { institutionName: "Complete-ish School" });

    const stats = await DashboardService.getStats({ institutionId: "INS0001" });

    expect(typeof stats.profile.completionPercent).toBe("number");
    expect(stats.profile.completionPercent).toBeGreaterThan(0);
    expect(stats.profile.completionPercent).toBeLessThanOrEqual(100);
    expect(stats.profile.status).toBe("DRAFT");
  });

  it("counts active credentials scoped to one institution only", async () => {
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");

    // Two active credentials for INS0001, one active credential for INS0002.
    await makeApiClient("INS0001");
    await makeApiClient("INS0001");
    await makeApiClient("INS0002");

    const stats = await DashboardService.getStats({ institutionId: "INS0001" });

    expect(stats.integration.activeCredentials).toBe(2);
  });

  it("does not count an inactive or revoked credential", async () => {
    await makeInstitution("INS0001");

    await makeApiClient("INS0001");
    await makeApiClient("INS0001", undefined, { active: false });
    await makeApiClient("INS0001", undefined, { active: false, revokedAt: new Date() });

    const stats = await DashboardService.getStats({ institutionId: "INS0001" });

    expect(stats.integration.activeCredentials).toBe(1);
  });

  it("scopes enquiry counts to a Counselor's own visibility, not the whole institution", async () => {
    await makeInstitution("INS0001");
    const counselorA = await makeUser("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const counselorB = await makeUser("INS0001", "COUNSELOR", "b@infinityschool.edu.in");

    const leadA = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "A's lead", phone: "9876543210" },
      source: "API",
    });
    const leadB = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "B's lead", phone: "9876543211" },
      source: "API",
    });
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: leadA.id,
      assignedTo: String(counselorA._id),
      actor: { id: String(counselorA._id), name: counselorA.name },
    });
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: leadB.id,
      assignedTo: String(counselorB._id),
      actor: { id: String(counselorB._id), name: counselorB.name },
    });

    const counselorAUser = {
      id: String(counselorA._id),
      name: "A",
      email: "a@infinityschool.edu.in",
      role: "COUNSELOR" as const,
      institutionId: "INS0001",
    };

    const stats = await DashboardService.getStats(
      { institutionId: "INS0001" },
      leadVisibilityFilter(counselorAUser),
    );

    expect(stats.totalEnquiries).toBe(1);
  });
});
