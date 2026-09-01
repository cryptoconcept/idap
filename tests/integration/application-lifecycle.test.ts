import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { ApplicationService } from "@/services/application.service";
import { ActivityService } from "@/services/activity.service";
import { buildApplicationPdf } from "@/lib/pdf/application-pdf";
import { serializeInstitution } from "@/lib/tenant";
import { Application, Institution } from "@/models";
import { createApplicationSchema } from "@/lib/validation/application";

const TENANT = { institutionId: "INS0001" };
const ACTOR = { id: "6a8880f3446c577c470cd06c", name: "Admissions Officer" };

// Parsed through the real schema so the fixture matches what a route hands the
// service, transforms and all.
const applicationInput = createApplicationSchema.parse({
  academicYear: "2026-27",
  student: {
    firstName: "Rahul",
    middleName: "Singh",
    lastName: "Kumar",
    dateOfBirth: "2016-05-10",
    gender: "Male",
  },
  parent: { fatherName: "Rajesh Kumar", motherName: "Anitha Kumar", phone: "9876543210" },
  address: { addressLine1: "Mysore", city: "Mysore", state: "Karnataka", pincode: "570001" },
  academic: { previousInstitution: "ABC School", previousClass: "Grade 4" },
  admission: { applyingFor: "Grade 5" },
});

describe("application lifecycle", () => {
  beforeAll(async () => {
    await startTestDatabase("lifecycle");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001", {
      address: "Plot 14, Hebbal Industrial Area",
      phone: "8212540111",
      email: "admissions@infinity.test",
    });
  });

  async function create() {
    return ApplicationService.createApplication({
      institutionId: "INS0001",
      data: applicationInput,
      source: "API",
      actor: { name: "API: Website" },
    });
  }

  it("starts every application as SUBMITTED", async () => {
    const application = await create();
    expect(application.status).toBe("SUBMITTED");
    expect(application.applicationNumber).toBe("INS0001-APP-000001");
  });

  it("audit M4: a replayed idempotency key returns the first record, not a duplicate", async () => {
    // Simulates the public form retrying after a dropped response: the second
    // submit carries the SAME key the first one did. Without dedup the office
    // would receive two identical applications with different numbers.
    const key = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const first = await ApplicationService.createApplication({
      institutionId: "INS0001",
      data: { ...applicationInput, idempotencyKey: key },
      source: "API",
    });
    const retry = await ApplicationService.createApplication({
      institutionId: "INS0001",
      data: { ...applicationInput, idempotencyKey: key },
      source: "API",
    });

    expect(retry.applicationNumber).toBe(first.applicationNumber);
    expect(await Application.countDocuments({})).toBe(1);
  });

  it("audit M4: submissions without a key are never collapsed", async () => {
    // The dedup must key strictly on the token — two keyless submissions are
    // two applications, exactly as before.
    await create();
    await create();
    expect(await Application.countDocuments({})).toBe(2);
  });

  it("derives a searchable full name from the name parts", async () => {
    const application = await create();
    expect(application.student.fullName).toBe("Rahul Singh Kumar");

    // That denormalised name is what makes the applications search work.
    const found = await ApplicationService.list(TENANT, { q: "Singh" });
    expect(found.total).toBe(1);
  });

  it("walks SUBMITTED to APPROVED and records each step", async () => {
    const application = await create();

    for (const status of ["UNDER_REVIEW", "APPROVED"] as const) {
      const updated = await ApplicationService.updateStatus({
        tenantClause: TENANT,
        identifier: application.applicationNumber,
        status,
        actor: ACTOR,
      });
      expect(updated.status).toBe(status);
    }

    const activity = await ActivityService.listForEntity("INS0001", "APPLICATION", application.id);
    const actions = activity.map((entry) => entry.action);
    expect(actions).toContain("Application submitted");
    expect(actions).toContain("Status changed to UNDER_REVIEW");
    expect(actions).toContain("Status changed to APPROVED");
    expect(activity[0].performedByName).toBe(ACTOR.name);
  });

  it("does not log an activity entry when the status is unchanged", async () => {
    const application = await create();
    await ApplicationService.updateStatus({
      tenantClause: TENANT,
      identifier: application.applicationNumber,
      status: "SUBMITTED",
      actor: ACTOR,
    });

    const activity = await ActivityService.listForEntity("INS0001", "APPLICATION", application.id);
    expect(activity.filter((entry) => entry.action.startsWith("Status changed"))).toHaveLength(0);
  });

  it("finds an application by number case-insensitively", async () => {
    const application = await create();
    const found = await ApplicationService.getApplication(
      TENANT,
      application.applicationNumber.toLowerCase(),
    );
    expect(found.id).toBe(application.id);
  });

  it("filters by status, year and class", async () => {
    await create();
    await ApplicationService.createApplication({
      institutionId: "INS0001",
      data: { ...applicationInput, admission: { applyingFor: "Grade 9", admissionType: undefined } },
      source: "API",
    });

    expect((await ApplicationService.list(TENANT, { applyingFor: "Grade 9" })).total).toBe(1);
    expect((await ApplicationService.list(TENANT, { academicYear: "2026-27" })).total).toBe(2);
    expect((await ApplicationService.list(TENANT, { status: "APPROVED" })).total).toBe(0);
  });

  it("paginates", async () => {
    for (let index = 0; index < 5; index += 1) await create();
    const page = await ApplicationService.list(TENANT, { page: 2, pageSize: 2 });

    expect(page.total).toBe(5);
    expect(page.totalPages).toBe(3);
    expect(page.items).toHaveLength(2);
  });

  it("serialises dates as ISO strings so they cross the server boundary", async () => {
    const application = await create();
    expect(typeof application.createdAt).toBe("string");
    expect(() => new Date(application.createdAt).toISOString()).not.toThrow();
    expect(application.student.dateOfBirth).toMatch(/^2016-05-10/);
  });
});

