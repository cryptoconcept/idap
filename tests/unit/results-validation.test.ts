import { describe, expect, it } from "vitest";
import {
  assertPublishable,
  assertResultInvariants,
  createResultSchema,
  updateResultSchema,
} from "@/lib/validation/result";

const base = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  academicYear: "2025-26",
  appeared: 100,
  passed: 100,
};

describe("result invariants", () => {
  it("accepts a coherent record", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        bands: [
          { label: "90%+", minPercentage: 90, maxPercentage: 100, count: 30 },
          { label: "75-90%", minPercentage: 75, maxPercentage: 89, count: 40 },
        ],
      }),
    ).not.toThrow();
  });

  it("refuses more passes than appeared", () => {
    expect(() => assertResultInvariants({ ...base, appeared: 10, passed: 11 })).toThrow(
      /cannot exceed/i,
    );
  });

  it("refuses overlapping bands", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        bands: [
          { label: "A", minPercentage: 80, maxPercentage: 100, count: 1 },
          { label: "B", minPercentage: 75, maxPercentage: 85, count: 1 },
        ],
      }),
    ).toThrow(/overlap/i);
  });

  it("refuses a band whose minimum exceeds its maximum", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        bands: [{ label: "A", minPercentage: 90, maxPercentage: 80, count: 1 }],
      }),
    ).toThrow(/lower than/i);
  });

  it("refuses band counts adding up to more than appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        appeared: 10,
        passed: 10,
        bands: [
          { label: "A", minPercentage: 90, maxPercentage: 100, count: 6 },
          { label: "B", minPercentage: 75, maxPercentage: 89, count: 6 },
        ],
      }),
    ).toThrow(/more students than appeared/i);
  });

  it("requires boardName when the board does not name itself", () => {
    expect(() => assertResultInvariants({ ...base, board: "STATE_BOARD" })).toThrow(/boardName/);
    expect(() =>
      assertResultInvariants({ ...base, board: "STATE_BOARD", boardName: "Karnataka State Board" }),
    ).not.toThrow();
  });

  it("does not require boardName for a board that names itself", () => {
    expect(() => assertResultInvariants({ ...base, board: "CBSE" })).not.toThrow();
  });
});

describe("publish gate", () => {
  it("refuses to publish a cycle with nobody appearing", () => {
    expect(() => assertPublishable({ ...base, appeared: 0, passed: 0 })).toThrow(/appeared/i);
  });

  it("refuses to publish while any topper lacks acknowledged consent", () => {
    expect(() =>
      assertPublishable({
        ...base,
        toppers: [
          { name: "Priya S", percentage: 98.6, consentAcknowledged: true },
          { name: "Rahul K", percentage: 97.8, consentAcknowledged: false },
        ],
      }),
    ).toThrow(/Rahul K/);
  });

  it("publishes when every topper has acknowledged consent", () => {
    expect(() =>
      assertPublishable({
        ...base,
        toppers: [{ name: "Priya S", percentage: 98.6, consentAcknowledged: true }],
      }),
    ).not.toThrow();
  });

  it("still applies the ordinary invariants at publish time", () => {
    expect(() => assertPublishable({ ...base, appeared: 10, passed: 11 })).toThrow(/cannot exceed/i);
  });
});

describe("result schemas", () => {
  it("accepts a minimal create body", () => {
    const parsed = createResultSchema.parse({
      board: "CBSE",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 100,
      passed: 98,
    });
    expect(parsed.stream).toBeNull();
  });

  it("normalises a missing stream to null so the unique index sees one value", () => {
    expect(createResultSchema.parse({ ...base }).stream).toBeNull();
  });

  it("refuses a photoUrl on create — photos are set only by the upload endpoint", () => {
    const parsed = createResultSchema.parse({
      ...base,
      toppers: [{ name: "Priya S", percentage: 98.6, photoUrl: "https://evil.example/x.png" }],
    });
    expect(parsed.toppers?.[0]).not.toHaveProperty("photoUrl");
  });

  it("refuses a photoUrl on patch", () => {
    const parsed = updateResultSchema.parse({
      toppers: [{ name: "Priya S", percentage: 98.6, photoUrl: "https://evil.example/x.png" }],
    });
    expect(parsed.toppers?.[0]).not.toHaveProperty("photoUrl");
  });

  it("refuses a status on patch — status moves only through the publish route", () => {
    const parsed = updateResultSchema.parse({ status: "PUBLISHED" });
    expect(parsed).not.toHaveProperty("status");
  });

  it("rejects a percentage outside 0-100", () => {
    expect(() => createResultSchema.parse({ ...base, averageScore: 101 })).toThrow();
  });

  it("caps the number of toppers", () => {
    const toppers = Array.from({ length: 26 }, (_, i) => ({ name: `S${i}`, percentage: 90 }));
    expect(() => createResultSchema.parse({ ...base, toppers })).toThrow();
  });
});
