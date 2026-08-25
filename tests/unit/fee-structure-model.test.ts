import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { FeeStructure } from "@/models";

const UNIT_A = new Types.ObjectId();
const UNIT_B = new Types.ObjectId();

beforeAll(async () => {
  await startTestDatabase("fee-structure-model");
  // Mongoose builds indexes in the background; without waiting the very first
  // duplicate write can race ahead of the unique index existing on the server.
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

const base = {
  institutionId: "INS0001",
  academicUnitId: UNIT_A,
  academicYear: "2026-27",
};

describe("FeeStructure model", () => {
  it("creates a document with DRAFT status by default and no publishedAt", async () => {
    const created = await FeeStructure.create(base);

    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();
    expect(String(created.academicUnitId)).toBe(String(UNIT_A));
  });

  it("requires an academic unit", async () => {
    await expect(
      FeeStructure.create({ institutionId: "INS0001", academicYear: "2026-27" }),
    ).rejects.toBeDefined();
  });

  it("enforces one record per institution, unit and academic year", async () => {
    await FeeStructure.create(base);

    await expect(FeeStructure.create(base)).rejects.toMatchObject({ code: 11000 });
  });

  it("allows the same unit in a second year, and the same year for a second unit", async () => {
    await FeeStructure.create(base);

    await expect(
      FeeStructure.create({ ...base, academicYear: "2027-28" }),
    ).resolves.toBeDefined();
    await expect(FeeStructure.create({ ...base, academicUnitId: UNIT_B })).resolves.toBeDefined();
  });

  it("refuses only on the new key once stale classOrCourse indexes are gone", async () => {
    // Guards the Phase 4 -> Phase 6 index migration (scripts/sync-fee-indexes.ts).
    // A surviving `{institutionId, classOrCourse, academicYear}` unique index would
    // index every new document as `classOrCourse: null` and refuse the SECOND fee
    // structure for an institution in a year, whatever unit it points at.
    const indexes = await FeeStructure.collection.indexes();
    expect(indexes.some((index) => "classOrCourse" in (index.key ?? {}))).toBe(false);

    await FeeStructure.create(base);
    // A different unit, same institution and year, must be accepted.
    await expect(FeeStructure.create({ ...base, academicUnitId: UNIT_B })).resolves.toBeDefined();
  });
});
