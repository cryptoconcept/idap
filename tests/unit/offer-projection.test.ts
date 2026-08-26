import { describe, expect, it } from "vitest";
import { toPublicOffer } from "@/lib/offer/public-projection";

const published = {
  _id: "aaa",
  institutionId: "INS0001",
  academicUnitId: "bbb",
  title: "Early bird",
  description: "Book before March",
  kind: "PERCENTAGE",
  value: 15,
  code: "EARLY15",
  classOrCourse: "Grade 10",
  validFrom: new Date("2026-01-01T00:00:00.000Z"),
  validUntil: new Date("2026-03-31T00:00:00.000Z"),
  status: "PUBLISHED",
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  createdAt: new Date("2025-12-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

describe("toPublicOffer", () => {
  it("emits exactly the allowed top-level keys and no others", () => {
    const result = toPublicOffer(published);

    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        "classOrCourse",
        "code",
        "description",
        "kind",
        "publishedAt",
        "title",
        "validFrom",
        "validUntil",
        "value",
      ].sort(),
    );
  });

  it("never emits internal fields", () => {
    const result = toPublicOffer(published) as Record<string, unknown>;

    expect(result).not.toHaveProperty("_id");
    expect(result).not.toHaveProperty("institutionId");
    expect(result).not.toHaveProperty("academicUnitId");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("returns null for a draft offer", () => {
    expect(toPublicOffer({ ...published, status: "DRAFT" })).toBeNull();
  });

  it("returns null for an archived offer", () => {
    expect(toPublicOffer({ ...published, status: "ARCHIVED" })).toBeNull();
  });

  it("emits value as a number and dates as ISO strings", () => {
    const result = toPublicOffer(published);

    expect(result?.value).toBe(15);
    expect(result?.validUntil).toBe("2026-03-31T00:00:00.000Z");
  });

  it("does NOT re-check expiry — the query is the single enforcement point", () => {
    const expired = { ...published, validUntil: new Date("2020-01-01T00:00:00.000Z") };

    expect(toPublicOffer(expired)).not.toBeNull();
  });

  it("does not leak a field added to the document but not to the allow-list", () => {
    const result = toPublicOffer({
      ...published,
      internalMargin: 0.4,
    }) as Record<string, unknown>;

    expect(result).not.toHaveProperty("internalMargin");
  });
});
