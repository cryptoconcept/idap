import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, sessionFor } from "../helpers/factories";
import { LeadService } from "@/services/lead.service";
import { ApplicationService } from "@/services/application.service";
import { NoteService } from "@/services/note.service";
import { DashboardService } from "@/services/dashboard.service";
import { tenantFilter } from "@/lib/tenant";
import { AppError } from "@/lib/api/errors";
import { createLeadSchema } from "@/lib/validation/lead";
import { createApplicationSchema } from "@/lib/validation/application";

const A = { institutionId: "INS0001" };
const B = { institutionId: "INS0002" };

const leadInput = createLeadSchema.parse({
  studentName: "Rahul Kumar",
  parentName: "Rajesh Kumar",
  phone: "9876543210",
  email: "parent@example.test",
  classInterested: "Grade 5",
});

const applicationInput = createApplicationSchema.parse({
  academicYear: "2026-27",
  student: { firstName: "Rahul", lastName: "Kumar" },
  parent: { phone: "9876543210" },
  admission: { applyingFor: "Grade 5" },
});

describe("tenant isolation", () => {
  beforeAll(async () => {
    await startTestDatabase("isolation");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
  });

  it("stamps each record with the institution it was created for", async () => {
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "API",
    });
    expect(lead.institutionId).toBe("INS0001");
    expect(lead.leadNumber.startsWith("INS0001-")).toBe(true);
  });

  it("hides another institution's enquiries from a list", async () => {
    await LeadService.createLead({ institutionId: "INS0001", data: leadInput, source: "API" });
    await LeadService.createLead({ institutionId: "INS0002", data: leadInput, source: "API" });

    const listA = await LeadService.list(A, {});
    expect(listA.total).toBe(1);
    expect(listA.items[0].institutionId).toBe("INS0001");
  });

  it("returns NOT_FOUND rather than FORBIDDEN when reaching across tenants", async () => {
    // 404 keeps an identifier from being probed for existence.
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "API",
    });

    await expect(LeadService.getById(B, lead.leadNumber)).rejects.toThrowError(AppError);
    await expect(LeadService.getById(B, lead.leadNumber)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(LeadService.getById(B, lead.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a cross-tenant status change", async () => {
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "API",
    });

    await expect(
      LeadService.updateStatus({
        tenantClause: B,
        id: lead.leadNumber,
        status: "ADMITTED",
        actor: { id: "6a8880f3446c577c470cd06c", name: "Other admin" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const unchanged = await LeadService.getById(A, lead.leadNumber);
    expect(unchanged.status).toBe("NEW");
  });

  it("hides another institution's applications, by number and by id", async () => {
    const application = await ApplicationService.createApplication({
      institutionId: "INS0001",
      data: applicationInput,
      source: "API",
    });

    await expect(
      ApplicationService.getApplication(B, application.applicationNumber),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ApplicationService.getApplication(B, application.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      ApplicationService.getApplication(A, application.applicationNumber),
    ).resolves.toMatchObject({ applicationNumber: application.applicationNumber });
  });

  it("refuses a cross-tenant status change on an application", async () => {
    const application = await ApplicationService.createApplication({
      institutionId: "INS0001",
      data: applicationInput,
      source: "API",
    });

    await expect(
      ApplicationService.updateStatus({
        tenantClause: B,
        identifier: application.applicationNumber,
        status: "APPROVED",
        actor: { id: "6a8880f3446c577c470cd06c", name: "Other admin" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("scopes notes to the institution that wrote them", async () => {
    const application = await ApplicationService.createApplication({
      institutionId: "INS0001",
      data: applicationInput,
      source: "API",
    });
    await NoteService.create({
      institutionId: "INS0001",
      entityType: "APPLICATION",
      entityId: application.id,
      note: "Internal: family visited on Saturday.",
    });

    expect(await NoteService.list("INS0001", "APPLICATION", application.id)).toHaveLength(1);
    expect(await NoteService.list("INS0002", "APPLICATION", application.id)).toHaveLength(0);
  });

  it("keeps search from crossing tenants", async () => {
    await LeadService.createLead({ institutionId: "INS0002", data: leadInput, source: "API" });
    const results = await LeadService.list(A, { q: "Rahul" });
    expect(results.total).toBe(0);
  });

  it("treats a search term as text, not as a query operator", async () => {
    await LeadService.createLead({ institutionId: "INS0001", data: leadInput, source: "API" });
    // An unescaped ".*" would match everything.
    expect((await LeadService.list(A, { q: ".*" })).total).toBe(0);
    expect((await LeadService.list(A, { q: "Rahul" })).total).toBe(1);
  });

  it("counts only the caller's institution on the dashboard", async () => {
    await LeadService.createLead({ institutionId: "INS0001", data: leadInput, source: "API" });
    await LeadService.createLead({ institutionId: "INS0002", data: leadInput, source: "API" });
    await ApplicationService.createApplication({
      institutionId: "INS0002",
      data: applicationInput,
      source: "API",
    });

    const stats = await DashboardService.getStats(A);
    expect(stats.totalEnquiries).toBe(1);
    expect(stats.totalApplications).toBe(0);
  });

  it("gives the platform admin no clause to query with", async () => {
    await LeadService.createLead({ institutionId: "INS0001", data: leadInput, source: "API" });
    expect(() => tenantFilter(sessionFor("SUPER_ADMIN"))).toThrowError(AppError);
  });

  it("scopes filter options to one institution", async () => {
    await ApplicationService.createApplication({
      institutionId: "INS0002",
      data: { ...applicationInput, admission: { applyingFor: "Grade 9", admissionType: undefined } },
      source: "API",
    });

    const options = await ApplicationService.filterOptions(A);
    expect(options.classes).not.toContain("Grade 9");
  });
});
