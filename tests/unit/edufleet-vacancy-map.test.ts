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
});

describe("buildSchoolJobBody", () => {
  it("MUTATION-DISTINGUISHING: never sends institutionName, city, district, state or sourceUrl", () => {
    const body = buildSchoolJobBody(vac());
    for (const forbidden of ["institutionName", "city", "district", "state", "sourceUrl"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("uses the vacancy id as externalJobId", () => {
    expect(buildSchoolJobBody(vac({ vacancyId: "vac-42" }))).toMatchObject({ externalJobId: "vac-42" });
  });
});

describe("buildAggregatedJobBody", () => {
  it("sends institutionName and city, which Contract Two must not carry", () => {
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
