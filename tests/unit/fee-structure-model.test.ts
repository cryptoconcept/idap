import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { FeeStructure } from "@/models";

beforeAll(async () => {
  await startTestDatabase("fee-structure-model");
  // Mongoose builds indexes in the background; without waiting for it here,
  // the very first duplicate write can race ahead of the unique index
  // actually existing on the server. Same pattern as results-crud.test.ts.
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("FeeStructure model", () => {
  it("creates a document with DRAFT status by default and no publishedAt", async () => {
    const created = await FeeStructure.create({
      institutionId: "INS0001",
      classOrCourse: "Grade 10",
      academicYear: "2026-27",
    });

    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();
  });

  it("enforces one record per institution, class/course and academic year", async () => {
    await FeeStructure.create({
      institutionId: "INS0001",
      classOrCourse: "Grade 10",
      academicYear: "2026-27",
    });

    await expect(
      FeeStructure.create({
        institutionId: "INS0001",
        classOrCourse: "Grade 10",
        academicYear: "2026-27",
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("allows the same class/course and year across two institutions", async () => {
    await FeeStructure.create({
      institutionId: "INS0001",
      classOrCourse: "Grade 10",
      academicYear: "2026-27",
    });

    await expect(
      FeeStructure.create({
        institutionId: "INS0002",
        classOrCourse: "Grade 10",
        academicYear: "2026-27",
      }),
    ).resolves.toBeDefined();
  });
});
