import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit } from "@/models";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { InstitutionService } from "@/services/institution.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

async function publishedInstitution(institutionId: string, overrides: Record<string, unknown> = {}) {
  return makeInstitution(institutionId, {
    active: true,
    profileStatus: "PUBLISHED",
    ...overrides,
  });
}

beforeAll(async () => {
  await startTestDatabase("academic-structure-profile");
  await AcademicUnit.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("public profile offerings", () => {
  it("keeps publishing the stored arrays while no tree exists", async () => {
    await publishedInstitution("INS0001", {
      academic: { classesOffered: ["Typed by hand"], coursesOffered: ["Also typed"] },
    });

    const profile = await InstitutionService.getPublicProfile({ institutionId: "INS0001" });

    expect(profile?.academic?.classesOffered).toEqual(["Typed by hand"]);
    expect(profile?.academic?.coursesOffered).toEqual(["Also typed"]);
  });

  it("publishes the derived values once a tree exists", async () => {
    await publishedInstitution("INS0002", {
      academic: { classesOffered: ["Stale"], coursesOffered: ["Also stale"] },
    });
    await AcademicStructureService.create("INS0002", { segment: "SCHOOL", name: "Grade 9" }, actor);
    await AcademicStructureService.create("INS0002", { segment: "SCHOOL", name: "Grade 10" }, actor);

    const profile = await InstitutionService.getPublicProfile({ institutionId: "INS0002" });

    expect(profile?.academic?.classesOffered).toEqual(["Grade 9", "Grade 10"]);
    // The course tree is empty, so the stored courses keep publishing. Deriving one
    // array must never silently unpublish the other.
    expect(profile?.academic?.coursesOffered).toEqual(["Also stale"]);
  });

  it("reads a PU tree at the combination tier", async () => {
    await publishedInstitution("INS0003", { institutionType: "PU_COLLEGE" });
    const year = await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", name: "PUC 1st Year" },
      actor,
    );
    await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", parentId: year.id, name: "PCMB" },
      actor,
    );

    const profile = await InstitutionService.getPublicProfile({ institutionId: "INS0003" });

    expect(profile?.academic?.coursesOffered).toEqual(["PCMB"]);
    expect(profile?.academic?.classesOffered).toBeUndefined();
  });

  it("falls back to the stored arrays when every unit is deactivated", async () => {
    await publishedInstitution("INS0004", { academic: { classesOffered: ["Fallback"] } });
    const grade = await AcademicStructureService.create(
      "INS0004",
      { segment: "SCHOOL", name: "Grade 1" },
      actor,
    );
    await AcademicStructureService.update("INS0004", grade.id, { active: false }, actor);

    const profile = await InstitutionService.getPublicProfile({ institutionId: "INS0004" });

    expect(profile?.academic?.classesOffered).toEqual(["Fallback"]);
  });

  it("scores the academic section complete from a tree, with no stored arrays", async () => {
    await publishedInstitution("INS0005", { academic: { board: "State" } });
    await AcademicStructureService.create("INS0005", { segment: "SCHOOL", name: "Grade 1" }, actor);

    const { completion } = await InstitutionService.getProfile("INS0005");
    const academic = completion.groups.find((group) => group.key === "academic");

    expect(academic?.missing).not.toContain("Classes or courses offered");
  });

  it("does not unpublish stored courses when only a class tree exists", async () => {
    await publishedInstitution("INS0006", {
      academic: { classesOffered: ["Old 1", "Old 2"], coursesOffered: ["PCMB", "CEBA"] },
    });
    // One hand-typed class, mid-migration — the exact keystroke that used to wipe
    // both arrays.
    await AcademicStructureService.create("INS0006", { segment: "SCHOOL", name: "Grade 1" }, actor);

    const profile = await InstitutionService.getPublicProfile({ institutionId: "INS0006" });

    expect(profile?.academic?.classesOffered).toEqual(["Grade 1"]);
    expect(profile?.academic?.coursesOffered).toEqual(["PCMB", "CEBA"]);
  });
});
