import { z } from "zod";
import { validationError } from "@/lib/api/errors";
import { objectIdString, requiredText } from "./common";

export const createScholarshipSchema = z.object({
  name: requiredText("Scholarship name", 120),
  criteria: z.string().trim().max(600).optional(),
  amount: z.string().trim().max(80).optional(),
  /**
   * Nullable as well as optional. At create there is no prior value to
   * distinguish "clear" from "unset", so `null` and an absent key behave
   * identically here — both mean institution-wide. It is defined this way
   * anyway, rather than plain `.optional()`, so `updateScholarshipSchema`
   * (below) can share this exact field definition instead of needing its
   * own: one rule for what a caller may send is easier to reason about than
   * two different ones for create vs. update.
   */
  academicUnitId: objectIdString.nullable().optional(),
});
export type CreateScholarshipInput = z.infer<typeof createScholarshipSchema>;

/**
 * `status` is absent so a PATCH cannot skip the publish gate — Zod strips it,
 * the same mechanism `updateFeeStructureSchema` uses.
 *
 * `academicUnitId` inherits `createScholarshipSchema`'s nullable-and-optional
 * shape via `.partial()`, and here the distinction actually matters: an
 * *omitted* key means "leave it alone" (the service's `stripUndefined`
 * absorbs it, so a PATCH touching only `amount` cannot accidentally erase an
 * existing scope), while an explicit `null` is the only payload that means
 * "clear the scope and make this scholarship institution-wide". Without a
 * nullable field there would be no way to ever un-scope a scholarship once
 * given one — `undefined` cannot serve double duty as both "leave alone" and
 * "clear", since a browser's `JSON.stringify` drops `undefined` keys
 * entirely, making the two indistinguishable on the wire.
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
