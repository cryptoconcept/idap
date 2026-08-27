import { describe, it, expect } from "vitest";
import {
  FACILITY_GROUPS,
  FACILITY_CODES,
  LEGACY_FACILITY_CODE_MAP,
  UNMAPPABLE_LEGACY_CODES,
} from "@/lib/profile/facilities";

describe("facility vocabulary", () => {
  it("carries all 38 PassPercent keys, lowercase, with no duplicates", () => {
    expect(FACILITY_CODES).toHaveLength(38);
    expect(new Set(FACILITY_CODES).size).toBe(38);
    for (const code of FACILITY_CODES) expect(code).toMatch(/^[a-z_]+$/);
  });

  it("groups every code exactly once", () => {
    const grouped = FACILITY_GROUPS.flatMap((g) => g.items.map((i) => i.code));
    expect(grouped.sort()).toEqual([...FACILITY_CODES].sort());
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

  // MUTATION-DISTINGUISHING: HOSTEL and SPORTS must NOT appear in the map.
  // Adding either — however plausible the target looks — is the data-fabrication
  // this list exists to prevent.
  it("refuses to map HOSTEL and SPORTS", () => {
    expect(UNMAPPABLE_LEGACY_CODES).toEqual(["HOSTEL", "SPORTS"]);
    expect(LEGACY_FACILITY_CODE_MAP).not.toHaveProperty("HOSTEL");
    expect(LEGACY_FACILITY_CODE_MAP).not.toHaveProperty("SPORTS");
  });
});
