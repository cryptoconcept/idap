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
