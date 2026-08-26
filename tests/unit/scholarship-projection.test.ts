import { describe, expect, it } from "vitest";
import { toPublicScholarship } from "@/lib/scholarship/public-projection";

const published = {
  _id: "aaa",
  institutionId: "INS0001",
  academicUnitId: "bbb",
  name: "Merit Scholarship",
  criteria: "Top 10 ranks in the board examination",
  amount: "100% tuition",
  classOrCourse: "Grade 10",
  status: "PUBLISHED",
  publishedAt: new Date("2026-05-10T00:00:00.000Z"),
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-10T00:00:00.000Z"),
};

describe("toPublicScholarship", () => {
  it("emits exactly the allowed top-level keys and no others", () => {
    const result = toPublicScholarship(published);

    expect(Object.keys(result ?? {}).sort()).toEqual(
      ["amount", "classOrCourse", "criteria", "name", "publishedAt"].sort(),
    );
  });

  it("never emits internal fields", () => {
    const result = toPublicScholarship(published) as Record<string, unknown>;

    expect(result).not.toHaveProperty("_id");
    expect(result).not.toHaveProperty("institutionId");
    expect(result).not.toHaveProperty("academicUnitId");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("returns null for a draft scholarship", () => {
    expect(toPublicScholarship({ ...published, status: "DRAFT" })).toBeNull();
  });

  it("returns null for an archived scholarship", () => {
    expect(toPublicScholarship({ ...published, status: "ARCHIVED" })).toBeNull();
  });

  it("drops an institution-wide scholarship's empty classOrCourse rather than emitting a blank", () => {
    const result = toPublicScholarship({ ...published, classOrCourse: "" }) as Record<
      string,
      unknown
    >;

    expect(result.classOrCourse).toBeUndefined();
  });

  it("does not leak a field added to the document but not to the allow-list", () => {
    const result = toPublicScholarship({
      ...published,
      internalReviewerNote: "do not publish this",
    }) as Record<string, unknown>;

    expect(result).not.toHaveProperty("internalReviewerNote");
  });
});
