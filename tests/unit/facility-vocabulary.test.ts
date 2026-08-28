import { describe, it, expect } from "vitest";
import {
  FACILITY_GROUPS,
  FACILITY_CODES,
  isFacilitySelected,
  LEGACY_FACILITY_CODE_MAP,
  UNMAPPABLE_LEGACY_CODES,
  withoutFacility,
} from "@/lib/profile/facilities";
import { toFacilityCode } from "@/components/profile/section-form";

describe("facility vocabulary", () => {
  it("carries all 38 PassPercent keys, lowercase, with no duplicates", () => {
    expect(FACILITY_CODES).toHaveLength(38);
    expect(new Set(FACILITY_CODES).size).toBe(38);
    for (const code of FACILITY_CODES) expect(code).toMatch(/^[a-z_]+$/);
  });

  // Transcribed (not read at runtime — passpercent is a sibling checkout absent
  // on CI) from passpercent/backend/src/utils/facilities.js FACILITY_KEYS, in
  // that file's exact source order. Pins the 38 key names themselves: a typo
  // like "libary" for "library" would pass every other test in this file but
  // fails this one.
  it("matches PassPercent's FACILITY_KEYS verbatim, in source order", () => {
    expect(FACILITY_CODES).toEqual([
      // academics
      "smart_classes", "library", "computer_lab", "science_lab", "language_lab",
      "ac_classrooms", "wifi", "digital_library",
      // sports
      "playground", "indoor_games", "swimming", "gym", "athletics", "basketball",
      "cricket", "yoga",
      // infrastructure
      "auditorium", "cafeteria", "transport", "medical_room", "meals",
      "power_backup", "ramp_access",
      // safety
      "cctv", "security_guards", "fire_safety", "gps_buses", "visitor_check", "counselor",
      // extracurricular
      "art", "music", "dance", "drama", "debate", "robotics",
      // boarding
      "boys_hostel", "girls_hostel", "day_boarding",
    ]);
  });

  it("partitions the 38 codes into PassPercent's six named groups, in order", () => {
    expect(FACILITY_GROUPS.map((g) => g.group)).toEqual([
      "Academics",
      "Sports",
      "Infrastructure",
      "Safety",
      "Extracurricular",
      "Boarding",
    ]);
    expect(FACILITY_GROUPS.map((g) => g.items.length)).toEqual([8, 8, 7, 6, 6, 3]);
  });

  it("gives every code a non-empty label", () => {
    for (const { items } of FACILITY_GROUPS) {
      for (const item of items) expect(item.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("maps the nine convertible legacy codes to real keys", () => {
    expect(LEGACY_FACILITY_CODE_MAP).toEqual({
      LIBRARY: "library",
      SCIENCE_LAB: "science_lab",
      COMPUTER_LAB: "computer_lab",
      PLAYGROUND: "playground",
      AUDITORIUM: "auditorium",
      TRANSPORT: "transport",
      CAFETERIA: "cafeteria",
      SMART_CLASSROOM: "smart_classes",
      DIGITAL_LEARNING: "digital_library",
    });
    for (const target of Object.values(LEGACY_FACILITY_CODE_MAP)) {
      expect(FACILITY_CODES).toContain(target);
    }
  });

  // toFacilityCode has no other test coverage (`grep -rn "toFacilityCode" tests/`
  // finds nothing else) even though it derives the codes the free-text "Add
  // your own" path stores. The second assertion is load-bearing: it ties the
  // free-text path to the vocabulary itself, so the two can never silently
  // drift apart again — it fails if toFacilityCode reverts to uppercase, and
  // it would also fail if the vocabulary were re-cased without the function
  // following.
  it("derives lower-snake codes that agree with the vocabulary's own casing", () => {
    expect(toFacilityCode("Robotics Lab")).toBe("robotics_lab");
    expect(FACILITY_CODES).toContain(toFacilityCode("Library"));
  });

  // MUTATION-DISTINGUISHING: HOSTEL and SPORTS must NOT appear in the map.
  // Adding either — however plausible the target looks — is the data-fabrication
  // this list exists to prevent.
  it("refuses to map HOSTEL and SPORTS", () => {
    expect(UNMAPPABLE_LEGACY_CODES).toEqual(["HOSTEL", "SPORTS"]);
    expect(LEGACY_FACILITY_CODE_MAP).not.toHaveProperty("HOSTEL");
    expect(LEGACY_FACILITY_CODE_MAP).not.toHaveProperty("SPORTS");
  });
});

describe("isFacilitySelected", () => {
  // Every institution is un-migrated at deploy time (`migrate:facility-codes
  // --apply` has never been run), so an admin's stored `facilities` array is
  // full of these old-vocabulary codes for the entire window between deploy
  // and migration — this is not an edge case for stale data, it is the
  // starting state for every school. Found via Task 13's browser
  // verification: without this equivalence, the `library` chip read as
  // unpressed against a stored `LIBRARY` row, and one click appended a
  // second `library` row alongside the untouched `LIBRARY` one.

  // MUTATION-DISTINGUISHING: with the legacy-equivalence lookup removed
  // (i.e. `isFacilitySelected` falling back to plain `===` membership), this
  // is the one that fails — `LIBRARY` a legacy code and `library` a new one,
  // so only the reverse-lookup path can equate them.
  it("treats a stored LIBRARY row as the library chip already being selected", () => {
    expect(isFacilitySelected(["LIBRARY"], "library")).toBe(true);
  });

  it("treats a stored library row as the library chip already being selected", () => {
    expect(isFacilitySelected(["library"], "library")).toBe(true);
  });

  it("does not match a stored HOSTEL row to any chip in the vocabulary", () => {
    // HOSTEL is deliberately absent from LEGACY_FACILITY_CODE_MAP (it must
    // keep its "needs re-picking" marker, not silently pair off with
    // boys_hostel or girls_hostel), so no code in the whole vocabulary — not
    // just the two boarding codes — may read as selected because of it.
    for (const code of FACILITY_CODES) {
      expect(isFacilitySelected(["HOSTEL"], code)).toBe(false);
    }
  });

  it("does not match a stored SPORTS row to any chip in the vocabulary", () => {
    for (const code of FACILITY_CODES) {
      expect(isFacilitySelected(["SPORTS"], code)).toBe(false);
    }
  });

  it("does not match a stored custom code to any chip in the vocabulary", () => {
    // ROBOTICS_LAB is an admin-invented code, not a legacy PassPercent one —
    // it must not fuzzy- or substring-match "robotics" or anything else.
    for (const code of FACILITY_CODES) {
      expect(isFacilitySelected(["ROBOTICS_LAB"], code)).toBe(false);
    }
  });

  // This is the guard `FacilitiesSection`'s `has()` — and therefore
  // `addFacility` — actually calls. If a legacy row is already present,
  // pressing the equivalent chip must read as "already selected" rather than
  // appending a second, redundant row for the same real-world facility.
  it("reports the library chip as already selected when a legacy LIBRARY row is present, so adding it again is a no-op", () => {
    const selectedCodes = ["LIBRARY"];
    expect(isFacilitySelected(selectedCodes, "library")).toBe(true);
    // The component only pushes a new row when `has(code)` is false — this
    // is exactly that check, on the exact codes a real un-migrated
    // institution would have stored.
  });
});

describe("withoutFacility", () => {
  // `FacilitiesSection`'s chip is a toggle: `isFacilitySelected` decides
  // whether it renders pressed, and this decides what a click on a pressed
  // chip removes. Until both agree, a chip can be pressed and un-pressable —
  // which is the state EVERY institution is in before `migrate:facility-codes
  // --apply` runs, because every stored row is still a legacy code.

  // MUTATION-DISTINGUISHING: revert `withoutFacility` to a plain
  // `entry.code !== code` filter and this is the one that fails — the stored
  // row is the legacy `LIBRARY` and the chip's code is the new `library`, so
  // only the legacy-aware comparison can pair them.
  it("removes a stored legacy LIBRARY row when the library chip is de-selected", () => {
    const selected = [{ code: "LIBRARY", label: "Library", available: true, note: "" }];
    expect(withoutFacility(selected, "library")).toEqual([]);
  });

  it("removes an already-migrated library row when the library chip is de-selected", () => {
    const selected = [{ code: "library", label: "Library", available: true, note: "" }];
    expect(withoutFacility(selected, "library")).toEqual([]);
  });

  // A mixed array is the real state of an institution that added a facility
  // after the deploy but before the migration: one legacy row, one new one.
  // De-selecting a chip must take out its own row and nothing else.
  it("removes only the de-selected chip's row, legacy or not, leaving the rest alone", () => {
    const selected = [
      { code: "LIBRARY", label: "Library", available: true, note: "" },
      { code: "playground", label: "Playground", available: true, note: "" },
      { code: "ROBOTICS_LAB", label: "Robotics Lab", available: true, note: "" },
    ];

    expect(withoutFacility(selected, "library").map((entry) => entry.code)).toEqual([
      "playground",
      "ROBOTICS_LAB",
    ]);
    expect(withoutFacility(selected, "playground").map((entry) => entry.code)).toEqual([
      "LIBRARY",
      "ROBOTICS_LAB",
    ]);
  });

  // Every mapped code, not just `library`: the pressed state is legacy-aware
  // for all nine, so the removal must be too, or eight of them stay broken.
  it("removes the legacy row for every one of the nine convertible codes", () => {
    for (const [legacy, current] of Object.entries(LEGACY_FACILITY_CODE_MAP)) {
      const selected = [{ code: legacy, label: legacy, available: true, note: "" }];
      expect(isFacilitySelected([legacy], current)).toBe(true);
      expect(withoutFacility(selected, current)).toEqual([]);
    }
  });

  // The mirror of `isFacilitySelected`'s HOSTEL/SPORTS tests: a row no chip
  // reads as selected must be a row no chip can delete. Losing an unmappable
  // legacy row to an unrelated click would destroy the very facility the
  // "Needs re-picking" badge exists to have an admin re-state.
  it("never removes an unmappable legacy row, whichever chip is clicked", () => {
    for (const legacy of UNMAPPABLE_LEGACY_CODES) {
      const selected = [{ code: legacy, label: legacy, available: true, note: "" }];
      for (const code of FACILITY_CODES) {
        expect(withoutFacility(selected, code)).toEqual(selected);
      }
    }
  });
});
