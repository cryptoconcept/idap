import { describe, it, expect } from "vitest";
import cases from "../fixtures/hub-completeness-cases.json";
import { scholarshipHubMissingFields, assertScholarshipHubPublishable } from "@/lib/validation/scholarship";

describe("scholarshipHubMissingFields (gate parity with the Hub)", () => {
  const NOW = new Date("2026-09-06T00:00:00.000Z");
  for (const [i, c] of (cases as { input: Record<string, unknown>; expectedMissing: string[] }[]).entries()) {
    it(`case ${i} matches the Hub verdict`, () => {
      expect(scholarshipHubMissingFields(c.input, NOW).sort()).toEqual([...c.expectedMissing].sort());
    });
  }
  it("throws for an incomplete listing and passes a complete one", () => {
    expect(() => assertScholarshipHubPublishable({ name: "X" })).toThrow();
    const complete = (cases as { input: Record<string, unknown>; expectedMissing: string[] }[]).find((c) => c.expectedMissing.length === 0)!;
    expect(() => assertScholarshipHubPublishable({ ...complete.input, now: NOW } as never)).not.toThrow();
  });
});
