import { describe, expect, it } from "vitest";
import { Result } from "@/models/Result";
import {
  EXAM_CODES,
  GRADE_BUCKETS,
  RECRUITER_CATEGORIES,
  RESULT_BOARDS,
  RESULT_LEVELS,
  RESULT_MAX_SELECTIONS,
  RESULT_STATUSES,
} from "@/lib/constants";

describe("Result model", () => {
  it("defaults a new result to DRAFT with no publishedAt", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 10,
      passed: 10,
    });

    expect(doc.status).toBe("DRAFT");
    expect(doc.publishedAt).toBeUndefined();
    expect(doc.stream).toBeNull();
  });

  it("keeps an _id on each topper so the photo endpoint can address it", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      toppers: [{ name: "Priya S", percentage: 98.6 }],
    });

    expect(doc.toppers?.[0]?._id).toBeDefined();
  });

  it("does not give bands their own _id", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      bands: [{ label: "90% and above", minPercentage: 90, maxPercentage: 100, count: 1 }],
    });

    expect((doc.bands?.[0] as unknown as { _id?: unknown })?._id).toBeUndefined();
  });

  it("rejects a board, level or status outside its enum", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "NOT_A_BOARD",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
    });

    expect(doc.validateSync()?.errors.board).toBeDefined();
  });

  it("declares the unique cycle index and the reserved discovery index", () => {
    const indexes = Result.schema.indexes();

    const unique = indexes.find(([, options]) => options?.unique === true);
    expect(unique?.[0]).toEqual({
      institutionId: 1,
      board: 1,
      level: 1,
      stream: 1,
      academicYear: 1,
    });

    const discovery = indexes.find(
      ([fields]) =>
        fields.status === 1 && fields.board === 1 && fields.level === 1 && !("institutionId" in fields),
    );
    expect(discovery).toBeDefined();
  });

  it("exposes the constant tuples the UI and validation share", () => {
    expect(RESULT_BOARDS).toContain("STATE_BOARD");
    expect(RESULT_LEVELS).toContain("CLASS_12");
    expect(RESULT_STATUSES).toEqual(["DRAFT", "PUBLISHED", "ARCHIVED"]);
  });

  it("keeps an _id on each combination so a patch can be matched back to it", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "PUC_2",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      combinations: [{ label: "PCMB", appeared: 1, passed: 1 }],
    });

    expect(doc.combinations?.[0]?._id).toBeDefined();
  });

  it("does not give a selection its own _id — it is matched by examCode instead", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "PUC_2",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      selections: [{ examCode: "KCET", qualified: 1 }],
    });

    expect((doc.selections?.[0] as unknown as { _id?: unknown })?._id).toBeUndefined();
  });

  it("keeps an _id on a combination's own toppers, same as a top-level topper", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "PUC_2",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      combinations: [{ label: "PCMB", toppers: [{ name: "Priya S", percentage: 98.6 }] }],
    });

    expect(doc.combinations?.[0]?.toppers?.[0]?._id).toBeDefined();
  });

  it("rejects an examCode outside the enum", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "PUC_2",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      selections: [{ examCode: "NOT_AN_EXAM" }],
    });

    expect(doc.validateSync()?.errors["selections.0.examCode"]).toBeDefined();
  });

  it("rejects a recruiter category outside the enum", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "UG",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      placement: { recruiters: [{ name: "Acme", category: "NOT_A_CATEGORY" }] },
    });

    expect(doc.validateSync()?.errors["placement.recruiters.0.category"]).toBeDefined();
  });

  it("defaults every grade bucket to 0 rather than leaving it undefined", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "PUC_2",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      combinations: [{ label: "PCMB", grades: {} }],
    });

    expect(doc.combinations?.[0]?.grades?.["90+"]).toBe(0);
    expect(doc.combinations?.[0]?.grades?.below50).toBe(0);
  });

  it("defaults a recruiter's tieUp to false", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "UG",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      placement: { recruiters: [{ name: "Acme" }] },
    });

    expect(doc.placement?.recruiters?.[0]?.tieUp).toBe(false);
  });

  it("leaves combinations, placement and selections absent when never set", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
    });

    expect(doc.combinations).toBeUndefined();
    expect(doc.placement).toBeUndefined();
    expect(doc.selections).toBeUndefined();
  });

  it("exposes the new constant tuples", () => {
    expect(GRADE_BUCKETS).toEqual(["90+", "80-90", "70-80", "60-70", "50-60", "below50"]);
    expect(EXAM_CODES).toContain("NEET");
    expect(RECRUITER_CATEGORIES).toContain("STARTUP");
    expect(RESULT_MAX_SELECTIONS).toBe(EXAM_CODES.length);
  });
});
