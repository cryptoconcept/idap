import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeApiClient } from "../helpers/factories";
import { Institution } from "@/models";
import { DashboardService } from "@/services/dashboard.service";

describe("dashboard profile + integration summary", () => {
  beforeAll(async () => {
    await startTestDatabase("dashboardprofile");
    await Institution.syncIndexes();
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("returns a numeric completion percent alongside the profile status", async () => {
    await makeInstitution("INS0001", { institutionName: "Complete-ish School" });

    const stats = await DashboardService.getStats({ institutionId: "INS0001" });

    expect(typeof stats.profile.completionPercent).toBe("number");
    expect(stats.profile.completionPercent).toBeGreaterThanOrEqual(0);
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
});
