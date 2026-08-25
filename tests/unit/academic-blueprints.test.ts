import { describe, expect, it } from "vitest";
import {
  ACADEMIC_LEVEL_KEYS,
  ACADEMIC_SEGMENTS,
  ACADEMIC_SEGMENT_LABELS,
  INSTITUTION_TYPES,
} from "@/lib/constants";
import {
  ACADEMIC_BLUEPRINTS,
  DEFAULT_SEGMENTS_FOR_TYPE,
  defaultSegmentsFor,
  levelFor,
  maxDepthFor,
  orderSegments,
} from "@/lib/academic/blueprints";

describe("academic blueprints", () => {
  it("gives every segment at least one level, a label, and a blueprint", () => {
    for (const segment of ACADEMIC_SEGMENTS) {
      expect(ACADEMIC_BLUEPRINTS[segment]).toBeDefined();
      expect(ACADEMIC_BLUEPRINTS[segment].levels.length).toBeGreaterThan(0);
      expect(ACADEMIC_SEGMENT_LABELS[segment]).toBeTruthy();
    }
  });

  it("keeps every offeringDepth inside its own level list", () => {
    // Bounds first — an out-of-range offeringDepth would publish nothing at all.
    for (const segment of ACADEMIC_SEGMENTS) {
      const blueprint = ACADEMIC_BLUEPRINTS[segment];
      expect(blueprint.offeringDepth).toBeGreaterThanOrEqual(0);
      expect(blueprint.offeringDepth).toBeLessThan(blueprint.levels.length);
    }
    // Bounds alone would still pass if ENGINEERING pointed at YEAR, so the tier
    // each segment actually publishes is pinned by name.
    const publishedTier = Object.fromEntries(
      ACADEMIC_SEGMENTS.map((segment) => {
        const blueprint = ACADEMIC_BLUEPRINTS[segment];
        return [segment, blueprint.levels[blueprint.offeringDepth].key];
      }),
    );
    expect(publishedTier).toEqual({
      SCHOOL: "CLASS",
      PRE_UNIVERSITY: "COMBINATION",
      DEGREE: "COURSE",
      ENGINEERING: "BRANCH",
      POLYTECHNIC: "COURSE",
      UNIVERSITY: "COURSE",
      COACHING: "PROGRAMME",
      OTHER: "PROGRAMME",
    });
  });

  it("uses only declared level keys, and declares no unused ones", () => {
    const used = new Set(
      ACADEMIC_SEGMENTS.flatMap((segment) =>
        ACADEMIC_BLUEPRINTS[segment].levels.map((level) => level.key),
      ),
    );
    for (const key of used) expect(ACADEMIC_LEVEL_KEYS).toContain(key);
    for (const key of ACADEMIC_LEVEL_KEYS) expect(used.has(key)).toBe(true);
  });

  it("maps every institution type to real segments", () => {
    for (const institutionType of INSTITUTION_TYPES) {
      const segments = DEFAULT_SEGMENTS_FOR_TYPE[institutionType];
      expect(segments, `no default for ${institutionType}`).toBeDefined();
      expect(segments.length).toBeGreaterThan(0);
      for (const segment of segments) expect(ACADEMIC_SEGMENTS).toContain(segment);
    }
    // Pinned by value: a silent swap of MEDICAL_COLLEGE to ENGINEERING would
    // otherwise pass, because ENGINEERING is also a real segment.
    expect(DEFAULT_SEGMENTS_FOR_TYPE).toEqual({
      SCHOOL: ["SCHOOL"],
      PU_COLLEGE: ["PRE_UNIVERSITY"],
      DEGREE_COLLEGE: ["DEGREE"],
      ENGINEERING_COLLEGE: ["ENGINEERING"],
      MEDICAL_COLLEGE: ["DEGREE"],
      UNIVERSITY: ["UNIVERSITY"],
      OTHER: ["OTHER"],
      B_ED_COLLEGE: ["DEGREE"],
      NURSING_COLLEGE: ["DEGREE"],
      POLYTECHNIC: ["POLYTECHNIC"],
      COACHING_INSTITUTION: ["COACHING"],
      TRAINING_INSTITUTION: ["COACHING"],
    });
  });

  it("returns null for a depth past the end of a blueprint", () => {
    expect(levelFor("SCHOOL", 0)?.key).toBe("CLASS");
    expect(levelFor("SCHOOL", 1)).toBeNull();
    expect(maxDepthFor("SCHOOL")).toBe(0);
    expect(maxDepthFor("UNIVERSITY")).toBe(3);
  });

  it("orders segments by declaration, not by the order they were given in", () => {
    expect(orderSegments(["PRE_UNIVERSITY", "SCHOOL"])).toEqual(["SCHOOL", "PRE_UNIVERSITY"]);
    expect(orderSegments(["OTHER", "DEGREE", "SCHOOL"])).toEqual(["SCHOOL", "DEGREE", "OTHER"]);
    expect(orderSegments(["NOT_A_SEGMENT"])).toEqual([]);
  });

  it("falls back to OTHER for an institution type it does not know", () => {
    expect(defaultSegmentsFor("SCHOOL")).toEqual(["SCHOOL"]);
    expect(defaultSegmentsFor("SOMETHING_NEW")).toEqual(["OTHER"]);
  });
});
