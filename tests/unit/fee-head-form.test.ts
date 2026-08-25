import { describe, it, expect } from "vitest";
import {
  NO_FREQUENCY,
  feeHeadsFormSchema,
  toApiPayload,
  toFormValues,
} from "@/lib/fee-structure/fee-head-form";
import { FEE_HEAD_MAX } from "@/lib/constants";

describe("fee head form translation", () => {
  it("accepts a head with no default frequency — the case the sentinel exists for", () => {
    const result = feeHeadsFormSchema.safeParse({
      feeHeads: [{ label: "Tuition", amount: 5000, frequency: NO_FREQUENCY }],
    });
    expect(result.success).toBe(true);
    // The sentinel must not survive into the payload; it is not in the enum.
    expect(result.success && result.data.feeHeads[0].frequency).toBeUndefined();
  });

  it("accepts a head with a blank amount, which valueAsNumber reports as NaN", () => {
    const result = feeHeadsFormSchema.safeParse({
      feeHeads: [{ label: "Tuition", amount: NaN, frequency: "ANNUAL" }],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.feeHeads[0].amount).toBeUndefined();
  });

  it("passes a fully specified head through unchanged", () => {
    const result = feeHeadsFormSchema.safeParse({
      feeHeads: [{ label: "Tuition", amount: 5000, frequency: "ANNUAL" }],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.feeHeads[0]).toMatchObject({
      label: "Tuition",
      amount: 5000,
      frequency: "ANNUAL",
    });
  });

  it("still rejects duplicate labels — the wrapper must not weaken the real rule", () => {
    const result = feeHeadsFormSchema.safeParse({
      feeHeads: [
        { label: "Tuition", frequency: NO_FREQUENCY },
        { label: "Tuition", frequency: NO_FREQUENCY },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("still rejects a negative amount", () => {
    const result = feeHeadsFormSchema.safeParse({
      feeHeads: [{ label: "Tuition", amount: -1, frequency: NO_FREQUENCY }],
    });
    expect(result.success).toBe(false);
  });

  it(`still rejects more than ${FEE_HEAD_MAX} heads`, () => {
    const tooMany = Array.from({ length: FEE_HEAD_MAX + 1 }, (_, index) => ({
      label: `Head ${index}`,
      frequency: NO_FREQUENCY as typeof NO_FREQUENCY,
    }));
    expect(feeHeadsFormSchema.safeParse({ feeHeads: tooMany }).success).toBe(false);
    // Exactly at the cap is accepted, so an off-by-one would fail rather than pass.
    expect(
      feeHeadsFormSchema.safeParse({ feeHeads: tooMany.slice(0, FEE_HEAD_MAX) }).success,
    ).toBe(true);
  });

  it("round-trips an absent frequency through the form and back", () => {
    const fromApi = [{ label: "Tuition", amount: 5000 }];
    const inForm = toFormValues(fromApi);
    // Absent must become the sentinel, or the Select renders blank and unusable.
    expect(inForm.feeHeads[0].frequency).toBe(NO_FREQUENCY);
    expect(toApiPayload(inForm).feeHeads[0].frequency).toBeUndefined();
  });
});
