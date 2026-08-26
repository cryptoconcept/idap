import { describe, expect, it } from "vitest";
import {
  buildProfilePatch,
  buildResultsPayloads,
  deriveStreams,
  mapStream,
} from "@/lib/connectors/passpercent-mapping";
import { EXAM_CODES, INSTITUTION_TYPES, RECRUITER_CATEGORIES } from "@/lib/constants";

// ---------------------------------------------------------------------------
// mapStream
// ---------------------------------------------------------------------------

describe("mapStream", () => {
  it("maps CLASS_10 to sslc", () => {
    expect(mapStream("CLASS_10", "SCHOOL")).toBe("sslc");
  });

  it("maps CLASS_12 to puc", () => {
    expect(mapStream("CLASS_12", "PU_COLLEGE")).toBe("puc");
  });

  it("maps PUC_2 to puc", () => {
    expect(mapStream("PUC_2", "PU_COLLEGE")).toBe("puc");
  });

  it("maps UG + ENGINEERING_COLLEGE to engineering", () => {
    expect(mapStream("UG", "ENGINEERING_COLLEGE")).toBe("engineering");
  });

  it("maps UG + MEDICAL_COLLEGE to medical", () => {
    expect(mapStream("UG", "MEDICAL_COLLEGE")).toBe("medical");
  });

  it("maps UG + NURSING_COLLEGE to medical", () => {
    expect(mapStream("UG", "NURSING_COLLEGE")).toBe("medical");
  });

  it("maps UG + any other institution type to degree", () => {
    for (const type of INSTITUTION_TYPES) {
      if (type === "ENGINEERING_COLLEGE" || type === "MEDICAL_COLLEGE" || type === "NURSING_COLLEGE") continue;
      expect(mapStream("UG", type)).toBe("degree");
    }
  });

  it("leaves all four documented levels unmapped: PUC_1, PG, DIPLOMA, OTHER", () => {
    expect(mapStream("PUC_1", "PU_COLLEGE")).toBeNull();
    expect(mapStream("PG", "DEGREE_COLLEGE")).toBeNull();
    expect(mapStream("DIPLOMA", "POLYTECHNIC")).toBeNull();
    expect(mapStream("OTHER", "OTHER")).toBeNull();
  });

  it("returns null for an unrecognized level defensively", () => {
    expect(mapStream("NOT_A_LEVEL", "SCHOOL")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveStreams
// ---------------------------------------------------------------------------

describe("deriveStreams", () => {
  it("maps each documented segment to its stream", () => {
    expect(deriveStreams({ segments: ["SCHOOL"], institutionType: "SCHOOL", mappedResultStreams: [] })).toEqual([
      "sslc",
    ]);
    expect(
      deriveStreams({ segments: ["PRE_UNIVERSITY"], institutionType: "PU_COLLEGE", mappedResultStreams: [] }),
    ).toEqual(["puc"]);
    expect(
      deriveStreams({ segments: ["DEGREE"], institutionType: "DEGREE_COLLEGE", mappedResultStreams: [] }),
    ).toEqual(["degree"]);
    expect(
      deriveStreams({ segments: ["ENGINEERING"], institutionType: "ENGINEERING_COLLEGE", mappedResultStreams: [] }),
    ).toEqual(["engineering"]);
  });

  it("segments with no direct mapping (POLYTECHNIC, UNIVERSITY, COACHING, OTHER) contribute nothing on their own", () => {
    expect(
      deriveStreams({
        segments: ["POLYTECHNIC", "UNIVERSITY", "COACHING", "OTHER"],
        institutionType: "UNIVERSITY",
        mappedResultStreams: [],
      }),
    ).toEqual([]);
  });

  it("adds medical for MEDICAL_COLLEGE institution type even with no matching segment", () => {
    expect(deriveStreams({ segments: [], institutionType: "MEDICAL_COLLEGE", mappedResultStreams: [] })).toEqual([
      "medical",
    ]);
  });

  it("does NOT add medical for NURSING_COLLEGE via institutionType (only MEDICAL_COLLEGE is pinned here)", () => {
    expect(deriveStreams({ segments: [], institutionType: "NURSING_COLLEGE", mappedResultStreams: [] })).toEqual([]);
  });

  it("is a superset: every mappedResultStreams entry appears in the output even with no matching segment", () => {
    const out = deriveStreams({
      segments: ["SCHOOL"],
      institutionType: "SCHOOL",
      mappedResultStreams: ["puc", "engineering"],
    });
    expect(out).toEqual(expect.arrayContaining(["sslc", "puc", "engineering"]));
    expect(new Set(out).size).toBe(out.length); // deduped
  });

  it("dedupes when segments and mappedResultStreams overlap", () => {
    const out = deriveStreams({
      segments: ["SCHOOL", "PRE_UNIVERSITY"],
      institutionType: "SCHOOL",
      mappedResultStreams: ["sslc"],
    });
    expect(out).toEqual(["sslc", "puc"]);
  });
});

// ---------------------------------------------------------------------------
// buildProfilePatch
// ---------------------------------------------------------------------------

describe("buildProfilePatch", () => {
  const schemaFields = [{ name: "board", enum: ["CBSE", "ICSE", "State Board"] }];

  it("maps the documented simple fields with their renames", () => {
    const { patch, warnings } = buildProfilePatch({
      institution: {
        institutionName: "Delhi Public School",
        city: "Bengaluru",
        description: "A fine school",
        phone: "9999999999",
        website: "https://dps.example",
        address: "123 Main Road",
        area: "Indiranagar",
        district: "Bengaluru Urban",
        taluk: "Bengaluru North",
        state: "Karnataka",
        pincode: "560038",
      },
      streams: ["sslc", "puc"],
      schemaFields: [],
    });

    expect(patch).toEqual({
      name: "Delhi Public School",
      city: "Bengaluru",
      about: "A fine school",
      phone: "9999999999",
      website: "https://dps.example",
      addressLine: "123 Main Road",
      area: "Indiranagar",
      district: "Bengaluru Urban",
      taluk: "Bengaluru North",
      state: "Karnataka",
      pincode: "560038",
      streams: ["sslc", "puc"],
    });
    expect(warnings).toEqual([]);
  });

  it("omits fields whose IDAP value is undefined — never sends them at all", () => {
    const { patch } = buildProfilePatch({
      institution: { institutionName: "Only Name Co" },
      streams: [],
      schemaFields: [],
    });
    expect(patch).not.toHaveProperty("city");
    expect(patch).not.toHaveProperty("about");
    expect(patch).not.toHaveProperty("phone");
  });

  it("omits fields whose IDAP value is an empty string — never sends \"\" for name/city", () => {
    const { patch } = buildProfilePatch({
      institution: { institutionName: "", city: "" },
      streams: [],
      schemaFields: [],
    });
    expect(patch).not.toHaveProperty("name");
    expect(patch).not.toHaveProperty("city");
  });

  it("includes academic.board only when it appears in the schema's board enum (case-sensitive)", () => {
    const { patch, warnings } = buildProfilePatch({
      institution: { academic: { board: "CBSE" } },
      streams: [],
      schemaFields,
    });
    expect(patch.board).toBe("CBSE");
    expect(warnings).toEqual([]);
  });

  it("drops academic.board and warns when it is absent from the schema's enum", () => {
    const { patch, warnings } = buildProfilePatch({
      institution: { academic: { board: "cbse" } }, // wrong case — not a member
      streams: [],
      schemaFields,
    });
    expect(patch).not.toHaveProperty("board");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/board/i);
  });

  it("drops academic.board and warns when the schema has no board field at all", () => {
    const { patch, warnings } = buildProfilePatch({
      institution: { academic: { board: "CBSE" } },
      streams: [],
      schemaFields: [],
    });
    expect(patch).not.toHaveProperty("board");
    expect(warnings.length).toBe(1);
  });

  it("never emits type, even when the institution record carries a type-shaped field", () => {
    const { patch } = buildProfilePatch({
      institution: {
        institutionName: "Has A Type Co",
        institutionType: "SCHOOL",
        type: "School", // simulates the exact key PassPercent's wire format uses
      },
      streams: [],
      schemaFields: [],
    });
    expect(patch).not.toHaveProperty("type");
  });
});

// ---------------------------------------------------------------------------
// buildResultsPayloads
// ---------------------------------------------------------------------------

describe("buildResultsPayloads", () => {
  it("skips a result with an unmapped level and names the level + year in a warning", () => {
    const { byYear, warnings } = buildResultsPayloads({
      results: [{ id: "r1", level: "PUC_1", academicYear: "2024-25", appeared: 100, passed: 90 }],
      institutionType: "PU_COLLEGE",
    });
    expect(byYear.size).toBe(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("PUC_1");
    expect(warnings[0]).toContain("2024-25");
  });

  it.each(["2024", "2024-25", "2024-2025"])("accepts a valid academic year format %s", (year) => {
    const { byYear, warnings } = buildResultsPayloads({
      results: [{ id: "r1", level: "CLASS_10", academicYear: year, appeared: 10, passed: 9 }],
      institutionType: "SCHOOL",
    });
    expect(byYear.has(year)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it.each(["24-25", "2024/25", "abcd", ""])("rejects and warns on an invalid academic year format %s", (year) => {
    const { byYear, warnings } = buildResultsPayloads({
      results: [{ id: "r1", level: "CLASS_10", academicYear: year, appeared: 10, passed: 9 }],
      institutionType: "SCHOOL",
    });
    expect(byYear.size).toBe(0);
    expect(warnings.length).toBe(1);
  });

  it("groups by (stream, year): two different years produce two byYear entries", () => {
    const { byYear } = buildResultsPayloads({
      results: [
        { id: "r1", level: "CLASS_10", academicYear: "2023-24", appeared: 10, passed: 9 },
        { id: "r2", level: "CLASS_10", academicYear: "2024-25", appeared: 20, passed: 18 },
      ],
      institutionType: "SCHOOL",
    });
    expect(byYear.size).toBe(2);
    expect(Object.keys(byYear.get("2023-24")!.streams)).toEqual(["sslc"]);
    expect(Object.keys(byYear.get("2024-25")!.streams)).toEqual(["sslc"]);
  });

  it("groups two different streams within the same year under one byYear entry", () => {
    const { byYear } = buildResultsPayloads({
      results: [
        { id: "r1", level: "CLASS_10", academicYear: "2024-25", appeared: 10, passed: 9 },
        { id: "r2", level: "CLASS_12", academicYear: "2024-25", appeared: 20, passed: 18 },
      ],
      institutionType: "SCHOOL",
    });
    expect(byYear.size).toBe(1);
    expect(Object.keys(byYear.get("2024-25")!.streams).sort()).toEqual(["puc", "sslc"]);
  });

  describe("rollup: appeared/passed", () => {
    it("sums appeared/passed across two results on the same (stream, year) and recomputes passPct from the sums, never averaging", () => {
      // Naive averaging of (90%, 10%) would give 50%. The correct, cohort-weighted
      // figure is 91/110 * 100 = 82.7%. This is the single easiest mistake here.
      const { byYear, warnings } = buildResultsPayloads({
        results: [
          { id: "r1", level: "CLASS_12", academicYear: "2024-25", appeared: 100, passed: 90 },
          { id: "r2", level: "PUC_2", academicYear: "2024-25", appeared: 10, passed: 1 },
        ],
        institutionType: "PU_COLLEGE",
      });
      const puc = byYear.get("2024-25")!.streams.puc as Record<string, unknown>;
      expect(puc.appeared).toBe(110);
      expect(puc.passed).toBe(91);
      expect(puc.passPct).toBe(82.7);
      expect(puc.passPct).not.toBe(50); // the averaging bug this guards against
      expect(warnings).toEqual([]);
    });

    it("a result with appeared == null contributes nothing to the sum and is warned", () => {
      const { byYear, warnings } = buildResultsPayloads({
        results: [
          { id: "r1", level: "CLASS_10", academicYear: "2024-25", passed: 5 }, // appeared never reported
          { id: "r2", level: "CLASS_10", academicYear: "2024-25", appeared: 50, passed: 45 },
        ],
        institutionType: "SCHOOL",
      });
      const sslc = byYear.get("2024-25")!.streams.sslc as Record<string, unknown>;
      expect(sslc.appeared).toBe(50); // only r2 contributed
      expect(sslc.passed).toBe(50); // both r1's 5 and r2's 45 are valid "passed" reports
      expect(warnings.some((w) => w.includes("r1") && w.includes("appeared"))).toBe(true);
    });

    it("omits appeared entirely when NO result in the group reports it (there is no zero to report)", () => {
      const { byYear } = buildResultsPayloads({
        results: [{ id: "r1", level: "CLASS_10", academicYear: "2024-25", passed: 5 }],
        institutionType: "SCHOOL",
      });
      const sslc = byYear.get("2024-25")!.streams.sslc as Record<string, unknown>;
      expect(sslc).not.toHaveProperty("appeared");
    });

    it("MUTATION-DISTINGUISHING: a reported appeared:0 is included and produces NO warning for that result, unlike a genuinely absent appeared", () => {
      const { byYear, warnings } = buildResultsPayloads({
        results: [
          { id: "zero-reported", level: "CLASS_10", academicYear: "2024-25", appeared: 0, passed: 0 },
          { id: "never-reported", level: "CLASS_10", academicYear: "2024-25", passed: 5 }, // appeared absent
        ],
        institutionType: "SCHOOL",
      });
      const sslc = byYear.get("2024-25")!.streams.sslc as Record<string, unknown>;
      // appeared is PRESENT (0 was a real contributor) — this is the property a
      // truthiness guard (`if (appeared)`) would get wrong: 0 is falsy, so a
      // buggy guard would treat "zero-reported" as if it never reported
      // appeared at all, and since neither result would then "count",
      // `appeared` would be omitted from the output entirely.
      expect(sslc).toHaveProperty("appeared", 0);
      expect(warnings.some((w) => w.includes("zero-reported") && w.includes("appeared"))).toBe(false);
      expect(warnings.some((w) => w.includes("never-reported") && w.includes("appeared"))).toBe(true);
    });

    it("does not compute passPct when the summed appeared is not greater than 0", () => {
      const { byYear } = buildResultsPayloads({
        results: [{ id: "r1", level: "CLASS_10", academicYear: "2024-25", appeared: 0, passed: 0 }],
        institutionType: "SCHOOL",
      });
      const sslc = byYear.get("2024-25")!.streams.sslc as Record<string, unknown>;
      expect(sslc).not.toHaveProperty("passPct");
    });
  });

  describe("rollup: boys/girls", () => {
    it("sums boys/girls with the same != null discipline", () => {
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_10",
            academicYear: "2024-25",
            appeared: 50,
            passed: 45,
            boys: { appeared: 30, passed: 28 },
            girls: { appeared: 20, passed: 17 },
          },
          {
            id: "r2",
            level: "CLASS_10",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            boys: { appeared: 5, passed: 5 },
            girls: { appeared: 5, passed: 4 },
          },
        ],
        institutionType: "SCHOOL",
      });
      const sslc = byYear.get("2024-25")!.streams.sslc as Record<string, unknown>;
      expect(sslc.boys).toEqual({ appeared: 35, passed: 33 });
      expect(sslc.girls).toEqual({ appeared: 25, passed: 21 });
    });

    it("MUTATION-DISTINGUISHING: boys.appeared:0 as the sole contributor still produces a present boys key", () => {
      const { byYear, warnings } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_10",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            boys: { appeared: 0, passed: 0 }, // reported: an all-girls cohort this year
          },
          { id: "r2", level: "CLASS_10", academicYear: "2024-25", appeared: 5, passed: 5 }, // no boys/girls object at all
        ],
        institutionType: "SCHOOL",
      });
      const sslc = byYear.get("2024-25")!.streams.sslc as Record<string, unknown>;
      expect(sslc).toHaveProperty("boys", { appeared: 0, passed: 0 });
      expect(sslc).not.toHaveProperty("girls"); // neither result reported girls at all
      expect(warnings.some((w) => w.includes("r1") && w.includes("boys"))).toBe(false);
    });

    it("omits boys/girls entirely when no result in the group reports them", () => {
      const { byYear } = buildResultsPayloads({
        results: [{ id: "r1", level: "CLASS_10", academicYear: "2024-25", appeared: 10, passed: 9 }],
        institutionType: "SCHOOL",
      });
      const sslc = byYear.get("2024-25")!.streams.sslc as Record<string, unknown>;
      expect(sslc).not.toHaveProperty("boys");
      expect(sslc).not.toHaveProperty("girls");
    });
  });

  describe("bands (fix round 1: dropped, but never silently)", () => {
    it("warns once, by name, for a result that carries bands — they are never converted to PassPercent's fixed grade buckets", () => {
      const { byYear, warnings } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_10",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            bands: [{ label: "Distinction", minPercentage: 75, maxPercentage: 100, count: 4 }],
          },
        ],
        institutionType: "SCHOOL",
      });
      const sslc = byYear.get("2024-25")!.streams.sslc as Record<string, unknown>;
      expect(sslc).not.toHaveProperty("grades"); // no top-level grades fabricated from bands
      const bandsWarnings = warnings.filter((w) => w.includes("r1") && w.toLowerCase().includes("bands"));
      expect(bandsWarnings).toHaveLength(1);
      expect(bandsWarnings[0]).toContain("bands not pushed");
    });

    it("does not warn about bands for a result that has none", () => {
      const { warnings } = buildResultsPayloads({
        results: [{ id: "r1", level: "CLASS_10", academicYear: "2024-25", appeared: 10, passed: 9 }],
        institutionType: "SCHOOL",
      });
      expect(warnings.some((w) => w.toLowerCase().includes("bands"))).toBe(false);
    });

    it("warns once per result when two results in the same rollup group both carry bands", () => {
      const { warnings } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_12",
            academicYear: "2024-25",
            appeared: 50,
            passed: 45,
            bands: [{ label: "A", minPercentage: 90, maxPercentage: 100, count: 2 }],
          },
          {
            id: "r2",
            level: "PUC_2",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            bands: [{ label: "B", minPercentage: 80, maxPercentage: 90, count: 1 }],
          },
        ],
        institutionType: "PU_COLLEGE",
      });
      const bandsWarnings = warnings.filter((w) => w.toLowerCase().includes("bands"));
      expect(bandsWarnings).toHaveLength(2);
      expect(bandsWarnings.some((w) => w.includes("r1"))).toBe(true);
      expect(bandsWarnings.some((w) => w.includes("r2"))).toBe(true);
    });
  });

  describe("toppers", () => {
    it("skips a topper with rank == null and warns, keeping percentage -> pct for the rest", () => {
      const { byYear, warnings } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_10",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            toppers: [
              { id: "t1", name: "Ranked Rani", percentage: 98.5, rank: 1 },
              { id: "t2", name: "No Rank Nina", percentage: 97 }, // rank missing
            ],
          },
        ],
        institutionType: "SCHOOL",
      });
      const sslc = byYear.get("2024-25")!.streams.sslc as Record<string, unknown>;
      const toppers = sslc.toppers as Record<string, unknown>[];
      expect(toppers).toHaveLength(1);
      expect(toppers[0]).toMatchObject({ rank: 1, name: "Ranked Rani", pct: 98.5 });
      expect(warnings.some((w) => w.includes("No Rank Nina"))).toBe(true);
    });

    it("concatenates toppers across two results rolled into the same (stream, year)", () => {
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_12",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            toppers: [{ name: "A", percentage: 99, rank: 1 }],
          },
          {
            id: "r2",
            level: "PUC_2",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            toppers: [{ name: "B", percentage: 98, rank: 1 }],
          },
        ],
        institutionType: "PU_COLLEGE",
      });
      const puc = byYear.get("2024-25")!.streams.puc as Record<string, unknown>;
      expect((puc.toppers as unknown[]).length).toBe(2);
    });

    it("emits photoKey from photoUrl for the adapter to resolve later", () => {
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_10",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            toppers: [{ name: "A", percentage: 99, rank: 1, photoUrl: "media/toppers/a.jpg" }],
          },
        ],
        institutionType: "SCHOOL",
      });
      const sslc = byYear.get("2024-25")!.streams.sslc as Record<string, unknown>;
      const toppers = sslc.toppers as Record<string, unknown>[];
      expect(toppers[0].photoKey).toBe("media/toppers/a.jpg");
    });
  });

  describe("combinations", () => {
    it("maps combination fields with the averageScore -> avgScore rename, asserted by exact key both ways", () => {
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_12",
            academicYear: "2024-25",
            appeared: 50,
            passed: 45,
            combinations: [
              {
                id: "c1",
                label: "PCMB",
                appeared: 50,
                passed: 45,
                distinction: 10,
                firstClass: 20,
                highestScore: 99,
                averageScore: 78.4,
                grades: { "90+": 5, "80-90": 10, "70-80": 15, "60-70": 10, "50-60": 5, below50: 5 },
              },
            ],
          },
        ],
        institutionType: "PU_COLLEGE",
      });
      const puc = byYear.get("2024-25")!.streams.puc as Record<string, unknown>;
      const combo = (puc.combinations as Record<string, Record<string, unknown>>).PCMB;
      expect(combo).toHaveProperty("avgScore", 78.4);
      expect(combo).not.toHaveProperty("averageScore");
      expect(combo.highestScore).toBe(99); // unrenamed
      expect(combo.grades).toEqual({ "90+": 5, "80-90": 10, "70-80": 15, "60-70": 10, "50-60": 5, below50: 5 });
    });

    it("computes combination passPct from appeared/passed, rounded to 1 decimal (fix round 1: brief's field list omitted it)", () => {
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_12",
            academicYear: "2024-25",
            appeared: 50,
            passed: 45,
            combinations: [{ label: "PCMB", appeared: 3, passed: 1 }], // 33.333...% -> 33.3
          },
        ],
        institutionType: "PU_COLLEGE",
      });
      const puc = byYear.get("2024-25")!.streams.puc as Record<string, unknown>;
      const combo = (puc.combinations as Record<string, Record<string, unknown>>).PCMB;
      expect(combo.passPct).toBe(33.3);
    });

    it("omits combination passPct when appeared is null (unreported bound means unknown, not zero)", () => {
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_12",
            academicYear: "2024-25",
            appeared: 50,
            passed: 45,
            combinations: [{ label: "PCMB", passed: 10 }], // appeared never reported
          },
        ],
        institutionType: "PU_COLLEGE",
      });
      const puc = byYear.get("2024-25")!.streams.puc as Record<string, unknown>;
      const combo = (puc.combinations as Record<string, Record<string, unknown>>).PCMB;
      expect(combo).not.toHaveProperty("passPct");
    });

    it("omits combination passPct when appeared is a reported 0 — must never divide to NaN/Infinity", () => {
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_12",
            academicYear: "2024-25",
            appeared: 50,
            passed: 45,
            combinations: [{ label: "PCMB", appeared: 0, passed: 0 }],
          },
        ],
        institutionType: "PU_COLLEGE",
      });
      const puc = byYear.get("2024-25")!.streams.puc as Record<string, unknown>;
      const combo = (puc.combinations as Record<string, Record<string, unknown>>).PCMB;
      expect(combo).not.toHaveProperty("passPct");
      expect(combo.passPct).not.toBe(Number.NaN);
      expect(Number.isFinite(combo.passPct as number | undefined)).toBe(false); // undefined, not NaN/Infinity
    });

    it("keeps the FIRST combination on a duplicate label and warns, discarding the second", () => {
      const { byYear, warnings } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_12",
            academicYear: "2024-25",
            appeared: 50,
            passed: 45,
            combinations: [{ label: "PCMB", appeared: 50, passed: 45, highestScore: 99 }],
          },
          {
            id: "r2",
            level: "PUC_2",
            academicYear: "2024-25",
            appeared: 10,
            passed: 8,
            combinations: [{ label: "PCMB", appeared: 10, passed: 8, highestScore: 88 }],
          },
        ],
        institutionType: "PU_COLLEGE",
      });
      const puc = byYear.get("2024-25")!.streams.puc as Record<string, unknown>;
      const combos = puc.combinations as Record<string, Record<string, unknown>>;
      expect(Object.keys(combos)).toEqual(["PCMB"]);
      expect(combos.PCMB.highestScore).toBe(99); // first result's entry, not summed/averaged with the second
      expect(warnings.some((w) => w.includes("PCMB") && w.toLowerCase().includes("duplicate"))).toBe(true);
    });

    it("skips a rank-less topper within a combination and warns", () => {
      const { byYear, warnings } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "CLASS_12",
            academicYear: "2024-25",
            appeared: 50,
            passed: 45,
            combinations: [
              {
                label: "PCMB",
                toppers: [{ name: "No Rank", percentage: 90 }],
              },
            ],
          },
        ],
        institutionType: "PU_COLLEGE",
      });
      const puc = byYear.get("2024-25")!.streams.puc as Record<string, unknown>;
      const combo = (puc.combinations as Record<string, Record<string, unknown>>).PCMB;
      expect(combo.toppers).toBeUndefined();
      expect(warnings.some((w) => w.includes("No Rank"))).toBe(true);
    });
  });

  describe("placement", () => {
    it("maps eligible/placed/highestPackage and the averagePackage -> avgPackage rename, computing placementPct", () => {
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "UG",
            academicYear: "2024-25",
            appeared: 100,
            passed: 95,
            placement: { eligible: 200, placed: 150, highestPackage: 52, averagePackage: 8.4 },
          },
        ],
        institutionType: "ENGINEERING_COLLEGE",
      });
      const eng = byYear.get("2024-25")!.streams.engineering as Record<string, unknown>;
      const placement = eng.placement as Record<string, unknown>;
      expect(placement).toHaveProperty("avgPackage", 8.4);
      expect(placement).not.toHaveProperty("averagePackage");
      expect(placement.eligible).toBe(200);
      expect(placement.placed).toBe(150);
      expect(placement.highestPackage).toBe(52);
      expect(placement.placementPct).toBe(75);
    });

    it("does not compute placementPct when eligible is 0", () => {
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "UG",
            academicYear: "2024-25",
            appeared: 0,
            passed: 0,
            placement: { eligible: 0, placed: 0 },
          },
        ],
        institutionType: "ENGINEERING_COLLEGE",
      });
      const eng = byYear.get("2024-25")!.streams.engineering as Record<string, unknown>;
      const placement = eng.placement as Record<string, unknown>;
      expect(placement).not.toHaveProperty("placementPct");
    });

    it("does not compute placementPct when placed is missing", () => {
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "UG",
            academicYear: "2024-25",
            appeared: 100,
            passed: 90,
            placement: { eligible: 200 },
          },
        ],
        institutionType: "ENGINEERING_COLLEGE",
      });
      const eng = byYear.get("2024-25")!.streams.engineering as Record<string, unknown>;
      const placement = eng.placement as Record<string, unknown>;
      expect(placement).not.toHaveProperty("placementPct");
    });

    it("maps recruiters under the key 'recruiters' (PassPercent's StreamPlacementSchema field), NOT 'companies'", () => {
      // task-5-brief.md's pinned rule names this array "companies", but that is
      // the field name for PER-COMBINATION (branch-level) placement in
      // PassPercent's live schema (CombinationDataSchema.companies). IDAP's
      // top-level ResultDTO.placement is STREAM-level, whose live schema field
      // is StreamPlacementSchema.recruiters. Verified directly against
      // /Users/automicai/Documents/GitHub/passpercent/backend/src/models/Institution.js.
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "UG",
            academicYear: "2024-25",
            appeared: 100,
            passed: 90,
            placement: {
              eligible: 100,
              placed: 90,
              recruiters: [{ name: "Infosys", category: "IT", selected: 40, tieUp: true }],
            },
          },
        ],
        institutionType: "ENGINEERING_COLLEGE",
      });
      const eng = byYear.get("2024-25")!.streams.engineering as Record<string, unknown>;
      const placement = eng.placement as Record<string, unknown>;
      expect(placement).toHaveProperty("recruiters");
      expect(placement).not.toHaveProperty("companies");
    });

    it("maps every RECRUITER_CATEGORIES value to its identity-lowercase form exhaustively", () => {
      const recruiters = RECRUITER_CATEGORIES.map((category, i) => ({
        name: `Company ${i}`,
        category,
        tieUp: false,
      }));
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "UG",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            placement: { eligible: 10, placed: 9, recruiters },
          },
        ],
        institutionType: "ENGINEERING_COLLEGE",
      });
      const eng = byYear.get("2024-25")!.streams.engineering as Record<string, unknown>;
      const placement = eng.placement as Record<string, unknown>;
      const mapped = placement.recruiters as Record<string, unknown>[];
      expect(mapped.map((r) => r.category)).toEqual(RECRUITER_CATEGORIES.map((c) => c.toLowerCase()));
    });

    it("maps recruiter.averagePackage to avgPackage on each recruiter", () => {
      const { byYear } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "UG",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            placement: {
              eligible: 10,
              placed: 9,
              recruiters: [{ name: "Infosys", category: "IT", averagePackage: 6.5, tieUp: true }],
            },
          },
        ],
        institutionType: "ENGINEERING_COLLEGE",
      });
      const eng = byYear.get("2024-25")!.streams.engineering as Record<string, unknown>;
      const placement = eng.placement as Record<string, unknown>;
      const recruiter = (placement.recruiters as Record<string, unknown>[])[0];
      expect(recruiter).toHaveProperty("avgPackage", 6.5);
      expect(recruiter).not.toHaveProperty("averagePackage");
    });

    it("keeps the FIRST result's placement on a duplicate carrier and warns", () => {
      const { byYear, warnings } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "UG",
            academicYear: "2024-25",
            appeared: 100,
            passed: 90,
            placement: { eligible: 100, placed: 90 },
          },
          {
            id: "r2",
            level: "UG",
            academicYear: "2024-25",
            appeared: 50,
            passed: 40,
            placement: { eligible: 999, placed: 999 },
          },
        ],
        institutionType: "ENGINEERING_COLLEGE",
      });
      const eng = byYear.get("2024-25")!.streams.engineering as Record<string, unknown>;
      const placement = eng.placement as Record<string, unknown>;
      expect(placement.eligible).toBe(100); // first carrier wins wholesale
      expect(warnings.some((w) => w.toLowerCase().includes("duplicate") && w.toLowerCase().includes("placement"))).toBe(
        true,
      );
    });
  });

  describe("selections", () => {
    it("maps every EXAM_CODES value to its documented PassPercent key exhaustively", () => {
      const expected: Record<string, string> = {
        NEET: "neet",
        JEE_MAIN: "jeeMain",
        JEE_ADVANCED: "jeeAdvanced",
        KCET: "kcet",
        COMEDK: "comedk",
      };
      const selections = EXAM_CODES.map((examCode) => ({ examCode, appeared: 10, qualified: 5, bestRank: 1 }));
      const { byYear } = buildResultsPayloads({
        results: [
          { id: "r1", level: "PUC_2", academicYear: "2024-25", appeared: 10, passed: 9, selections },
        ],
        institutionType: "PU_COLLEGE",
      });
      const puc = byYear.get("2024-25")!.streams.puc as Record<string, unknown>;
      const mappedSelections = puc.selections as Record<string, unknown>;
      for (const code of EXAM_CODES) {
        expect(mappedSelections).toHaveProperty(expected[code]);
      }
    });

    it("maps selection topper percentage -> score and skips a rank-less one, warning", () => {
      const { byYear, warnings } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "PUC_2",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            selections: [
              {
                examCode: "NEET",
                appeared: 10,
                qualified: 2,
                bestRank: 5,
                toppers: [
                  { name: "Ranked", percentage: 99, rank: 5 },
                  { name: "Unranked", percentage: 95 },
                ],
              },
            ],
          },
        ],
        institutionType: "PU_COLLEGE",
      });
      const puc = byYear.get("2024-25")!.streams.puc as Record<string, unknown>;
      const neet = (puc.selections as Record<string, Record<string, unknown>>).neet;
      const toppers = neet.toppers as Record<string, unknown>[];
      expect(toppers).toHaveLength(1);
      expect(toppers[0]).toMatchObject({ name: "Ranked", rank: 5, score: 99 });
      expect(warnings.some((w) => w.includes("Unranked"))).toBe(true);
    });

    it("keeps the FIRST result's selections on a duplicate carrier and warns", () => {
      const { byYear, warnings } = buildResultsPayloads({
        results: [
          {
            id: "r1",
            level: "PUC_2",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            selections: [{ examCode: "NEET", qualified: 1 }],
          },
          {
            id: "r2",
            level: "CLASS_12",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            selections: [{ examCode: "NEET", qualified: 999 }],
          },
        ],
        institutionType: "PU_COLLEGE",
      });
      const puc = byYear.get("2024-25")!.streams.puc as Record<string, unknown>;
      const neet = (puc.selections as Record<string, Record<string, unknown>>).neet;
      expect(neet.qualified).toBe(1);
      expect(
        warnings.some((w) => w.toLowerCase().includes("duplicate") && w.toLowerCase().includes("selection")),
      ).toBe(true);
    });
  });
});
