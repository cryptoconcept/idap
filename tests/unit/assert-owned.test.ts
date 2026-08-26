import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit } from "@/models";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { assertOwnedAcademicUnit } from "@/lib/academic/assert-owned";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(async () => {
  await startTestDatabase("assert-owned");
  await AcademicUnit.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("assertOwnedAcademicUnit", () => {
  it("returns the unit when it belongs to the calling institution", async () => {
    const unit = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 10" },
      actor,
    );

    const found = await assertOwnedAcademicUnit("INS0001", unit.id);

    expect(found).not.toBeNull();
    expect(found?.pathLabel).toBe("Grade 10");
  });

  it("returns null when no id is supplied", async () => {
    expect(await assertOwnedAcademicUnit("INS0001", undefined)).toBeNull();
  });

  it("throws NOT_FOUND for another institution's unit", async () => {
    const foreign = await AcademicStructureService.create(
      "INS0002",
      { segment: "SCHOOL", name: "Grade 10" },
      actor,
    );

    await expect(assertOwnedAcademicUnit("INS0001", foreign.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws NOT_FOUND for a malformed id rather than a cast error", async () => {
    await expect(assertOwnedAcademicUnit("INS0001", "not-an-object-id")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
