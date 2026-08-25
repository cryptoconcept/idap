import { z } from "zod";
import { ACADEMIC_SEGMENTS } from "@/lib/constants";
import { requiredText } from "./common";

const REORDER_MAX_SIBLINGS = 100;

/** A 24-character hex id. Anything else is "no such unit", never a 500. */
const objectIdString = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");

export const createAcademicUnitSchema = z.object({
  segment: z.enum(ACADEMIC_SEGMENTS),
  /** Absent and explicit null both mean "a root". */
  parentId: objectIdString.nullish(),
  name: requiredText("Name", 120),
});
export type CreateAcademicUnitInput = z.infer<typeof createAcademicUnitSchema>;

/**
 * `segment` and `parentId` are absent on purpose, exactly as `status` is absent
 * from `updateFeeStructureSchema`: Zod strips an unknown key, so a patch can
 * never move a unit between parents or segments and leave its depth, its level
 * and every descendant's `pathLabel` stale. A misplaced unit is deleted and
 * recreated.
 */
export const updateAcademicUnitSchema = z.object({
  name: requiredText("Name", 120).optional(),
  active: z.boolean().optional(),
});
export type UpdateAcademicUnitInput = z.infer<typeof updateAcademicUnitSchema>;

export const reorderAcademicUnitsSchema = z.object({
  segment: z.enum(ACADEMIC_SEGMENTS),
  parentId: objectIdString.nullish(),
  orderedIds: z
    .array(objectIdString)
    .min(1, "Nothing to reorder")
    .max(REORDER_MAX_SIBLINGS, `Cannot reorder more than ${REORDER_MAX_SIBLINGS} at once`),
});
export type ReorderAcademicUnitsInput = z.infer<typeof reorderAcademicUnitsSchema>;

export const updateSegmentsSchema = z.object({
  segments: z
    .array(z.enum(ACADEMIC_SEGMENTS))
    .min(1, "Select at least one segment")
    .max(ACADEMIC_SEGMENTS.length)
    .refine((values) => new Set(values).size === values.length, {
      message: "Each segment can be selected only once",
    }),
});
export type UpdateSegmentsInput = z.infer<typeof updateSegmentsSchema>;
