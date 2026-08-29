import { describe, expect, it } from "vitest";
import {
  buildAggregatedJobBody,
  buildSchoolJobBody,
  preflight,
  preflightPatch,
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

describe("preflightPatch", () => {
  it("MUTATION-DISTINGUISHING: refuses a lone minimum that inverts against the maximum eduFleet still holds", () => {
    // The pair is fine in IDAP — there is no maximum to conflict with. It is
    // eduFleet that still holds 30000 and merges the patch over it
    // (`assertValidNumbers(job.salaryMin, job.salaryMax, …)`), so comparing
    // only what is being sent sees nothing and the 400 costs a write unit.
    const reasons = preflightPatch(vac({ salaryMin: 40000 }), { salaryMax: 30000 });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("30000");
    expect(reasons[0]).toContain("40000");
    // The wording must be actionable to someone whose own form shows no
    // maximum at all, so it names eduFleet's stored value rather than saying
    // "the minimum cannot exceed the maximum".
    expect(reasons[0]).toContain("close this listing and publish it again");
  });

  it("refuses the mirror case — a lone maximum below the minimum eduFleet holds", () => {
    const reasons = preflightPatch(vac({ salaryMax: 10000 }), { salaryMin: 40000 });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("40000");
  });

  it("uses the plain wording when both bounds are being sent, since the school can see the pair", () => {
    expect(preflightPatch(vac({ salaryMin: 50000, salaryMax: 10000 }), { salaryMax: 90000 })).toEqual([
      "The salary minimum cannot exceed the maximum",
    ]);
  });

  it("passes when the bound being sent clears the one eduFleet holds", () => {
    expect(preflightPatch(vac({ salaryMin: 20000 }), { salaryMax: 30000 })).toEqual([]);
  });

  it("passes when eduFleet holds nothing to merge against", () => {
    expect(preflightPatch(vac({ salaryMin: 40000 }), {})).toEqual([]);
    expect(preflightPatch(vac({ salaryMin: 40000 }))).toEqual([]);
  });

  it("MUTATION-DISTINGUISHING: ignores subject, institutionName and city — no PATCH route reads them", () => {
    // The create-time preflight refuses all three. Refusing them again on an
    // update would block a title fix on a live public advert over fields the
    // request does not contain, preventing no rejection and saving no unit.
    expect(preflightPatch(vac({ subject: "Astrology" }), {})).toEqual([]);
    expect(preflight(vac({ subject: "Astrology" }), inst(), "AGGREGATED")).not.toEqual([]);
  });

  it("still refuses an empty title or description, which is what both routes DO check", () => {
    // Title: `if (!patch.title.trim()) throw` on both. Description: neither
    // route checks it, and eduFleet's schema requires it — so an empty one
    // escapes as an uncataloged 500 after taking the write unit.
    expect(preflightPatch(vac({ title: "   " }), {})).toEqual([
      "A vacancy needs a title before it can be published to eduFleet",
    ]);
    expect(preflightPatch(vac({ description: "" }), {})).toEqual([
      "A vacancy needs a description before it can be published to eduFleet",
    ]);
  });

  it("refuses a negative experience, which both routes validate", () => {
    expect(preflightPatch(vac({ experienceRequired: -1 }), {})).toEqual([
      "Experience required cannot be negative",
    ]);
  });
});

describe("buildSchoolJobBody", () => {
  it("MUTATION-DISTINGUISHING: never sends institutionName, district, state or sourceUrl", () => {
    // FIX ROUND 1: `city` was wrongly on this forbidden list — SchoolJobInput
    // (partner-school-jobs.ts:12-23) declares `city?: string`, and Contract
    // Two 400s on every push without a city or branchId. Narrowed to the
    // four fields Contract Two genuinely never accepts.
    //
    // H-1: `district` is now sent on Contract One, so this guard matters
    // more than it did — the institution below HAS one, and Contract Two
    // must still never carry it. The grant already identifies the school.
    const { body } = buildSchoolJobBody(vac(), inst({ district: "Bengaluru Urban" }));
    for (const forbidden of ["institutionName", "district", "state", "sourceUrl"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("MUTATION-DISTINGUISHING: sends city on a Contract Two body — eduFleet 400s without it", async () => {
    // jobs.ts:38 defaults location to "" with no fallback to the school's
    // own record, then jobs.ts:59 throws "Job needs a location or branch".
    // Omitting city here fails 100% of pushes and burns a write unit each time.
    const { body } = buildSchoolJobBody(vac(), inst({ city: "Mysuru" }));
    expect(body).toMatchObject({ city: "Mysuru" });
  });

  it("uses the vacancy id as externalJobId", () => {
    expect(buildSchoolJobBody(vac({ vacancyId: "vac-42" }), inst()).body).toMatchObject({
      externalJobId: "vac-42",
    });
  });

  it("never warns — it has no field it could have to leave out", () => {
    // Structural, not incidental: `district` is the only value IDAP must
    // resolve before sending, and this route does not accept it. If this ever
    // starts returning a warning, a field was added to a Contract Two body
    // that eduFleet validates against a list IDAP does not control.
    expect(buildSchoolJobBody(vac(), inst({ district: "Bangalore" })).warnings).toEqual([]);
  });
});

describe("buildAggregatedJobBody", () => {
  it("sends institutionName and city — institutionName is what Contract Two must not carry", () => {
    expect(buildAggregatedJobBody(vac(), inst()).body).toMatchObject({
      institutionName: "DPS",
      city: "Bengaluru",
    });
  });

  it("still sends state — eduFleet never validates it, it only gates the district check", () => {
    // `createPartnerJob` reads `state` once, only to decide whether the
    // district/taluk checks apply, and otherwise stores it verbatim. There is
    // no enum and no rejection path for it, so it costs nothing to send and
    // is real display data on the advert. IDAP never sends `taluk`, which is
    // guarded by the same `isKarnataka && ...` conditional.
    const { body } = buildAggregatedJobBody(vac(), inst({ state: "Karnataka" }));
    expect(body).toMatchObject({ state: "Karnataka" });
    expect(body).not.toHaveProperty("taluk");
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
    const { body } = buildAggregatedJobBody(
      vac({ facilities: ["Provident Fund (PF)", "Free Parking"] }),
      inst(),
    );
    expect(body.facilities).toEqual(["Provident Fund (PF)"]);
  });

  it("MUTATION-DISTINGUISHING: an empty benefit list is SENT as [], while an absent one is omitted", () => {
    // M2. The two mean different things on the wire. `[]` is "the school
    // removed every benefit", which eduFleet applies — both PATCH routes run
    // `sanitizeFacilities(patch.facilities)` and its version returns `[]` for
    // `[]`. Absent is "IDAP has nothing to say", and eduFleet keeps what it
    // holds. Collapsing the first into the second made the clear unsendable.
    expect(buildAggregatedJobBody(vac({ facilities: [] }), inst()).body.facilities).toEqual([]);
    expect(buildAggregatedJobBody(vac(), inst()).body).not.toHaveProperty("facilities");
    // Contract Two goes through the same helper, so it must agree.
    expect(buildSchoolJobBody(vac({ facilities: [] }), inst()).body.facilities).toEqual([]);
  });
});

/**
 * H-1. eduFleet's `createPartnerJob` ends with `notifyMatchingTeachers(job)`
 * (`partner-jobs.ts:185`), and both matchers in `job-match-logic.ts` read
 * `job.district`: `jobLocationMatchesTeacher` compares districts whenever
 * both sides have one, and `jobMatchesSavedAlert` compares a district-scoped
 * alert against `job.district` — falling back, when the job has none, to
 * comparing the alert's DISTRICT NAME against the job's CITY string, which is
 * a guaranteed miss for all but a handful of districts. So an advert with no
 * district loses district matching and district-scoped alerts outright.
 *
 * The field still cannot be forwarded raw: `isValidKarnatakaDistrict` is
 * `Object.hasOwn`, exact and case-sensitive, and `spendWrite` runs before
 * validation, so a legacy spelling burns a unit from the platform-wide pool.
 * Hence resolve-then-send-or-omit, and never a refusal.
 */
describe("buildAggregatedJobBody and the district", () => {
  it("MUTATION-DISTINGUISHING: sends a recognised district, so the advert keeps eduFleet's district matching", () => {
    const { body, warnings } = buildAggregatedJobBody(vac(), inst({ district: "Bengaluru Urban" }));
    expect(body.district).toBe("Bengaluru Urban");
    expect(warnings).toEqual([]);
  });

  it("MUTATION-DISTINGUISHING: sends the CANONICAL spelling, not what the school typed", () => {
    // `Object.hasOwn(KARNATAKA_DISTRICTS, district)` — exact and
    // case-sensitive. A body carrying "bengaluru  urban" 400s exactly like
    // one carrying an unknown name, and takes the same write unit doing it,
    // so folding case and internal whitespace is not cosmetic.
    expect(buildAggregatedJobBody(vac(), inst({ district: "  bengaluru  URBAN " })).body.district)
      .toBe("Bengaluru Urban");
  });

  it("MUTATION-DISTINGUISHING: resolves the 2014 renames a school still has on file", () => {
    // These are the spellings on letterheads, and each names exactly one
    // district on eduFleet's current list, so resolving them involves no
    // guess about what was meant.
    for (const [legacy, canonical] of [
      ["Mysore", "Mysuru"],
      ["Belgaum", "Belagavi"],
      ["Gulbarga", "Kalaburagi"],
      ["Bijapur", "Vijayapura"],
      ["Shimoga", "Shivamogga"],
      ["Tumkur", "Tumakuru"],
      ["Bellary", "Ballari"],
      ["Chikmagalur", "Chikkamagaluru"],
      ["Bangalore Urban", "Bengaluru Urban"],
      ["Bangalore Rural", "Bengaluru Rural"],
    ]) {
      const { body, warnings } = buildAggregatedJobBody(vac(), inst({ district: legacy }));
      expect(body.district, legacy).toBe(canonical);
      expect(warnings, legacy).toEqual([]);
    }
  });

  it("MUTATION-DISTINGUISHING: never guesses an ambiguous or city-shaped value — it omits and warns", () => {
    // "Bangalore" is two districts (Bengaluru Urban and Bengaluru Rural) with
    // two different sets of teachers; "Mangalore" is a CITY in Dakshina
    // Kannada and "Hospet" a TALUK of Vijayanagara, neither ever a district
    // name. Guessing any of them sends the advert to the wrong district's
    // teachers permanently and silently, which is worse than sending none.
    for (const guessable of ["Bangalore", "Bengaluru", "Mangalore", "Hospet"]) {
      const { body, warnings } = buildAggregatedJobBody(vac(), inst({ district: guessable }));
      expect(body, guessable).not.toHaveProperty("district");
      expect(warnings, guessable).toHaveLength(1);
      expect(warnings[0], guessable).toContain(guessable);
    }
  });

  it("MUTATION-DISTINGUISHING: an unrecognised district is omitted AND reported, never dropped silently", () => {
    // The `sanitizeFacilities` antipattern this module exists to avoid is a
    // body that says less than the caller believes it says. The omission and
    // the report come out of the same call, so there is no arrangement in
    // which one happens without the other.
    const { body, warnings } = buildAggregatedJobBody(vac(), inst({ district: "Banglore Urbon" }));

    expect(body).not.toHaveProperty("district");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Banglore Urbon");
    // Names the consequence a school can act on, not an error code.
    expect(warnings[0]).toMatch(/alert/i);
    // Control: an unresolvable district costs the advert nothing else.
    expect(body).toMatchObject({ institutionName: "DPS", city: "Bengaluru" });
  });

  it("MUTATION-DISTINGUISHING: an unrecognised district never becomes a refusal", () => {
    // The advert is entirely publishable without a district, and it costs no
    // write unit: with no `district` key, eduFleet's
    // `isKarnataka && district && !isValidKarnatakaDistrict(district)`
    // conjunction is false whatever the state says. A `preflight` reason
    // here would block the publish outright — trading a reach limitation for
    // a hard failure, and blocking legitimate publishes the day Karnataka
    // notifies a new district.
    expect(preflight(vac(), inst({ district: "Banglore Urbon" }), "AGGREGATED")).toEqual([]);
    expect(preflight(vac(), inst({ district: "Bengaluru Urban" }), "AGGREGATED")).toEqual([]);
  });

  it("says nothing when the institution simply has no district on file", () => {
    // A warning for an empty optional field is noise that teaches admins to
    // dismiss the ones that matter.
    for (const empty of [undefined, "", "   "]) {
      const { body, warnings } = buildAggregatedJobBody(vac(), inst({ district: empty }));
      expect(body).not.toHaveProperty("district");
      expect(warnings).toEqual([]);
    }
  });
});
