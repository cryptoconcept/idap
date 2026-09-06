import { describe, expect, it } from "vitest";
import {
  assertScholarshipPublishable,
  createScholarshipSchema,
  updateScholarshipSchema,
} from "@/lib/validation/scholarship";

describe("createScholarshipSchema", () => {
  it("accepts a minimal scholarship", () => {
    const parsed = createScholarshipSchema.parse({ name: "Merit Scholarship" });
    expect(parsed.name).toBe("Merit Scholarship");
  });

  it("rejects a blank name", () => {
    expect(() => createScholarshipSchema.parse({ name: "   " })).toThrow();
  });

  it("rejects a malformed academicUnitId", () => {
    expect(() =>
      createScholarshipSchema.parse({ name: "Merit", academicUnitId: "nope" }),
    ).toThrow();
  });

  it("strips status so a create cannot set it", () => {
    const parsed = createScholarshipSchema.parse({
      name: "Merit",
      status: "PUBLISHED",
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("status");
  });
});

describe("createScholarshipSchema — externalUrl/sourceUrl https-only", () => {
  // The Hub's shared `httpsUrlSchema` (scholarship-hub/packages/shared/src/
  // validation/scholarship.ts) rejects `http:` outright. An external-mode
  // listing with an `http:` externalUrl used to clear IDAP's local gate and
  // then 422 at push — these two fields must match the Hub's stricter rule.
  it("rejects an http externalUrl", () => {
    expect(() =>
      createScholarshipSchema.parse({
        name: "Merit",
        externalUrl: "http://example.com/apply",
      }),
    ).toThrow();
  });

  it("accepts an https externalUrl", () => {
    const parsed = createScholarshipSchema.parse({
      name: "Merit",
      externalUrl: "https://example.com/apply",
    });
    expect(parsed.externalUrl).toBe("https://example.com/apply");
  });

  it("rejects an http sourceUrl", () => {
    expect(() =>
      createScholarshipSchema.parse({
        name: "Merit",
        sourceUrl: "http://example.com/announcement",
      }),
    ).toThrow();
  });

  it("accepts an https sourceUrl", () => {
    const parsed = createScholarshipSchema.parse({
      name: "Merit",
      sourceUrl: "https://example.com/announcement",
    });
    expect(parsed.sourceUrl).toBe("https://example.com/announcement");
  });
});

describe("updateScholarshipSchema", () => {
  it("accepts a partial patch", () => {
    const parsed = updateScholarshipSchema.parse({ amount: "Up to ₹50,000" });
    expect(parsed.amount).toBe("Up to ₹50,000");
    expect(parsed.name).toBeUndefined();
  });

  it("strips status so a PATCH cannot skip the publish gate", () => {
    const parsed = updateScholarshipSchema.parse({
      name: "Merit",
      status: "PUBLISHED",
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("status");
  });
});

describe("assertScholarshipPublishable", () => {
  it("passes a scholarship with a name", () => {
    expect(() => assertScholarshipPublishable({ name: "Merit Scholarship" })).not.toThrow();
  });

  it("rejects a blank name", () => {
    expect(() => assertScholarshipPublishable({ name: "   " })).toThrow(
      /name: give this scholarship a name/,
    );
  });

  it("rejects a missing name", () => {
    expect(() => assertScholarshipPublishable({})).toThrow(/name: give this scholarship a name/);
  });
});
