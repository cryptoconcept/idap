import { describe, expect, it } from "vitest";
import {
  buildAggregatedJobBody,
  buildSchoolJobBody,
  preflight,
  type InstitutionPushInput,
  type VacancyPushInput,
} from "@/lib/connectors/edufleet-vacancy-map";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function vac(overrides: Partial<VacancyPushInput> = {}): VacancyPushInput {
  return {
    vacancyId: "vac-1",
    title: "Mathematics Teacher",
    subject: "Mathematics",
    description: "Teach mathematics to grades 9-10.",
    ...overrides,
  };
}

function inst(overrides: Partial<InstitutionPushInput> = {}): InstitutionPushInput {
  return {
    institutionName: "DPS",
    city: "Bengaluru",
    ...overrides,
  };
}

describe("preflight", () => {
  it("MUTATION-DISTINGUISHING: refuses a Contract One push with no city, before any write is spent", () => {
    const reasons = preflight(vac(), { institutionName: "DPS" }, "AGGREGATED");
    expect(reasons).toContain("eduFleet needs a city on the institution profile before a job can be published");
  });

  it("MUTATION-DISTINGUISHING: refuses a subject outside eduFleet's enum", () => {
    expect(preflight(vac({ subject: "Astrology" }), inst(), "AGGREGATED"))
      .toContainEqual(expect.stringContaining("Astrology"));
  });

  it("refuses a salary range that inverts", () => {
    expect(preflight(vac({ salaryMin: 50000, salaryMax: 10000 }), inst(), "AGGREGATED"))
      .toContainEqual(expect.stringContaining("maximum"));
  });

  it("passes a complete vacancy", () => {
    expect(preflight(vac(), inst(), "AGGREGATED")).toEqual([]);
  });

  it("MUTATION-DISTINGUISHING: preflight refuses a Contract Two push with no city or branchId", () => {
    const reasons = preflight(vac(), { institutionName: "DPS" }, "SCHOOL_POSTED");
    expect(reasons).toContainEqual(expect.stringContaining("city"));
  });

  it("preflight accepts a Contract Two push carrying branchId instead of city", () => {
    expect(preflight(vac(), { institutionName: "DPS", branchId: "br-1" }, "SCHOOL_POSTED")).toEqual([]);
  });

  it("MUTATION-DISTINGUISHING: refuses a Contract One push carrying branchId but no city", () => {
    // FIX ROUND 2: branchId is a Contract Two concept only — Contract One's
    // createPartnerJob has no branchId field, so buildAggregatedJobBody never
    // sends one. A branchId-only institution must not clear preflight for
    // AGGREGATED, or the push would 400 at eduFleet with no location field
    // present, burning a write unit.
    const reasons = preflight(vac(), { institutionName: "DPS", branchId: "br-1" }, "AGGREGATED");
    expect(reasons).toContainEqual(expect.stringContaining("city"));
  });
});

describe("buildSchoolJobBody", () => {
  it("MUTATION-DISTINGUISHING: never sends institutionName, district, state or sourceUrl", () => {
    // FIX ROUND 1: `city` was wrongly on this forbidden list — SchoolJobInput
    // (partner-school-jobs.ts:12-23) declares `city?: string`, and Contract
    // Two 400s on every push without a city or branchId. Narrowed to the
    // four fields Contract Two genuinely never accepts.
    const body = buildSchoolJobBody(vac(), inst());
    for (const forbidden of ["institutionName", "district", "state", "sourceUrl"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("MUTATION-DISTINGUISHING: sends city on a Contract Two body — eduFleet 400s without it", async () => {
    // jobs.ts:38 defaults location to "" with no fallback to the school's
    // own record, then jobs.ts:59 throws "Job needs a location or branch".
    // Omitting city here fails 100% of pushes and burns a write unit each time.
    const body = buildSchoolJobBody(vac(), inst({ city: "Mysuru" }));
    expect(body).toMatchObject({ city: "Mysuru" });
  });

  it("uses the vacancy id as externalJobId", () => {
    expect(buildSchoolJobBody(vac({ vacancyId: "vac-42" }), inst())).toMatchObject({ externalJobId: "vac-42" });
  });
});

describe("buildAggregatedJobBody", () => {
  it("sends institutionName and city — institutionName is what Contract Two must not carry", () => {
    expect(buildAggregatedJobBody(vac(), inst())).toMatchObject({ institutionName: "DPS", city: "Bengaluru" });
  });

  it("MUTATION-DISTINGUISHING: drops a benefit eduFleet does not recognise rather than sending it", () => {
    // eduFleet's sanitizeFacilities() discards unknown labels SILENTLY — no
    // error, no signal — so an unknown benefit must never leave IDAP.
    //
    // The brief's literal test body used "Provident Fund" as the presumed
    // valid label, but VACANCY_BENEFITS (constants.ts:598) spells it
    // "Provident Fund (PF)" — "Provident Fund" alone is not on the list and
    // would be dropped by a correct filter same as "Free Parking". Corrected
    // to the real label so this test exercises what it claims to (see the
    // task-2 report for detail).
    const body = buildAggregatedJobBody(vac({ facilities: ["Provident Fund (PF)", "Free Parking"] }), inst());
    expect(body.facilities).toEqual(["Provident Fund (PF)"]);
  });
});
