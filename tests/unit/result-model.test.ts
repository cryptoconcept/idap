import { describe, expect, it } from "vitest";
import { Result } from "@/models/Result";
import { RESULT_BOARDS, RESULT_LEVELS, RESULT_STATUSES } from "@/lib/constants";

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
});
