import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { Scholarship } from "@/models";

beforeAll(async () => {
  await startTestDatabase("scholarship-model");
  await Scholarship.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("Scholarship model", () => {
  it("defaults a new scholarship to DRAFT with no publishedAt", async () => {
    const created = await Scholarship.create({
      institutionId: "INS0001",
      name: "Merit Scholarship",
    });

    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();
  });

  it("requires a name", async () => {
    await expect(Scholarship.create({ institutionId: "INS0001" })).rejects.toThrow();
  });

  it("rejects a status outside the enum", async () => {
    await expect(
      Scholarship.create({ institutionId: "INS0001", name: "X", status: "LIVE" }),
    ).rejects.toThrow();
  });

  it("stores amount as free-form text, not a number", async () => {
    const created = await Scholarship.create({
      institutionId: "INS0001",
      name: "Merit Scholarship",
      amount: "100% tuition for ranks 1-10",
    });

    expect(created.amount).toBe("100% tuition for ranks 1-10");
  });

  it("accepts an optional academicUnitId and leaves it unset when absent", async () => {
    const unitId = new Types.ObjectId();
    const scoped = await Scholarship.create({
      institutionId: "INS0001",
      name: "Science Merit",
      academicUnitId: unitId,
    });
    const wide = await Scholarship.create({ institutionId: "INS0001", name: "General Merit" });

    expect(String(scoped.academicUnitId)).toBe(String(unitId));
    expect(wide.academicUnitId).toBeUndefined();
  });
});
