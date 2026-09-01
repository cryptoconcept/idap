import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeProfiledInstitution } from "../helpers/factories";
import { GET as getByInstitutionId } from "@/app/api/public/[institutionId]/fees/route";
import { GET as getBySlug } from "@/app/api/public/institutions/[slug]/fees/route";
import { AcademicUnit, FeeStructure } from "@/models";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { FeeStructureService } from "@/services/fee-structure.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };
const lineItems = [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" as const }];

/** A root SCHOOL unit named "Grade 10" — its pathLabel is just the name. */
function unitFor(institutionId: string) {
  return AcademicStructureService.create(institutionId, { segment: "SCHOOL", name: "Grade 10" }, actor);
}

beforeAll(async () => {
  await startTestDatabase("fee-structure-public");
  await AcademicUnit.syncIndexes();
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("GET /api/public/:institutionId/fees", () => {
  it("returns a published fee structure by institutionId", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    const unit = await unitFor("INS0001");
    const created = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unit.id, academicYear: "2026-27", lineItems },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.feeStructures).toHaveLength(1);
    expect(payload.feeStructures[0].classOrCourse).toBe("Grade 10");
  });

  it("returns a published fee structure by slug", async () => {
    await makeProfiledInstitution("INS0001", {
      profileStatus: "PUBLISHED",
      slug: "infinity-school",
    });
    const unit = await unitFor("INS0001");
    const created = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unit.id, academicYear: "2026-27", lineItems },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getBySlug(
      new Request("http://localhost/api/public/institutions/infinity-school/fees"),
      { params: Promise.resolve({ slug: "infinity-school" }) } as never,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).feeStructures).toHaveLength(1);
  });

  it("returns an empty list, not a 404, when the institution has no published fee structures", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).feeStructures).toEqual([]);
  });

  it("excludes a draft fee structure", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    const unit = await unitFor("INS0001");
    await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unit.id, academicYear: "2026-27" },
      actor,
    );

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect((await response.json()).feeStructures).toEqual([]);
  });

  it("excludes an archived fee structure", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    const unit = await unitFor("INS0001");
    const created = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unit.id, academicYear: "2026-27", lineItems },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);
    await FeeStructureService.setStatus("INS0001", created.id, "archive", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect((await response.json()).feeStructures).toEqual([]);
  });

  it("404s for a suspended institution even with a published fee structure", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED", active: false });
    const unit = await unitFor("INS0001");
    const created = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unit.id, academicYear: "2026-27", lineItems },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("404s for a nonexistent institution", async () => {
    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS9999/fees"),
      { params: Promise.resolve({ institutionId: "INS9999" }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("filters by academicYear", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    const unit = await unitFor("INS0001");
    const older = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unit.id, academicYear: "2025-26", lineItems },
      actor,
    );
    const newer = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unit.id, academicYear: "2026-27", lineItems },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", older.id, "publish", actor);
    await FeeStructureService.setStatus("INS0001", newer.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees?academicYear=2025-26"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    const payload = await response.json();
    expect(payload.feeStructures).toHaveLength(1);
    expect(payload.feeStructures[0].academicYear).toBe("2025-26");
  });

  it("sets a 5-minute Cache-Control header", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    // Public reads now carry a 60s cache (was 300) so an unpublish reflects
    // within a minute — see the audit M1 fix.
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("trips the shared public-read rate limit after 60 requests from one caller", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });

    let last;
    for (let i = 0; i < 61; i += 1) {
      last = await getByInstitutionId(new Request("http://localhost/api/public/INS0001/fees"), {
        params: Promise.resolve({ institutionId: "INS0001" }),
      } as never);
    }

    expect(last!.status).toBe(429);
  });
});
