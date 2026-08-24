import { describe, expect, it } from "vitest";
import { toPublicFeeStructure } from "@/lib/fee-structure/public-projection";

const published = {
  _id: "aaa",
  institutionId: "INS0001",
  classOrCourse: "Grade 10",
  academicYear: "2026-27",
  lineItems: [
    { label: "Tuition", amount: 60000, frequency: "ANNUAL", optional: false },
    { label: "Transport", amount: 12000, frequency: "ANNUAL", optional: true },
  ],
  status: "PUBLISHED",
  publishedAt: new Date("2026-05-10T00:00:00.000Z"),
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-10T00:00:00.000Z"),
};

describe("toPublicFeeStructure", () => {
  it("emits exactly the allowed top-level keys and no others", () => {
    const result = toPublicFeeStructure(published);

    expect(Object.keys(result ?? {}).sort()).toEqual(
      ["academicYear", "classOrCourse", "lineItems", "publishedAt"].sort(),
    );
  });

  it("never emits internal fields", () => {
    const result = toPublicFeeStructure(published) as Record<string, unknown>;

    expect(result).not.toHaveProperty("_id");
    expect(result).not.toHaveProperty("institutionId");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("returns null for a draft fee structure", () => {
    expect(toPublicFeeStructure({ ...published, status: "DRAFT" })).toBeNull();
  });

  it("returns null for an archived fee structure", () => {
    expect(toPublicFeeStructure({ ...published, status: "ARCHIVED" })).toBeNull();
  });

  it("emits each line item's optional flag", () => {
    const result = toPublicFeeStructure(published);

    expect(result?.lineItems).toHaveLength(2);
    expect(result?.lineItems?.[1]?.optional).toBe(true);
  });

  it("drops lineItems entirely rather than emitting an empty array", () => {
    const result = toPublicFeeStructure({ ...published, lineItems: [] });
    expect(result?.lineItems).toBeUndefined();
  });
});
