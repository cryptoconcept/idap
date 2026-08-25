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
  it("rejects a malformed value instead of throwing — the schema is exported", () => {
    // Not reachable through the UI (useFieldArray guarantees an array), but this
    // schema is exported, and one that throws rather than failing validation is
    // a trap for its next caller.
    for (const bad of [null, undefined, "feeHeads", 42, {}, { feeHeads: "Tuition" }]) {
      const result = feeHeadsFormSchema.safeParse(bad);
      expect(result.success).toBe(false);
    }
  });

  it("normalises a null amount, which a stored document can carry", () => {
    expect(toFormValues([{ label: "Tuition", amount: null }]).feeHeads[0].amount).toBeUndefined();
  });

  it("hands the caller a payload that needs no further normalising", () => {
    // The seam the component depends on: react-hook-form gives `handleSubmit`
    // the resolver's PARSED output, so the submit path sends it straight on. If
    // that stopped being fully normalised, the wire payload would carry a
    // sentinel or a NaN and the API would reject it.
    const parsed = feeHeadsFormSchema.safeParse({
      feeHeads: [
        { label: "  Tuition  ", amount: NaN, frequency: NO_FREQUENCY },
        { label: "Registration", amount: 500, frequency: "ONE_TIME" },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.feeHeads[0]).toEqual({ label: "Tuition" });
    expect(parsed.data.feeHeads[1]).toEqual({
      label: "Registration",
      amount: 500,
      frequency: "ONE_TIME",
    });
    // Re-normalising must be a no-op, since the component no longer does it.
    expect(toApiPayload(parsed.data as never)).toEqual(parsed.data);
  });
});
