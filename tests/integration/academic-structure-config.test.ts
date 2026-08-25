import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit } from "@/models";
import { AcademicStructureService } from "@/services/academic-structure.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(async () => {
  await startTestDatabase("academic-structure-config");
  await AcademicUnit.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002", { institutionType: "PU_COLLEGE" });
});

async function grades(institutionId: string, ...names: string[]) {
  const created = [];
  for (const name of names) {
    created.push(
      await AcademicStructureService.create(institutionId, { segment: "SCHOOL", name }, actor),
    );
  }
  return created;
}

describe("AcademicStructureService reorder", () => {
  it("rewrites sortOrder to match the order it was given", async () => {
    const [one, two, three] = await grades("INS0001", "Grade 1", "Grade 2", "Grade 3");

    const reordered = await AcademicStructureService.reorder(
      "INS0001",
      { segment: "SCHOOL", parentId: null, orderedIds: [three.id, one.id, two.id] },
      actor,
    );

    expect(reordered.map((unit) => unit.name)).toEqual(["Grade 3", "Grade 1", "Grade 2"]);
    expect(reordered.map((unit) => unit.sortOrder)).toEqual([0, 1, 2]);
  });

  it("refuses a partial sibling list rather than silently interleaving", async () => {
    const [one] = await grades("INS0001", "Grade 1", "Grade 2");

    await expect(
      AcademicStructureService.reorder(
        "INS0001",
        { segment: "SCHOOL", parentId: null, orderedIds: [one.id] },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("refuses a list holding another institution's id", async () => {
    const [mine, alsoMine] = await grades("INS0001", "Grade 1", "Grade 2");
    // INS0002 is a PU college, so its unit lives in its own segment. What makes
    // this fail is ownership, not the segment: the id is simply not in INS0001's
    // sibling set, which is the tenant check and the completeness check at once.
    const theirs = await AcademicStructureService.create(
      "INS0002",
      { segment: "PRE_UNIVERSITY", name: "PUC 1st Year" },
      actor,
    );
    expect(theirs.id).not.toBe(mine.id);

    await expect(
      AcademicStructureService.reorder(
        "INS0001",
        { segment: "SCHOOL", parentId: null, orderedIds: [mine.id, theirs.id] },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // The legitimate sibling is untouched by the refusal.
    const after = await AcademicStructureService.list("INS0001");
    expect(after.find((unit) => unit.id === alsoMine.id)?.sortOrder).toBe(1);
  });
});

describe("AcademicStructureService segments", () => {
  it("falls back to the institution type's default until one is chosen", async () => {
    expect(await AcademicStructureService.getSegments("INS0001")).toEqual(["SCHOOL"]);
    expect(await AcademicStructureService.getSegments("INS0002")).toEqual(["PRE_UNIVERSITY"]);
  });

  it("stores a selection in declaration order, not the order it was given", async () => {
    const saved = await AcademicStructureService.setSegments(
      "INS0001",
      ["PRE_UNIVERSITY", "SCHOOL"],
      actor,
    );

    expect(saved).toEqual(["SCHOOL", "PRE_UNIVERSITY"]);
    expect(await AcademicStructureService.getSegments("INS0001")).toEqual([
      "SCHOOL",
      "PRE_UNIVERSITY",
    ]);
  });

  it("refuses to deselect a segment that still holds units", async () => {
    await AcademicStructureService.setSegments("INS0001", ["SCHOOL", "PRE_UNIVERSITY"], actor);
    await grades("INS0001", "Grade 1");

    await expect(
      AcademicStructureService.setSegments("INS0001", ["PRE_UNIVERSITY"], actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("allows deselecting a segment that holds nothing", async () => {
    await AcademicStructureService.setSegments("INS0001", ["SCHOOL", "PRE_UNIVERSITY"], actor);
    await grades("INS0001", "Grade 1");

    await expect(
      AcademicStructureService.setSegments("INS0001", ["SCHOOL"], actor),
    ).resolves.toEqual(["SCHOOL"]);
  });
});

describe("AcademicStructureService seeding", () => {
  it("seeds classes and courses into the segments spec §10 tabulates", async () => {
    await makeInstitution("INS0003", {
      institutionType: "SCHOOL",
      academic: {
        classesOffered: ["Grade 1", "Grade 2"],
        coursesOffered: ["PCMB"],
        segments: ["SCHOOL", "PRE_UNIVERSITY"],
      },
    });

    const result = await AcademicStructureService.seedFromProfile("INS0003", actor);
    expect(result).toEqual({ created: 3, skipped: 0 });

    const units = await AcademicStructureService.list("INS0003");
    expect(units.filter((unit) => unit.segment === "SCHOOL").map((unit) => unit.name)).toEqual([
      "Grade 1",
      "Grade 2",
    ]);
    expect(
      units.filter((unit) => unit.segment === "PRE_UNIVERSITY").map((unit) => unit.name),
    ).toEqual(["PCMB"]);
  });

  it("falls back to the only selected segment when the preferred one is not selected", async () => {
    await makeInstitution("INS0004", {
      institutionType: "PU_COLLEGE",
      academic: { classesOffered: ["Grade 1"], segments: ["PRE_UNIVERSITY"] },
    });

    await AcademicStructureService.seedFromProfile("INS0004", actor);

    const units = await AcademicStructureService.list("INS0004");
    expect(units).toHaveLength(1);
    expect(units[0].segment).toBe("PRE_UNIVERSITY");
  });

  it("skips blanks and repeats, and reports how many it skipped", async () => {
    await makeInstitution("INS0005", {
      academic: { classesOffered: ["Grade 1", "  ", "Grade 1", "Grade 2"], segments: ["SCHOOL"] },
    });

    expect(await AcademicStructureService.seedFromProfile("INS0005", actor)).toEqual({
      created: 2,
      skipped: 2,
    });
  });

  it("refuses a second run, leaving the first run's units untouched", async () => {
    await makeInstitution("INS0006", {
      academic: { classesOffered: ["Grade 1"], segments: ["SCHOOL"] },
    });
    await AcademicStructureService.seedFromProfile("INS0006", actor);

    await expect(AcademicStructureService.seedFromProfile("INS0006", actor)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(await AcademicStructureService.list("INS0006")).toHaveLength(1);
  });

  it("reports whether there is anything on the profile worth seeding", async () => {
    await makeInstitution("INS0007", { academic: { classesOffered: ["Grade 1"] } });

    expect(await AcademicStructureService.hasProfileOfferings("INS0007")).toBe(true);
    expect(await AcademicStructureService.hasProfileOfferings("INS0001")).toBe(false);
  });
});

describe("AcademicStructureService offeringsFor", () => {
  it("returns null with no tree, and derived arrays once one exists", async () => {
    expect(await AcademicStructureService.offeringsFor("INS0001")).toBeNull();

    await grades("INS0001", "Grade 1");
    expect(await AcademicStructureService.offeringsFor("INS0001")).toEqual({
      classesOffered: ["Grade 1"],
      coursesOffered: [],
    });
  });

  it("returns null once every unit has been deactivated", async () => {
    const [one] = await grades("INS0001", "Grade 1");
    await AcademicStructureService.update("INS0001", one.id, { active: false }, actor);

    expect(await AcademicStructureService.offeringsFor("INS0001")).toBeNull();
  });
});
