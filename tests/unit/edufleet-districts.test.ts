import { describe, expect, it } from "vitest";
import { EDUFLEET_KARNATAKA_DISTRICTS } from "@/lib/constants";
import { resolveDistrict } from "@/lib/connectors/edufleet-vacancy-map";

/**
 * The transcription pin for eduFleet's Karnataka district vocabulary — the
 * same job `facility-vocabulary.test.ts` does for PassPercent's facility keys,
 * and for the same reason: a typo in a transcribed list passes every other
 * test in the suite while quietly costing the thing the list exists for.
 *
 * Transcribed rather than read at runtime, because eduFleet is a sibling
 * checkout absent on CI — and because publishing a vacancy must not depend on
 * eduFleet being reachable.
 */
describe("eduFleet's Karnataka districts", () => {
  it("matches KARNATAKA_DISTRICTS verbatim, in source order", () => {
    // Transcribed from
    // /Users/automicai/edufleet-exchange/web/src/lib/karnataka-taxonomy.ts
    // (`KARNATAKA_DISTRICTS`), in that file's exact key order. The spelling is
    // the contract: `isValidKarnatakaDistrict` is `Object.hasOwn`, so a single
    // wrong character turns a valid district into a 400 that costs a write
    // unit from the platform-wide pool — and, once the push is refused, a
    // school with a perfectly good profile loses its advert entirely.
    expect(EDUFLEET_KARNATAKA_DISTRICTS).toEqual([
      "Bagalkot", "Ballari", "Belagavi", "Bengaluru Rural", "Bengaluru Urban",
      "Bidar", "Chamarajanagar", "Chikkaballapur", "Chikkamagaluru", "Chitradurga",
      "Dakshina Kannada", "Davanagere", "Dharwad", "Gadag", "Hassan",
      "Haveri", "Kalaburagi", "Kodagu", "Kolar", "Koppal",
      "Mandya", "Mysuru", "Raichur", "Ramanagara", "Shivamogga",
      "Tumakuru", "Udupi", "Uttara Kannada", "Vijayapura", "Vijayanagara",
      "Yadgir",
    ]);
  });

  it("carries 31 districts with no duplicates", () => {
    expect(EDUFLEET_KARNATAKA_DISTRICTS).toHaveLength(31);
    expect(new Set(EDUFLEET_KARNATAKA_DISTRICTS).size).toBe(31);
  });

  it("MUTATION-DISTINGUISHING: resolves every key to ITSELF", () => {
    // The lookup is derived from this array, so this pins the property the
    // wire actually depends on: whatever is on the list goes over the wire
    // spelled exactly as eduFleet's `Object.hasOwn` expects it. A resolver
    // that lower-cased, trimmed differently or normalised the canonical form
    // would pass a "did it resolve?" assertion and still 400 every push.
    for (const district of EDUFLEET_KARNATAKA_DISTRICTS) {
      expect(resolveDistrict(district), district).toBe(district);
    }
  });

  it("MUTATION-DISTINGUISHING: every alias target is a real key on this list", () => {
    // An alias pointing at a spelling eduFleet does not hold would be worse
    // than no alias at all: it converts a value IDAP would have omitted with
    // a warning into a body that 400s and burns a unit. Reached through the
    // resolver rather than the private map, so it holds whatever shape the
    // aliases are stored in.
    const legacyNames = [
      "Bangalore Urban", "Bangalore Rural", "Belgaum", "Bellary", "Bijapur",
      "Chikmagalur", "Gulbarga", "Mysore", "Shimoga", "Tumkur",
    ];
    for (const legacy of legacyNames) {
      const resolved = resolveDistrict(legacy);
      expect(resolved, legacy).toBeDefined();
      expect(EDUFLEET_KARNATAKA_DISTRICTS, legacy).toContain(resolved);
    }
  });

  it("MUTATION-DISTINGUISHING: refuses to resolve anything ambiguous or not a district name", () => {
    // `Bangalore`/`Bengaluru` alone are two districts; `Mangalore` and
    // `Hospet` are a city and a taluk. Each of these must fall through to
    // omit-and-warn rather than be guessed at — a wrong guess sends the
    // advert to the wrong district's teachers, permanently and silently.
    for (const value of ["Bangalore", "Bengaluru", "Mangalore", "Mangaluru", "Hospet", "Hosapete"]) {
      expect(resolveDistrict(value), value).toBeUndefined();
    }
  });

  it("returns undefined for nothing at all, rather than an empty-string district", () => {
    expect(resolveDistrict(undefined)).toBeUndefined();
    expect(resolveDistrict("")).toBeUndefined();
    expect(resolveDistrict("   ")).toBeUndefined();
  });

  it("MUTATION-DISTINGUISHING: does not resolve a prototype key as a district", () => {
    // eduFleet uses `Object.hasOwn` rather than `in` for exactly this reason
    // (its own comment says so). IDAP's lookup is a `Map`, which has the same
    // property for free — pinned so a refactor to a plain object literal
    // cannot silently reintroduce the hole on this side of the wire.
    for (const value of ["constructor", "__proto__", "toString"]) {
      expect(resolveDistrict(value), value).toBeUndefined();
    }
  });
});
