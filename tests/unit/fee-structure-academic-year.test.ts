import { describe, expect, it } from "vitest";
import { suggestNextAcademicYear } from "@/lib/fee-structure/academic-year";

describe("suggestNextAcademicYear", () => {
  it("suggests one year past the latest existing YYYY-YY year", () => {
    expect(suggestNextAcademicYear(["2025-26", "2026-27"])).toBe("2027-28");
  });

  it("ignores years that do not parse as YYYY-YY when others do", () => {
    expect(suggestNextAcademicYear(["Academic 2024", "2026-27"])).toBe("2027-28");
  });

  it("rolls the short year over at the century boundary", () => {
    expect(suggestNextAcademicYear(["2099-00"])).toBe("2100-01");
  });

  it("falls back to the date-derived current cycle when nothing parses", () => {
    const april = new Date(2026, 3, 1);
    expect(suggestNextAcademicYear([], april)).toBe("2026-27");
    expect(suggestNextAcademicYear(["Freeform label"], april)).toBe("2026-27");
  });

  it("falls back to the PRIOR cycle when today is before April", () => {
    const january = new Date(2026, 0, 15);
    expect(suggestNextAcademicYear([], january)).toBe("2025-26");
  });
});
