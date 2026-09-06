import { describe, expect, it } from "vitest";
import { pruneEmptyScholarshipSubdocs } from "@/lib/scholarship/prune-empty-subdocs";
import type { CreateScholarshipInput } from "@/lib/validation/scholarship";

/**
 * The UI convention gap, same as `scholarship-listing-display.test.ts`:
 * IDAP has no React component-test harness, so `scholarship-form.tsx`'s
 * submit-time data hygiene is tested through the pure helper it calls
 * rather than by rendering the form.
 *
 * The bug this guards: `defaultValues` seeds `benefits`/`eligibility`/
 * `dates` as non-empty sub-objects (booleans default `false`, arrays `[]`,
 * dates `""`), and RHF always keeps those keys in form state. Since
 * `JSON.stringify` only drops keys whose *value* is `undefined` (not
 * `false`/`[]`/`""`), every save used to submit a spurious, mostly-empty
 * sub-document even when the user never opened that section — a regression
 * against the pre-Task-10 baseline, where an untouched section left the
 * field genuinely absent.
 */
describe("pruneEmptyScholarshipSubdocs", () => {
  it("drops benefits/eligibility/dates when every value is the untouched-form default (false/[]/undefined)", () => {
    const payload = {
      name: "Merit Scholarship",
      benefits: {
        amountMin: undefined,
        amountMax: undefined,
        stipendMonthly: undefined,
        awards: undefined,
        tuitionWaiver: false,
      },
      eligibility: {
        stateCodes: [],
        districtCodes: [],
        educationLevels: [],
        classesOrCourses: [],
        streams: [],
        genders: [],
        ageMin: undefined,
        ageMax: undefined,
        minPercentage: undefined,
        maxAnnualIncome: undefined,
        communityCategories: [],
        disabilityRequired: false,
        otherCriteria: [],
      },
      dates: { opensAt: undefined, closesAt: undefined, resultAt: undefined },
    };

    const pruned = pruneEmptyScholarshipSubdocs(payload);

    expect(pruned.benefits).toBeUndefined();
    expect(pruned.eligibility).toBeUndefined();
    expect(pruned.dates).toBeUndefined();
    // Untouched fields elsewhere on the payload must survive unchanged.
    expect(pruned.name).toBe("Merit Scholarship");
    // The wire check that actually matters: JSON.stringify must drop the key
    // entirely, not serialize it as "benefits": null or similar.
    expect(JSON.stringify(pruned)).not.toContain("benefits");
    expect(JSON.stringify(pruned)).not.toContain("eligibility");
    expect(JSON.stringify(pruned)).not.toContain("dates");
  });

  it("also drops an empty-string dates sub-document (the untouched <input type=date> default)", () => {
    const pruned = pruneEmptyScholarshipSubdocs({
      dates: { opensAt: "", closesAt: "", resultAt: "" },
    });
    expect(pruned.dates).toBeUndefined();
  });

  it("keeps a populated benefits/eligibility/dates sub-document exactly as set", () => {
    const payload: Partial<CreateScholarshipInput> = {
      name: "Merit Scholarship",
      benefits: {
        amountMin: undefined,
        amountMax: undefined,
        stipendMonthly: undefined,
        awards: undefined,
        tuitionWaiver: true,
      },
      eligibility: {
        stateCodes: ["KA"],
        districtCodes: [],
        educationLevels: [],
        classesOrCourses: [],
        streams: [],
        genders: [],
        ageMin: undefined,
        ageMax: undefined,
        minPercentage: undefined,
        maxAnnualIncome: undefined,
        communityCategories: [],
        disabilityRequired: false,
        otherCriteria: [],
      },
      dates: { opensAt: undefined, closesAt: "2026-12-01", resultAt: undefined },
    };

    const pruned = pruneEmptyScholarshipSubdocs(payload);

    expect(pruned.benefits?.tuitionWaiver).toBe(true);
    expect(pruned.eligibility?.stateCodes).toEqual(["KA"]);
    expect(pruned.dates?.closesAt).toBe("2026-12-01");
  });

  it("treats a real amountMin of 0 as meaningful (a user-entered value, not silence)", () => {
    const pruned = pruneEmptyScholarshipSubdocs({
      benefits: { amountMin: 0, tuitionWaiver: false },
    });
    expect(pruned.benefits).toEqual({ amountMin: 0, tuitionWaiver: false });
  });

  it("leaves an already-absent sub-document alone", () => {
    const payload: Partial<CreateScholarshipInput> = { name: "Merit" };
    const pruned = pruneEmptyScholarshipSubdocs(payload);
    expect(pruned.benefits).toBeUndefined();
    expect(pruned.eligibility).toBeUndefined();
    expect(pruned.dates).toBeUndefined();
  });
});
