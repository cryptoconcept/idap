import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit, FeeStructure } from "@/models";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { FeeStructureService } from "@/services/fee-structure.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(async () => {
  await startTestDatabase("fee-structure-enrichment");
  await AcademicUnit.syncIndexes();
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001", { active: true, profileStatus: "PUBLISHED" });
});

const fee = (academicUnitId: string, academicYear = "2026-27") => ({
  academicUnitId,
  academicYear,
  lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" as const }],
});

describe("fee structure labels are derived, not stored", () => {
  it("reads the unit's full path, not just its name", async () => {
    await AcademicStructureService.setSegments("INS0001", ["PRE_UNIVERSITY"], actor);
    const year = await AcademicStructureService.create(
      "INS0001",
      { segment: "PRE_UNIVERSITY", name: "PUC 1st Year" },
      actor,
    );
    const combination = await AcademicStructureService.create(
      "INS0001",
      { segment: "PRE_UNIVERSITY", parentId: year.id, name: "PCMB" },
      actor,
    );
    const created = await FeeStructureService.create("INS0001", fee(combination.id), actor);

    expect(created.classOrCourse).toBe("PUC 1st Year › PCMB");
  });

  it("reflects a rename on the next read, admin and public alike", async () => {
    // The whole point of deriving rather than storing: no cascade, no staleness.
    const grade = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 10" },
      actor,
    );
    const created = await FeeStructureService.create("INS0001", fee(grade.id), actor);
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    await AcademicStructureService.update("INS0001", grade.id, { name: "Class 10" }, actor);

    expect((await FeeStructureService.get("INS0001", created.id)).classOrCourse).toBe("Class 10");
    const published = await FeeStructureService.listPublic({ institutionId: "INS0001" });
    expect(published?.[0]?.classOrCourse).toBe("Class 10");
  });

  it("sorts the admin list by the derived label within a year", async () => {
    const b = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Beta" },
      actor,
    );
    const a = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Alpha" },
      actor,
    );
    await FeeStructureService.create("INS0001", fee(b.id), actor);
    await FeeStructureService.create("INS0001", fee(a.id), actor);

    const listed = await FeeStructureService.list("INS0001");
    expect(listed.map((row) => row.classOrCourse)).toEqual(["Alpha", "Beta"]);
  });
});
