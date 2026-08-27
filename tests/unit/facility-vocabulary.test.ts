import { describe, it, expect } from "vitest";
import {
  FACILITY_GROUPS,
  FACILITY_CODES,
  LEGACY_FACILITY_CODE_MAP,
  UNMAPPABLE_LEGACY_CODES,
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
