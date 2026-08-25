import { z } from "zod";
import { FEE_FREQUENCIES, FEE_HEAD_MAX } from "@/lib/constants";
import { validationError } from "@/lib/api/errors";
import { objectIdString, requiredText } from "./common";

const FEE_STRUCTURE_MAX_LINE_ITEMS = 20;

const feeLineItemSchema = z.object({
  label: requiredText("Line item label", 60),
  amount: z.number().min(0, "Must be 0 or more"),
  frequency: z.enum(FEE_FREQUENCIES),
  optional: z.boolean().optional(),
});

const identityFields = {
  academicUnitId: objectIdString,
  academicYear: requiredText("Academic year", 20),
};

export const createFeeStructureSchema = z.object({
  ...identityFields,
  lineItems: z.array(feeLineItemSchema).max(FEE_STRUCTURE_MAX_LINE_ITEMS).optional(),
});
export type CreateFeeStructureInput = z.infer<typeof createFeeStructureSchema>;

/**
 * `status` is absent so a PATCH can never smuggle a structure into PUBLISHED and
 * skip the publish gate. `academicUnitId` is absent for the same mechanism and a
 * different reason: moving a fee structure to another unit would carry its unique
 * key with it. Both are stripped by Zod, the codebase's established way of making
 * a field immutable.
 */
export const updateFeeStructureSchema = z.object({
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

const BULK_MAX_IDS = 100;

/**
 * Duplicates are rejected rather than silently de-duplicated: a caller sending the
 * same id twice has a bug, and swallowing it hides the bug rather than the request.
 */
const distinctObjectIds = (label: string) =>
  z
    .array(objectIdString)
    .min(1, `Select at least one ${label}`)
    .max(BULK_MAX_IDS, `Cannot process more than ${BULK_MAX_IDS} at once`)
    .refine((values) => new Set(values).size === values.length, {
      message: `Each ${label} can appear only once`,
    });

const feeHeadSchema = z.object({
  label: requiredText("Fee head label", 60),
  amount: z.number().min(0, "Must be 0 or more").optional(),
  frequency: z.enum(FEE_FREQUENCIES).optional(),
});

export const feeHeadsSchema = z.object({
  feeHeads: z
    .array(feeHeadSchema)
    .max(FEE_HEAD_MAX, `At most ${FEE_HEAD_MAX} fee heads`)
    // Same rule and the same reason as line items: a picker with two "Tuition"
    // entries is a picker with a bug.
    .refine(
      (heads) => new Set(heads.map((head) => head.label)).size === heads.length,
      { message: "Each fee head needs a distinct label" },
    ),
});
export type FeeHeadsInput = z.infer<typeof feeHeadsSchema>;

export const bulkCreateFeeSchema = z.object({
  academicUnitIds: distinctObjectIds("class or course"),
  academicYear: requiredText("Academic year", 20),
  lineItems: z.array(feeLineItemSchema).max(FEE_STRUCTURE_MAX_LINE_ITEMS).optional(),
});
export type BulkCreateFeeInput = z.infer<typeof bulkCreateFeeSchema>;

export const bulkDeleteFeeSchema = z.object({
  feeStructureIds: distinctObjectIds("fee structure"),
});
export type BulkDeleteFeeInput = z.infer<typeof bulkDeleteFeeSchema>;
