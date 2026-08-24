import { describe, expect, it } from "vitest";
import { toPublicResult } from "@/lib/results/public-projection";

const published = {
  _id: "6a887abc755db527bea511e6",
  institutionId: "INS0001",
  board: "CBSE",
  boardName: undefined,
  level: "CLASS_10",
  stream: null,
  academicYear: "2025-26",
  examLabel: "CBSE Class 10 Board Exam",
  appeared: 142,
  passed: 140,
  averageScore: 82.4,
  highestScore: 98.6,
  bands: [{ label: "90% and above", minPercentage: 90, maxPercentage: 100, count: 38 }],
  toppers: [
    { _id: "aaa", name: "Priya S", percentage: 98.6, rank: 1, consentAcknowledged: true },
    { _id: "bbb", name: "Rahul K", percentage: 97.8, rank: 2, consentAcknowledged: false },
  ],
  status: "PUBLISHED",
  publishedAt: new Date("2026-05-10T00:00:00.000Z"),
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-10T00:00:00.000Z"),
};

describe("toPublicResult", () => {
  it("emits exactly the allowed top-level keys and no others", () => {
    const result = toPublicResult(published);

    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        "academicYear",
        "appeared",
        "averageScore",
        "bands",
        "board",
        "boardLabel",
        "examLabel",
        "highestScore",
        "level",
        "passPercentage",
        "passed",
        "publishedAt",
        "stream",
        "toppers",
      ].sort(),
    );
  });

  it("never emits internal fields", () => {
    const result = toPublicResult(published) as Record<string, unknown>;

    expect(result).not.toHaveProperty("_id");
    expect(result).not.toHaveProperty("institutionId");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("drops a topper who has not acknowledged consent", () => {
    const result = toPublicResult(published);

    expect(result?.toppers).toHaveLength(1);
    expect(result?.toppers?.[0]?.name).toBe("Priya S");
    expect(JSON.stringify(result)).not.toContain("Rahul K");
  });

  it("never emits consentAcknowledged itself, nor a topper _id", () => {
    const topper = toPublicResult(published)?.toppers?.[0] as Record<string, unknown>;

    expect(topper).not.toHaveProperty("consentAcknowledged");
    expect(topper).not.toHaveProperty("_id");
  });

  it("computes passPercentage rather than reading a stored one", () => {
    expect(toPublicResult(published)?.passPercentage).toBe(98.6);
  });

  it("emits examLabel", () => {
    expect(toPublicResult(published)?.examLabel).toBe("CBSE Class 10 Board Exam");
  });

  it("returns a null passPercentage rather than dividing by zero", () => {
    const result = toPublicResult({ ...published, appeared: 0, passed: 0 });
    expect(result?.passPercentage).toBeNull();
  });

  it("ignores a stored passPercentage that disagrees with the arithmetic", () => {
    const result = toPublicResult({ ...published, passPercentage: 12 });
    expect(result?.passPercentage).toBe(98.6);
  });

  it("returns null for a result that is not published", () => {
    expect(toPublicResult({ ...published, status: "DRAFT" })).toBeNull();
    expect(toPublicResult({ ...published, status: "ARCHIVED" })).toBeNull();
    expect(toPublicResult({ ...published, status: undefined })).toBeNull();
  });

  it("prefers boardName over the enum label when the board does not name itself", () => {
    const result = toPublicResult({
      ...published,
      board: "STATE_BOARD",
      boardName: "Karnataka State Board",
    });
    expect(result?.boardLabel).toBe("Karnataka State Board");
  });

  it("falls back to the enum label when boardName is absent", () => {
    expect(toPublicResult(published)?.boardLabel).toBe("CBSE");
  });

  it("omits an empty toppers or bands array rather than emitting []", () => {
    const result = toPublicResult({ ...published, toppers: [], bands: [] });
    expect(result?.toppers).toBeUndefined();
    expect(result?.bands).toBeUndefined();
  });
});
