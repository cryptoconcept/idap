import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { AcademicUnit } from "@/models";

beforeAll(async () => {
  await startTestDatabase("academic-unit-model");
  // Mongoose builds indexes in the background; without waiting here the very
  // first duplicate write can race ahead of the unique index existing on the
  // server. Same pattern as fee-structure-model.test.ts.
  await AcademicUnit.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

const root = {
  institutionId: "INS0001",
  segment: "SCHOOL",
  parentId: null,
  depth: 0,
  name: "Grade 1",
  pathLabel: "Grade 1",
};

describe("AcademicUnit model", () => {
  it("creates a root that is active and sorted first by default", async () => {
    const created = await AcademicUnit.create(root);

    expect(created.active).toBe(true);
    expect(created.sortOrder).toBe(0);
    expect(created.parentId).toBeNull();
  });

  it("refuses two siblings with the same name under the same parent", async () => {
    await AcademicUnit.create(root);

    await expect(AcademicUnit.create(root)).rejects.toMatchObject({ code: 11000 });
  });

  it("allows the same name under two different parents", async () => {
    const first = await AcademicUnit.create({
      ...root,
      segment: "PRE_UNIVERSITY",
      name: "PUC 1st Year",
      pathLabel: "PUC 1st Year",
    });
    const second = await AcademicUnit.create({
      ...root,
      segment: "PRE_UNIVERSITY",
      name: "PUC 2nd Year",
      pathLabel: "PUC 2nd Year",
    });

    await AcademicUnit.create({
      institutionId: "INS0001",
      segment: "PRE_UNIVERSITY",
      parentId: first._id,
      depth: 1,
      name: "PCMB",
      pathLabel: "PUC 1st Year › PCMB",
    });

    await expect(
      AcademicUnit.create({
        institutionId: "INS0001",
        segment: "PRE_UNIVERSITY",
        parentId: second._id,
        depth: 1,
        name: "PCMB",
        pathLabel: "PUC 2nd Year › PCMB",
      }),
    ).resolves.toBeDefined();
  });

  it("allows the same name in two institutions and in two segments", async () => {
    await AcademicUnit.create(root);

    await expect(AcademicUnit.create({ ...root, institutionId: "INS0002" })).resolves.toBeDefined();
    await expect(AcademicUnit.create({ ...root, segment: "COACHING" })).resolves.toBeDefined();
  });
});
