import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Types } from "mongoose";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { ScholarshipApplication } from "@/models";

beforeAll(async () => {
  await startTestDatabase("scholarship-application-model");
  // Mongoose builds indexes in the background; without waiting here the first
  // duplicate write can race ahead of the unique index. Same pattern as
  // academic-unit-model.test.ts.
  await ScholarshipApplication.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

function baseFields(overrides: Record<string, unknown> = {}) {
  return {
    institutionId: "INS0001",
    scholarshipId: new Types.ObjectId(),
    externalRef: "IDAP:INS0001:" + new Types.ObjectId().toHexString(),
    hubApplicationId: new Types.ObjectId().toHexString(),
    applicant: { name: "Asha Rao", email: "asha@example.com" },
    hubStatus: "submitted",
    hubUpdatedAt: new Date(),
    lastSyncedAt: new Date(),
    ...overrides,
  };
}

describe("ScholarshipApplication model", () => {
  it("defaults reviewStatus to NEW and persists required fields", async () => {
    const row = await ScholarshipApplication.create(baseFields());
    expect(row.reviewStatus).toBe("NEW");
    expect(row.applicant.name).toBe("Asha Rao");
    expect(row.hubStatus).toBe("submitted");
  });

  it("enforces one row per (institutionId, hubApplicationId)", async () => {
    const hubApplicationId = new Types.ObjectId().toHexString();
    await ScholarshipApplication.create(baseFields({ hubApplicationId }));
    await expect(ScholarshipApplication.create(baseFields({ hubApplicationId }))).rejects.toMatchObject({
      code: 11000,
    });
  });

  it("allows the SAME hubApplicationId across two different institutions", async () => {
    const hubApplicationId = new Types.ObjectId().toHexString();
    await ScholarshipApplication.create(baseFields({ hubApplicationId, institutionId: "INS0001" }));
    await expect(
      ScholarshipApplication.create(baseFields({ hubApplicationId, institutionId: "INS0002" })),
    ).resolves.toBeDefined();
  });

  it("rejects an invalid hubStatus or reviewStatus value", async () => {
    await expect(ScholarshipApplication.create(baseFields({ hubStatus: "not-a-real-status" }))).rejects.toThrow();
    await expect(
      ScholarshipApplication.create(baseFields({ reviewStatus: "NOT_A_REAL_STATUS" })),
    ).rejects.toThrow();
  });

  it("carries the (institutionId, hubApplicationId) unique index", async () => {
    const indexes = await ScholarshipApplication.collection.indexes();
    const target = indexes.find(
      (idx) => JSON.stringify(idx.key) === JSON.stringify({ institutionId: 1, hubApplicationId: 1 }),
    );
    expect(target?.unique).toBe(true);
  });
});
