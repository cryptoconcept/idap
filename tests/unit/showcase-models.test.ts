import { describe, expect, it } from "vitest";
import { Achievement } from "@/models/Achievement";
import { Alumnus } from "@/models/Alumnus";
import { ACHIEVEMENT_LEVELS, SHOWCASE_STATUSES } from "@/lib/constants";

describe("Achievement model", () => {
  it("requires institutionId, category and title", () => {
    const doc = new Achievement({});
    const err = doc.validateSync();

    expect(err?.errors.institutionId).toBeDefined();
    expect(err?.errors.category).toBeDefined();
    expect(err?.errors.title).toBeDefined();
  });

  it("rejects a category outside the enum", () => {
    const doc = new Achievement({
      institutionId: "INS0001",
      category: "MUSIC",
      title: "State Chess Champion",
    });

    expect(doc.validateSync()?.errors.category).toBeDefined();
  });

  it("rejects a level outside the enum", () => {
    const doc = new Achievement({
      institutionId: "INS0001",
      category: "ACADEMIC",
      title: "State Chess Champion",
      level: "COUNTRY",
    });

    expect(doc.validateSync()?.errors.level).toBeDefined();
  });

  it("defaults status to ACTIVE", () => {
    const doc = new Achievement({
      institutionId: "INS0001",
      category: "ACADEMIC",
      title: "State Chess Champion",
    });

    expect(doc.status).toBe("ACTIVE");
  });

  it("defaults level to SCHOOL when absent, and SCHOOL is a member of ACHIEVEMENT_LEVELS", () => {
    const doc = new Achievement({
      institutionId: "INS0001",
      category: "ACADEMIC",
      title: "State Chess Champion",
    });

    expect(doc.level).toBe("SCHOOL");
    expect(ACHIEVEMENT_LEVELS).toContain(doc.level);
  });

  it("accepts an array of students with name and grade", () => {
    const doc = new Achievement({
      institutionId: "INS0001",
      category: "ACADEMIC",
      title: "State Chess Champion",
      students: [
        { name: "Priya S", grade: "10" },
        { name: "Rahul K", grade: "9" },
      ],
    });

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.students?.[0]?.name).toBe("Priya S");
    expect(doc.students?.[1]?.grade).toBe("9");
  });

  it("rejects a student without a name", () => {
    const doc = new Achievement({
      institutionId: "INS0001",
      category: "ACADEMIC",
      title: "State Chess Champion",
      students: [{ grade: "10" }],
    });

    expect(doc.validateSync()?.errors["students.0.name"]).toBeDefined();
  });

  it("declares the createdAt and status+category indexes, plus the implicit institutionId index", () => {
    const indexes = Achievement.schema.indexes();

    const byInstitutionId = indexes.find(
      ([fields]) => Object.keys(fields).length === 1 && fields.institutionId === 1,
    );
    expect(byInstitutionId).toBeDefined();

    const byCreatedAt = indexes.find(
      ([fields]) =>
        fields.institutionId === 1 && fields.createdAt === -1 && !("status" in fields),
    );
    expect(byCreatedAt).toBeDefined();

    const byStatusCategory = indexes.find(
      ([fields]) =>
        fields.institutionId === 1 && fields.status === 1 && fields.category === 1,
    );
    expect(byStatusCategory).toBeDefined();
  });
});

describe("Alumnus model", () => {
  it("requires institutionId, name and category", () => {
    const doc = new Alumnus({});
    const err = doc.validateSync();

    expect(err?.errors.institutionId).toBeDefined();
    expect(err?.errors.name).toBeDefined();
    expect(err?.errors.category).toBeDefined();
  });

  it("rejects a category outside the enum", () => {
    const doc = new Alumnus({
      institutionId: "INS0001",
      name: "Dr. Asha Rao",
      category: "ASTRONAUT",
    });

    expect(doc.validateSync()?.errors.category).toBeDefined();
  });

  it("defaults status to ACTIVE", () => {
    const doc = new Alumnus({
      institutionId: "INS0001",
      name: "Dr. Asha Rao",
      category: "DOCTOR",
    });

    expect(doc.status).toBe("ACTIVE");
    expect(SHOWCASE_STATUSES).toContain(doc.status);
  });

  it("accepts a batch range as free text, unvalidated", () => {
    const doc = new Alumnus({
      institutionId: "INS0001",
      name: "Dr. Asha Rao",
      category: "DOCTOR",
      batch: "2012-2015",
    });

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.batch).toBe("2012-2015");
  });

  it("declares the createdAt and status+category indexes, plus the implicit institutionId index", () => {
    const indexes = Alumnus.schema.indexes();

    const byInstitutionId = indexes.find(
      ([fields]) => Object.keys(fields).length === 1 && fields.institutionId === 1,
    );
    expect(byInstitutionId).toBeDefined();

    const byCreatedAt = indexes.find(
      ([fields]) =>
        fields.institutionId === 1 && fields.createdAt === -1 && !("status" in fields),
    );
    expect(byCreatedAt).toBeDefined();

    const byStatusCategory = indexes.find(
      ([fields]) =>
        fields.institutionId === 1 && fields.status === 1 && fields.category === 1,
    );
    expect(byStatusCategory).toBeDefined();
  });
});
