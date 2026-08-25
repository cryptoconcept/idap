import { describe, expect, it } from "vitest";
import {
  assertFeeStructureInvariants,
  assertFeeStructurePublishable,
  bulkCreateFeeSchema,
  bulkDeleteFeeSchema,
  createFeeStructureSchema,
  feeHeadsSchema,
  updateFeeStructureSchema,
} from "@/lib/validation/fee-structure";

const OID = "6a887abd755db527bea51204";

describe("createFeeStructureSchema", () => {
  it("accepts a structure with no line items", () => {
    const result = createFeeStructureSchema.safeParse({
      academicUnitId: OID,
      academicYear: "2026-27",
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 20 line items", () => {
    const lineItems = Array.from({ length: 21 }, (_, i) => ({
      label: `Item ${i}`,
      amount: 100,
      frequency: "ANNUAL" as const,
    }));

    const result = createFeeStructureSchema.safeParse({
      academicUnitId: OID,
      academicYear: "2026-27",
      lineItems,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative amount", () => {
    const result = createFeeStructureSchema.safeParse({
      academicUnitId: OID,
      academicYear: "2026-27",
      lineItems: [{ label: "Tuition", amount: -1, frequency: "ANNUAL" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("assertFeeStructureInvariants", () => {
  it("passes with distinct labels", () => {
    expect(() =>
      assertFeeStructureInvariants({
        lineItems: [
          { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
          { label: "Admission Fee", amount: 5000, frequency: "ONE_TIME" },
        ],
      }),
    ).not.toThrow();
  });

  it("throws on a duplicate label", () => {
    expect(() =>
      assertFeeStructureInvariants({
        lineItems: [
          { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
          { label: "Tuition", amount: 5000, frequency: "ONE_TIME" },
        ],
      }),
    ).toThrow(/appears more than once/i);
  });
});

describe("assertFeeStructurePublishable", () => {
  it("throws with zero line items", () => {
    expect(() => assertFeeStructurePublishable({ lineItems: [] })).toThrow(
      /at least one line item/i,
    );
  });

  it("passes with at least one line item and no duplicate labels", () => {
    expect(() =>
      assertFeeStructurePublishable({
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      }),
    ).not.toThrow();
  });
});

describe("updateFeeStructureSchema", () => {
  it("strips academicUnitId from a patch instead of applying it", () => {
    // Same mechanism as `status`: moving a fee structure to another unit would
    // take its unique key with it, so the field is simply absent from the schema.
    const parsed = updateFeeStructureSchema.parse({
      academicYear: "2027-28",
      academicUnitId: OID,
      status: "PUBLISHED",
    }) as Record<string, unknown>;

    expect(parsed.academicYear).toBe("2027-28");
    expect(parsed.academicUnitId).toBeUndefined();
    expect(parsed.status).toBeUndefined();
  });
});

describe("fee heads validation", () => {
  it("accepts a label-only head and one with defaults", () => {
    expect(
      feeHeadsSchema.safeParse({
        feeHeads: [{ label: "Transport" }, { label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate labels", () => {
    expect(
      feeHeadsSchema.safeParse({ feeHeads: [{ label: "Tuition" }, { label: "Tuition" }] }).success,
    ).toBe(false);
  });

  it("rejects more than the maximum", () => {
    const heads = Array.from({ length: 31 }, (_, index) => ({ label: `Head ${index}` }));
    expect(feeHeadsSchema.safeParse({ feeHeads: heads }).success).toBe(false);
    expect(feeHeadsSchema.safeParse({ feeHeads: heads.slice(0, 30) }).success).toBe(true);
  });
});

describe("bulk fee validation", () => {
  it("requires at least one id and rejects duplicates", () => {
    expect(bulkCreateFeeSchema.safeParse({ academicUnitIds: [], academicYear: "2026-27" }).success)
      .toBe(false);
    expect(
      bulkCreateFeeSchema.safeParse({
        academicUnitIds: [OID, OID],
        academicYear: "2026-27",
      }).success,
    ).toBe(false);
  });

  it("caps the batch at 100 and accepts exactly 100", () => {
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        index.toString(16).padStart(24, "0"),
      );
    expect(
      bulkCreateFeeSchema.safeParse({ academicUnitIds: ids(101), academicYear: "2026-27" }).success,
    ).toBe(false);
    expect(
      bulkCreateFeeSchema.safeParse({ academicUnitIds: ids(100), academicYear: "2026-27" }).success,
    ).toBe(true);
  });

  it("applies the same id rules to bulk delete", () => {
    expect(bulkDeleteFeeSchema.safeParse({ feeStructureIds: [] }).success).toBe(false);
    expect(bulkDeleteFeeSchema.safeParse({ feeStructureIds: [OID, OID] }).success).toBe(false);
    expect(bulkDeleteFeeSchema.safeParse({ feeStructureIds: [OID] }).success).toBe(true);
  });
});
