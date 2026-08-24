import { z } from "zod";
import { FEE_FREQUENCIES } from "@/lib/constants";
import { validationError } from "@/lib/api/errors";
import { requiredText } from "./common";

const FEE_STRUCTURE_MAX_LINE_ITEMS = 20;

const feeLineItemSchema = z.object({
  label: requiredText("Line item label", 60),
  amount: z.number().min(0, "Must be 0 or more"),
  frequency: z.enum(FEE_FREQUENCIES),
  optional: z.boolean().optional(),
});

const identityFields = {
  classOrCourse: requiredText("Class or course", 120),
  academicYear: requiredText("Academic year", 20),
};

export const createFeeStructureSchema = z.object({
  ...identityFields,
  lineItems: z.array(feeLineItemSchema).max(FEE_STRUCTURE_MAX_LINE_ITEMS).optional(),
});
export type CreateFeeStructureInput = z.infer<typeof createFeeStructureSchema>;

/**
 * `status` is absent on purpose: a fee structure changes state only through
 * the publish route, so a PATCH can never smuggle a structure into PUBLISHED
 * and skip the "at least one line item" gate.
 */
export const updateFeeStructureSchema = z.object({
  classOrCourse: identityFields.classOrCourse.optional(),
  academicYear: identityFields.academicYear.optional(),
  lineItems: z.array(feeLineItemSchema).max(FEE_STRUCTURE_MAX_LINE_ITEMS).optional(),
});
export type UpdateFeeStructureInput = z.infer<typeof updateFeeStructureSchema>;

export const feeStructureQuerySchema = z.object({
  academicYear: z.string().trim().max(20).optional(),
});

export type FeeStructureInvariantInput = {
  lineItems?: { label: string; amount: number; frequency: string; optional?: boolean }[] | null;
};

/**
 * Cross-field rules, checked against the MERGED record rather than the
 * request body — a PATCH carrying only one new line item still has to be
 * checked against the whole stored list once merged.
 */
export function assertFeeStructureInvariants(input: FeeStructureInvariantInput): void {
  const items = input.lineItems ?? [];
  const labels = new Set<string>();

  for (const item of items) {
    if (labels.has(item.label)) {
      throw validationError(
        `lineItems: "${item.label}" appears more than once — each line item needs a distinct label`,
      );
    }
    labels.add(item.label);
  }
}

/**
 * The publish gate. Stricter than `assertFeeStructureInvariants`, which a
 * draft may still satisfy while incomplete.
 */
export function assertFeeStructurePublishable(input: FeeStructureInvariantInput): void {
  assertFeeStructureInvariants(input);

  if ((input.lineItems ?? []).length === 0) {
    throw validationError("lineItems: add at least one line item before publishing");
  }
}
