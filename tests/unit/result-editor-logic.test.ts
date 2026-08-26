import { describe, expect, it } from "vitest";
import { blockingPublishReasons } from "@/lib/results/publish-readiness";

const ready = {
  id: "1",
  board: "CBSE",
  level: "CLASS_10",
  stream: null,
  academicYear: "2025-26",
  appeared: 142,
  passed: 140,
  passPercentage: 98.6,
  status: "DRAFT",
} as const;

describe("blockingPublishReasons", () => {
  it("returns nothing for a publishable cycle", () => {
    expect(blockingPublishReasons({ ...ready })).toEqual([]);
  });

  it("names an empty cohort", () => {
    const reasons = blockingPublishReasons({ ...ready, appeared: 0, passed: 0 });
    expect(reasons.join(" ")).toMatch(/appeared/i);
  });

  it("names every topper still missing consent", () => {
    const reasons = blockingPublishReasons({
      ...ready,
      toppers: [
        { id: "a", name: "Priya S", percentage: 98.6, consentAcknowledged: true },
        { id: "b", name: "Rahul K", percentage: 97.8, consentAcknowledged: false },
        { id: "c", name: "Meera N", percentage: 97.1, consentAcknowledged: false },
      ],
    });

    expect(reasons.join(" ")).toContain("Rahul K");
    expect(reasons.join(" ")).toContain("Meera N");
    expect(reasons.join(" ")).not.toContain("Priya S");
  });

  it("names a missing board name", () => {
    const reasons = blockingPublishReasons({ ...ready, board: "STATE_BOARD" });
    expect(reasons.join(" ")).toMatch(/board/i);
  });

  it("names more passes than appeared", () => {
    const reasons = blockingPublishReasons({ ...ready, appeared: 10, passed: 11 });
    expect(reasons.join(" ")).toMatch(/cannot exceed|more than/i);
  });

  it("names a topper nested inside a combination that still lacks consent", () => {
    const reasons = blockingPublishReasons({
      ...ready,
      combinations: [
        {
          toppers: [
            { id: "a", name: "Rahul K", percentage: 97.8, consentAcknowledged: false },
          ],
        },
      ],
    });

    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join(" ")).toContain("Rahul K");
  });

  it("names a topper nested inside a selection that still lacks consent", () => {
    const reasons = blockingPublishReasons({
      ...ready,
      selections: [
        {
          toppers: [
            { id: "b", name: "Meera N", percentage: 97.1, consentAcknowledged: false },
          ],
        },
      ],
    });

    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join(" ")).toContain("Meera N");
  });
});
