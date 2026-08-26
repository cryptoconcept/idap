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

  it("does not fire the date rule when only ONE bound is given", () => {
    expect(() =>
      assertOfferInvariants({ kind: "FLAT", value: 1, validUntil: new Date("2020-01-01") }),
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
