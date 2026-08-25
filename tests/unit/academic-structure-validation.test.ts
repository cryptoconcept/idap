import { describe, expect, it } from "vitest";
import {
  createAcademicUnitSchema,
  reorderAcademicUnitsSchema,
  updateAcademicUnitSchema,
  updateSegmentsSchema,
} from "@/lib/validation/academic-structure";

const OID = "6a887abd755db527bea51204";

describe("academic structure validation", () => {
  it("requires a name, trims it, and caps it at 120", () => {
    expect(createAcademicUnitSchema.safeParse({ segment: "SCHOOL", name: "" }).success).toBe(false);
    expect(
      createAcademicUnitSchema.safeParse({ segment: "SCHOOL", name: "x".repeat(121) }).success,
    ).toBe(false);

    const parsed = createAcademicUnitSchema.parse({ segment: "SCHOOL", name: "  Grade 1  " });
    expect(parsed.name).toBe("Grade 1");
  });

  it("treats an absent parentId and an explicit null as the same thing", () => {
    expect(createAcademicUnitSchema.parse({ segment: "SCHOOL", name: "Grade 1" }).parentId)
      .toBeUndefined();
    expect(
      createAcademicUnitSchema.parse({ segment: "SCHOOL", name: "Grade 1", parentId: null })
        .parentId,
    ).toBeNull();
  });

  it("rejects a parentId that is not an object id, and an unknown segment", () => {
    expect(
      createAcademicUnitSchema.safeParse({ segment: "SCHOOL", name: "A", parentId: "nope" })
        .success,
    ).toBe(false);
    expect(createAcademicUnitSchema.safeParse({ segment: "MADE_UP", name: "A" }).success).toBe(
      false,
    );
  });

  it("strips segment and parentId from a patch instead of applying them", () => {
    // Same guarantee, and the same mechanism, as `status` being absent from
    // `updateFeeStructureSchema`: a patch can never move a unit and leave its
    // depth, level and every descendant's pathLabel stale.
    const parsed = updateAcademicUnitSchema.parse({
      name: "Renamed",
      segment: "UNIVERSITY",
      parentId: OID,
    }) as Record<string, unknown>;

    expect(parsed.name).toBe("Renamed");
    expect(parsed.segment).toBeUndefined();
    expect(parsed.parentId).toBeUndefined();
  });

  it("accepts a patch that only toggles active", () => {
    expect(updateAcademicUnitSchema.parse({ active: false })).toEqual({ active: false });
  });

  it("requires at least one segment and refuses duplicates", () => {
    expect(updateSegmentsSchema.safeParse({ segments: [] }).success).toBe(false);
    expect(updateSegmentsSchema.safeParse({ segments: ["SCHOOL", "SCHOOL"] }).success).toBe(false);
    expect(updateSegmentsSchema.safeParse({ segments: ["SCHOOL", "PRE_UNIVERSITY"] }).success).toBe(
      true,
    );
  });

  it("requires a non-empty, bounded, well-formed orderedIds list", () => {
    expect(
      reorderAcademicUnitsSchema.safeParse({ segment: "SCHOOL", orderedIds: [] }).success,
    ).toBe(false);
    expect(
      reorderAcademicUnitsSchema.safeParse({
        segment: "SCHOOL",
        orderedIds: Array.from({ length: 101 }, () => OID),
      }).success,
    ).toBe(false);
    expect(
      reorderAcademicUnitsSchema.safeParse({ segment: "SCHOOL", orderedIds: ["nope"] }).success,
    ).toBe(false);
    expect(
      reorderAcademicUnitsSchema.safeParse({
        segment: "SCHOOL",
        parentId: null,
        orderedIds: [OID],
      }).success,
    ).toBe(true);
  });
});
