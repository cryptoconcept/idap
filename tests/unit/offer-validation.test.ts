import { describe, expect, it } from "vitest";
import {
  assertOfferInvariants,
  assertOfferPublishable,
  createOfferSchema,
  updateOfferSchema,
} from "@/lib/validation/offer";

describe("createOfferSchema", () => {
  it("accepts a minimal offer", () => {
    const parsed = createOfferSchema.parse({ title: "Early bird", kind: "PERCENTAGE", value: 15 });
    expect(parsed.value).toBe(15);
  });

  it("rejects a kind outside the enum", () => {
    expect(() => createOfferSchema.parse({ title: "X", kind: "BOGOF", value: 1 })).toThrow();
  });

  it("rejects a negative value", () => {
    expect(() =>
      createOfferSchema.parse({ title: "X", kind: "FLAT", value: -1 }),
    ).toThrow();
  });

  it("coerces ISO date strings into Dates", () => {
    const parsed = createOfferSchema.parse({
      title: "X",
      kind: "FLAT",
      value: 1,
      validUntil: "2026-03-31",
    });
    expect(parsed.validUntil).toBeInstanceOf(Date);
  });

  it("normalises a date-only validUntil to the LAST instant of that day, not the first", () => {
    // "Valid until 31 August" must include 31 August. A bare date-only
    // string used to coerce to 2026-08-31T00:00:00.000Z, which is the
    // FIRST instant of the day — the offer would already look expired for
    // the whole of the 31st.
    const parsed = createOfferSchema.parse({
      title: "X",
      kind: "FLAT",
      value: 1,
      validUntil: "2026-08-31",
    });
    expect(parsed.validUntil?.toISOString()).toBe("2026-08-31T23:59:59.999Z");
  });

  it("still parses a date-only validFrom to the START of that day — unchanged", () => {
    // An offer becomes valid at the start of its first day, so validFrom
    // gets no end-of-day adjustment — only validUntil does.
    const parsed = createOfferSchema.parse({
      title: "X",
      kind: "FLAT",
      value: 1,
      validFrom: "2026-08-31",
    });
    expect(parsed.validFrom?.toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("respects a validUntil that already carries a time component", () => {
    // Only the ambiguous date-only shorthand gets an opinion applied to it;
    // a full ISO timestamp is trusted as given.
    const parsed = createOfferSchema.parse({
      title: "X",
      kind: "FLAT",
      value: 1,
      validUntil: "2026-08-31T10:00:00.000Z",
    });
    expect(parsed.validUntil?.toISOString()).toBe("2026-08-31T10:00:00.000Z");
  });

  it("strips status so a create cannot set it", () => {
    const parsed = createOfferSchema.parse({
      title: "X",
      kind: "FLAT",
      value: 1,
      status: "PUBLISHED",
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("status");
  });
});

describe("updateOfferSchema", () => {
  it("strips status so a PATCH cannot skip the publish gate", () => {
    const parsed = updateOfferSchema.parse({ status: "PUBLISHED" }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("status");
  });
});

describe("assertOfferInvariants", () => {
  it("accepts a percentage of exactly 100", () => {
    expect(() => assertOfferInvariants({ kind: "PERCENTAGE", value: 100 })).not.toThrow();
  });

  it("rejects a percentage above 100", () => {
    expect(() => assertOfferInvariants({ kind: "PERCENTAGE", value: 101 })).toThrow(
      /cannot exceed 100/,
    );
  });

  it("allows a FLAT value above 100 — rupees, not percent", () => {
    expect(() => assertOfferInvariants({ kind: "FLAT", value: 25000 })).not.toThrow();
  });

  it("rejects an end date before the start date", () => {
    expect(() =>
      assertOfferInvariants({
        kind: "FLAT",
        value: 1,
        validFrom: new Date("2026-06-01"),
        validUntil: new Date("2026-05-01"),
      }),
    ).toThrow(/cannot fall before the start date/);
  });

  it("accepts an end date equal to the start date", () => {
    const day = new Date("2026-06-01");
    expect(() =>
      assertOfferInvariants({ kind: "FLAT", value: 1, validFrom: day, validUntil: day }),
    ).not.toThrow();
  });

  it("accepts a one-day offer parsed from the same date-only string on both bounds", () => {
    // The case most likely to break from the validUntil end-of-day change:
    // validFrom now lands at 00:00:00.000Z and validUntil at 23:59:59.999Z
    // of the SAME calendar day, so validUntil must still be >= validFrom
    // rather than tripping the date-order rule.
    const parsed = createOfferSchema.parse({
      title: "One-Day Offer",
      kind: "FLAT",
      value: 1,
      validFrom: "2026-08-31",
      validUntil: "2026-08-31",
    });
    expect(() =>
      assertOfferInvariants({
        kind: "FLAT",
        value: 1,
        validFrom: parsed.validFrom,
        validUntil: parsed.validUntil,
      }),
    ).not.toThrow();
  });

  it("does not fire the date rule when only ONE bound is given", () => {
    // Deliberately pre-epoch: with the correct `validFrom != null` guard this
    // does not throw, but a regression that defaults the missing bound
    // (`validFrom ?? new Date(0)`) WOULD throw, because 1960 precedes the
    // epoch. A post-epoch date such as 2020-01-01 passes under both the
    // correct guard and that regression, so it cannot defend this rule.
    expect(() =>
      assertOfferInvariants({ kind: "FLAT", value: 1, validUntil: new Date("1960-01-01") }),
    ).not.toThrow();
    expect(() =>
      assertOfferInvariants({ kind: "FLAT", value: 1, validFrom: new Date("2030-01-01") }),
    ).not.toThrow();
  });
});

describe("assertOfferPublishable", () => {
  it("passes a complete offer", () => {
    expect(() =>
      assertOfferPublishable({ title: "Early bird", kind: "PERCENTAGE", value: 15 }),
    ).not.toThrow();
  });

  it("rejects a blank title", () => {
    expect(() => assertOfferPublishable({ title: "  ", kind: "FLAT", value: 1 })).toThrow(
      /title: give this offer a title/,
    );
  });

  it("rejects a zero value — a 0% discount is meaningless", () => {
    expect(() => assertOfferPublishable({ title: "X", kind: "PERCENTAGE", value: 0 })).toThrow(
      /value: set a discount greater than zero/,
    );
  });

  it("still enforces the base invariants", () => {
    expect(() =>
      assertOfferPublishable({ title: "X", kind: "PERCENTAGE", value: 150 }),
    ).toThrow(/cannot exceed 100/);
  });
});