describe("printed application", () => {
  beforeAll(async () => {
    await startTestDatabase("pdf");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001", {
      institutionName: "Infinity School of Excellence",
      address: "Plot 14, Hebbal Industrial Area",
      city: "Mysore",
      state: "Karnataka",
      pincode: "570016",
      phone: "8212540111",
    });
  });

  it("renders a single-page A4 PDF carrying the institution's branding", async () => {
    const application = await ApplicationService.createApplication({
      institutionId: "INS0001",
      data: applicationInput,
      source: "API",
    });
    const institution = await Institution.findOne({ institutionId: "INS0001" }).lean();
    const pdf = await buildApplicationPdf(application, serializeInstitution(institution!));

    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(pdf.byteLength).toBeGreaterThan(1000);

    // A typical application must not spill onto a second sheet.
    const pageCount = pdf.toString("latin1").split("/Type /Page").length - 2;
    expect(pageCount).toBe(1);
  });

  it("survives an application with almost nothing filled in", async () => {
    const sparse = await ApplicationService.createApplication({
      institutionId: "INS0001",
      data: createApplicationSchema.parse({
        academicYear: "2026-27",
        student: { firstName: "Anon" },
        parent: { phone: "9876543210" },
        admission: { applyingFor: "Grade 1" },
      }),
      source: "WEBSITE",
    });
    const institution = await Institution.findOne({ institutionId: "INS0001" }).lean();

    const pdf = await buildApplicationPdf(sparse, serializeInstitution(institution!));
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("ignores a logo URL that is not http(s), rather than fetching it", async () => {
    // Guards the server against being pointed at a local file or internal host.
    const application = await ApplicationService.createApplication({
      institutionId: "INS0001",
      data: applicationInput,
      source: "API",
    });
    const institution = await Institution.findOne({ institutionId: "INS0001" }).lean();

    const pdf = await buildApplicationPdf(application, {
      ...serializeInstitution(institution!),
      logoUrl: "file:///etc/passwd",
    });
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
});
