import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit } from "@/models";
import { AcademicStructureService } from "@/services/academic-structure.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(async () => {
  await startTestDatabase("academic-structure-crud");
  await AcademicUnit.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  // makeInstitution defaults institutionType to SCHOOL, so INS0001's default
  // segment selection is ["SCHOOL"] until a test overrides it.
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
  await makeInstitution("INS0003", { institutionType: "PU_COLLEGE" });
  await makeInstitution("INS0004", { institutionType: "ENGINEERING_COLLEGE" });
});

describe("AcademicStructureService CRUD", () => {
  it("creates a root at depth 0 with its name as the whole path", async () => {
    const created = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 1" },
      actor,
    );

    expect(created.depth).toBe(0);
    expect(created.parentId).toBeNull();
    expect(created.pathLabel).toBe("Grade 1");
    expect(created.sortOrder).toBe(0);
    expect(created.active).toBe(true);
    expect(created.levelKey).toBe("CLASS");
    expect(created.levelLabel).toBe("Class");
  });

  it("appends each new sibling after the last one", async () => {
    await AcademicStructureService.create("INS0001", { segment: "SCHOOL", name: "Grade 1" }, actor);
    const second = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 2" },
      actor,
    );

    expect(second.sortOrder).toBe(1);
  });

  it("creates a child at depth 1 with a joined path label", async () => {
    const year = await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", name: "PUC 1st Year" },
      actor,
    );
    const combination = await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", parentId: year.id, name: "PCMB" },
      actor,
    );

    expect(combination.depth).toBe(1);
    expect(combination.parentId).toBe(year.id);
    expect(combination.pathLabel).toBe("PUC 1st Year › PCMB");
    expect(combination.levelKey).toBe("COMBINATION");
  });

  it("refuses a duplicate sibling name via the unique index, not a pre-read", async () => {
    await AcademicStructureService.create("INS0001", { segment: "SCHOOL", name: "Grade 1" }, actor);

    await expect(
      AcademicStructureService.create("INS0001", { segment: "SCHOOL", name: "Grade 1" }, actor),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("allows the same name under two different parents", async () => {
    const first = await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", name: "PUC 1st Year" },
      actor,
    );
    const second = await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", name: "PUC 2nd Year" },
      actor,
    );

    await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", parentId: first.id, name: "PCMB" },
      actor,
    );
    await expect(
      AcademicStructureService.create(
        "INS0003",
        { segment: "PRE_UNIVERSITY", parentId: second.id, name: "PCMB" },
        actor,
      ),
    ).resolves.toBeDefined();
  });

  it("refuses a child deeper than the blueprint allows", async () => {
    const grade = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 1" },
      actor,
    );

    await expect(
      AcademicStructureService.create(
        "INS0001",
        { segment: "SCHOOL", parentId: grade.id, name: "Section A" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("refuses a parent that belongs to a different segment", async () => {
    await AcademicStructureService.setSegments("INS0004", ["ENGINEERING", "SCHOOL"], actor);
    const programme = await AcademicStructureService.create(
      "INS0004",
      { segment: "ENGINEERING", name: "B.E." },
      actor,
    );

    await expect(
      AcademicStructureService.create(
        "INS0004",
        { segment: "SCHOOL", parentId: programme.id, name: "Grade 1" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("refuses a segment the institution has not selected", async () => {
    await expect(
      AcademicStructureService.create("INS0001", { segment: "UNIVERSITY", name: "UG" }, actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("cascades a rename all the way down to grandchildren", async () => {
    await AcademicStructureService.setSegments("INS0004", ["ENGINEERING"], actor);
    const programme = await AcademicStructureService.create(
      "INS0004",
      { segment: "ENGINEERING", name: "B.E." },
      actor,
    );
    const branch = await AcademicStructureService.create(
      "INS0004",
      { segment: "ENGINEERING", parentId: programme.id, name: "Computer Science" },
      actor,
    );
    const year = await AcademicStructureService.create(
      "INS0004",
      { segment: "ENGINEERING", parentId: branch.id, name: "Year 1" },
      actor,
    );

    await AcademicStructureService.update("INS0004", programme.id, { name: "B.Tech" }, actor);

    const units = await AcademicStructureService.list("INS0004");
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    expect(byId.get(programme.id)?.pathLabel).toBe("B.Tech");
    expect(byId.get(branch.id)?.pathLabel).toBe("B.Tech › Computer Science");
    expect(byId.get(year.id)?.pathLabel).toBe("B.Tech › Computer Science › Year 1");
  });

  it("deletes the whole subtree, not just the node", async () => {
    await AcademicStructureService.setSegments("INS0004", ["ENGINEERING"], actor);
    const programme = await AcademicStructureService.create(
      "INS0004",
      { segment: "ENGINEERING", name: "B.E." },
      actor,
    );
    const branch = await AcademicStructureService.create(
      "INS0004",
      { segment: "ENGINEERING", parentId: programme.id, name: "Computer Science" },
      actor,
    );
    await AcademicStructureService.create(
      "INS0004",
      { segment: "ENGINEERING", parentId: branch.id, name: "Year 1" },
      actor,
    );

    const result = await AcademicStructureService.remove("INS0004", programme.id, actor);

    expect(result.deleted).toBe(3);
    expect(await AcademicStructureService.list("INS0004")).toHaveLength(0);
  });

  it("treats another institution's unit, and another institution's parent, as not found", async () => {
    const mine = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 1" },
      actor,
    );

    await expect(AcademicStructureService.update("INS0002", mine.id, { name: "X" }, actor))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(AcademicStructureService.remove("INS0002", mine.id, actor))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      AcademicStructureService.create(
        "INS0002",
        { segment: "SCHOOL", parentId: mine.id, name: "Grade 2" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A malformed id is the same answer, not a 500.
    await expect(AcademicStructureService.update("INS0001", "not-an-id", { name: "X" }, actor))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a rename whose parent vanished instead of inventing a root-shaped path", async () => {
    const year = await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", name: "PUC 1st Year" },
      actor,
    );
    const combination = await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", parentId: year.id, name: "PCMB" },
      actor,
    );

    // Deleted straight through the model, bypassing the service, to simulate the
    // parent disappearing underneath a rename. `remove` would have taken the
    // child with it.
    await AcademicUnit.deleteOne({ _id: year.id });

    await expect(
      AcademicStructureService.update("INS0003", combination.id, { name: "PCMC" }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
