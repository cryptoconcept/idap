import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit, FeeStructure } from "@/models";
import { FeeStructureService } from "@/services/fee-structure.service";
import { AcademicStructureService, type AcademicUnitDTO } from "@/services/academic-structure.service";
import type { BulkCreateFeeInput } from "@/lib/validation/fee-structure";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

let unitA: AcademicUnitDTO;
let unitB: AcademicUnitDTO;
let foreignUnit: AcademicUnitDTO;

function input(overrides: Partial<BulkCreateFeeInput> = {}): BulkCreateFeeInput {
  return {
    academicUnitIds: [unitA.id, unitB.id],
    academicYear: "2026-27",
    lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" as const }],
    ...overrides,
  };
}

beforeAll(async () => {
  await startTestDatabase("fee-bulk-create");
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");

  await AcademicUnit.syncIndexes();
  unitA = await AcademicStructureService.create(
    "INS0001",
    { segment: "SCHOOL", name: "Grade 10" },
    actor,
  );
  unitB = await AcademicStructureService.create(
    "INS0001",
    { segment: "SCHOOL", name: "Grade 9" },
    actor,
  );
  foreignUnit = await AcademicStructureService.create(
    "INS0002",
    { segment: "SCHOOL", name: "Grade 10" },
    actor,
  );
});

describe("FeeStructureService.createMany", () => {
  it("creates a draft for every selected unit", async () => {
    const result = await FeeStructureService.createMany("INS0001", input(), actor);

    expect(result.created).toBe(2);
    expect(result.skipped).toHaveLength(0);

    const rows = await FeeStructure.find({ institutionId: "INS0001" }).lean();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("DRAFT");
      expect(row.publishedAt).toBeUndefined();
    }
  });

  it("skips an already-priced unit and names it by path label", async () => {
    await FeeStructureService.createMany(
      "INS0001",
      input({ academicUnitIds: [unitA.id] }),
      actor,
    );

    const result = await FeeStructureService.createMany(
      "INS0001",
      input({ academicUnitIds: [unitA.id, unitB.id] }),
      actor,
    );

    expect(result.created).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.academicUnitId).toBe(unitA.id);
    expect(result.skipped[0]?.classOrCourse).toBe(unitA.pathLabel);
  });

  it("returns created: 0 with every unit skipped when all are already priced", async () => {
    await FeeStructureService.createMany("INS0001", input(), actor);

    const result = await FeeStructureService.createMany("INS0001", input(), actor);

    expect(result.created).toBe(0);
    expect(result.skipped).toHaveLength(2);
    const skippedIds = result.skipped.map((row) => row.academicUnitId).sort();
    expect(skippedIds).toEqual([unitA.id, unitB.id].sort());
  });

  it("fails the whole batch with NOT_FOUND for a foreign academicUnitId, writing nothing", async () => {
    await expect(
      FeeStructureService.createMany(
        "INS0001",
        input({ academicUnitIds: [unitA.id, foreignUnit.id] }),
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The only assertion that catches a batch which half-applies before
    // failing: unitA must NOT have been written even though it is valid.
    expect(await FeeStructure.countDocuments({})).toBe(0);
  });

  it("fails with NOT_FOUND, never a 500, for a malformed academicUnitId", async () => {
    await expect(
      FeeStructureService.createMany(
        "INS0001",
        input({ academicUnitIds: [unitA.id, "not-an-object-id"] }),
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await FeeStructure.countDocuments({})).toBe(0);
  });

  it("refuses duplicate line-item labels before anything is written", async () => {
    await expect(
      FeeStructureService.createMany(
        "INS0001",
        input({
          lineItems: [
            { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
            { label: "Tuition", amount: 1000, frequency: "ONE_TIME" },
          ],
        }),
        actor,
      ),
    ).rejects.toThrow(/appears more than once/i);

    expect(await FeeStructure.countDocuments({})).toBe(0);
  });
});
