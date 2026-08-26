import { z } from "zod";
import { validationError } from "@/lib/api/errors";
import { objectIdString, requiredText } from "./common";

export const createScholarshipSchema = z.object({
  name: requiredText("Scholarship name", 120),
  criteria: z.string().trim().max(600).optional(),
  amount: z.string().trim().max(80).optional(),
  academicUnitId: objectIdString.optional(),
});
export type CreateScholarshipInput = z.infer<typeof createScholarshipSchema>;

/**
 * `status` is absent, so a PATCH can never smuggle a scholarship into
 * PUBLISHED and skip the gate below — Zod strips it, the same mechanism
 * `updateFeeStructureSchema` uses. Unlike a fee structure, `academicUnitId`
 * IS patchable here: it carries no unique key, so moving a scholarship
 * between units breaks nothing.
 */
export const updateScholarshipSchema = createScholarshipSchema.partial();
export type UpdateScholarshipInput = z.infer<typeof updateScholarshipSchema>;

/**
 * The publish gate. Stricter than create, which a draft may satisfy while
 * incomplete: `name` is required at create, but a PATCH could blank it.
 */
export function assertScholarshipPublishable(input: { name?: string | null }): void {
  if (!input.name?.trim()) {
    throw validationError("name: give this scholarship a name before publishing it");
  }
}
