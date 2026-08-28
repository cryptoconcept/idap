import { z } from "zod";
import {
  VACANCY_BENEFITS,
  VACANCY_DESCRIPTION_MAX,
  VACANCY_STATUSES,
  VACANCY_SUBJECTS,
  VACANCY_TITLE_MAX,
} from "@/lib/constants";
import { requiredText } from "./common";

/**
 * Monthly rupees. `.nullable()` only on the patch — at create there is no
 * prior value to clear.
 *
 * Deliberately plain `z.number()`, never `z.coerce.number()` — unlike this
 * repo's `src/lib/validation/application.ts` (`previousPercentage`) or
 * `src/lib/validation/offer.ts` (its date fields), which do coerce. Do not
 * add coercion here "for consistency" with those: `z.coerce.number().parse("")`
 * is `0`, so coercing would turn an emptied salary field into a silently
 * stored zero instead of the loud 400 a bare `""` gets today. The messages
 * below are custom (not Zod's defaults) so a school administrator sees copy
 * written for them, not an internal type description.
 */
const salary = z
  .number()
  .int("Salary must be a whole number, without decimals.")
  .min(0, "Salary cannot be negative.")
  .max(10_000_000, "Salary cannot exceed ₹1,00,00,000 a month.");

const experience = z
  .number()
  .int("Experience must be a whole number of years.")
  .min(0, "Experience cannot be negative.")
  .max(60, "Experience cannot exceed 60 years.");

/**
 * One line item, drawn from the fixed `VACANCY_BENEFITS` vocabulary.
 * Duplicate-checked the same way as `academic-structure.ts`'s
 * `updateSegmentsSchema` and `fee-structure.ts`'s `distinctObjectIds`: an API
 * client (or a future import/replay path) could PATCH
 * `["Gratuity","Gratuity"]` past the enum check alone, and
 * `vacancies-section.tsx`'s `VacancyCard` renders one `<Badge key={benefit}>`
 * per entry, so a duplicate produces two React elements sharing one key.
 */
const facilities = z
  .array(z.enum(VACANCY_BENEFITS))
  .max(VACANCY_BENEFITS.length)
  .refine((values) => new Set(values).size === values.length, {
    message: "Each facility can appear only once",
  });

const vacancyFields = {
  title: requiredText("Title", VACANCY_TITLE_MAX),
  subject: z.enum(VACANCY_SUBJECTS),
  description: requiredText("Description", VACANCY_DESCRIPTION_MAX),
  salaryMin: salary.optional(),
  salaryMax: salary.optional(),
  experienceRequired: experience.optional(),
  facilities: facilities.optional(),
};

/** salaryMin ≤ salaryMax when both are present — eduFleet enforces the same
 *  rule server-side (`assertValidNumbers`), so rejecting it here turns a remote
 *  400 into a form error the school can act on. */
const salaryOrder = (v: { salaryMin?: number | null; salaryMax?: number | null }) =>
  v.salaryMin == null || v.salaryMax == null || v.salaryMin <= v.salaryMax;
const salaryOrderMessage = { message: "salary: the minimum may not exceed the maximum", path: ["salaryMin"] };

// `.strict()`, not the default strip mode: `listing` (the eduFleet sync
// state written only by the push service — see `src/models/Vacancy.ts`) must
// never be settable by a client, and a schema that silently stripped it would
// give a caller no signal that their `listing` was ignored rather than
// stored. `.strict()` must sit before `.refine()` — `.refine()` returns a
// `ZodEffects` that no longer exposes `.strict()`.
export const vacancyCreateSchema = z
  .object(vacancyFields)
  .strict()
  .refine(salaryOrder, salaryOrderMessage);

export const vacancyPatchSchema = z
  .object({
    title: requiredText("Title", VACANCY_TITLE_MAX).optional(),
    subject: z.enum(VACANCY_SUBJECTS).optional(),
    description: requiredText("Description", VACANCY_DESCRIPTION_MAX).optional(),
    salaryMin: salary.optional().nullable(),
    salaryMax: salary.optional().nullable(),
    experienceRequired: experience.optional().nullable(),
    facilities: facilities.optional(),
    status: z.enum(VACANCY_STATUSES).optional(),
  })
  .strict()
  .refine(salaryOrder, salaryOrderMessage);

export type VacancyCreateInput = z.infer<typeof vacancyCreateSchema>;
export type VacancyPatchInput = z.infer<typeof vacancyPatchSchema>;
