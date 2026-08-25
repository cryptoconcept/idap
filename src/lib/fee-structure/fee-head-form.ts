/**
 * The translation layer between the fee-heads FORM and the fee-heads API.
 *
 * It exists because the form legitimately holds two values the API schema
 * rightly rejects, both meaning "not set":
 *
 * - `NO_FREQUENCY`, because a Radix Select is a button with no native "unset",
 *   so "no default frequency" needs a real option with a real value;
 * - `NaN`, because react-hook-form's `valueAsNumber` produces it from an empty
 *   number input.
 *
 * Normalising both BEFORE `feeHeadsSchema` runs is what lets a head be saved
 * with no amount and no default frequency — the two cases those fields are
 * optional for in the first place. Validating raw form state instead makes the
 * form refuse to submit with no visible error, which is how this was first
 * written and why the logic now lives here, tested, rather than inline in a
 * component this repo has no way to test.
 */
import { z } from "zod";
import { feeHeadsSchema, type FeeHeadsInput } from "@/lib/validation/fee-structure";
import type { FeeFrequency } from "@/lib/constants";

/** Sentinel for "no default frequency". Never leaves the form. */
export const NO_FREQUENCY = "NONE" as const;

/**
 * Derived from `FeeFrequency` rather than spelled out, so adding a frequency to
 * `FEE_FREQUENCIES` cannot leave this union silently behind.
 */
export type FrequencyChoice = FeeFrequency | typeof NO_FREQUENCY;

export type FeeHeadFormValue = {
  label: string;
  amount?: number;
  frequency: FrequencyChoice;
};

export type FeeHeadsFormValues = { feeHeads: FeeHeadFormValue[] };

/** A head the API returned, as the form wants to hold it. */
export function toFormValues(
  feeHeads: { label: string; amount?: number; frequency?: string }[],
): FeeHeadsFormValues {
  return {
    feeHeads: feeHeads.map((head) => ({
      label: head.label,
      amount: head.amount,
      frequency: (head.frequency ?? NO_FREQUENCY) as FrequencyChoice,
    })),
  };
}

/** Form state as the API wants to receive it. */
export function toApiPayload(values: FeeHeadsFormValues): FeeHeadsInput {
  return {
    feeHeads: values.feeHeads.map((head) => ({
      label: head.label,
      amount: typeof head.amount === "number" && Number.isFinite(head.amount)
        ? head.amount
        : undefined,
      frequency: head.frequency === NO_FREQUENCY ? undefined : (head.frequency as FeeFrequency),
    })),
  };
}

/**
 * What the form's resolver validates.
 *
 * Wraps the real schema rather than restating it, so the head cap and the
 * distinct-label rule stay defined in exactly one place — `feeHeadsSchema`.
 */
export const feeHeadsFormSchema = z
  // `z.custom` rather than `z.preprocess`: preprocess types its input as
  // `unknown`, and `zodResolver` requires an input assignable to `FieldValues`.
  // Declaring the input type here keeps the resolver's field paths checked
  // instead of pushing the problem into a wider cast at the call site.
  .custom<FeeHeadsFormValues>()
  .transform(toApiPayload)
  .pipe(feeHeadsSchema);
