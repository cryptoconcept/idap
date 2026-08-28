import { z } from "zod";
import {
  VACANCY_BENEFITS,
  VACANCY_DESCRIPTION_MAX,
  VACANCY_STATUSES,
  VACANCY_SUBJECTS,
  VACANCY_TITLE_MAX,
} from "@/lib/constants";
import { requiredText } from "./common";

/** Monthly rupees. `.nullable()` only on the patch — at create there is no
 *  prior value to clear. */
const salary = z.number().int().min(0).max(10_000_000);

const vacancyFields = {
  title: requiredText("Title", VACANCY_TITLE_MAX),
  subject: z.enum(VACANCY_SUBJECTS),
  description: requiredText("Description", VACANCY_DESCRIPTION_MAX),
  salaryMin: salary.optional(),
  salaryMax: salary.optional(),
  experienceRequired: z.number().int().min(0).max(60).optional(),
  facilities: z.array(z.enum(VACANCY_BENEFITS)).max(VACANCY_BENEFITS.length).optional(),
};

/** salaryMin ≤ salaryMax when both are present — eduFleet enforces the same
 *  rule server-side (`assertValidNumbers`), so rejecting it here turns a remote
 *  400 into a form error the school can act on. */
const salaryOrder = (v: { salaryMin?: number | null; salaryMax?: number | null }) =>
  v.salaryMin == null || v.salaryMax == null || v.salaryMin <= v.salaryMax;
const salaryOrderMessage = { message: "salary: the minimum may not exceed the maximum", path: ["salaryMin"] };

export const vacancyCreateSchema = z.object(vacancyFields).refine(salaryOrder, salaryOrderMessage);

export const vacancyPatchSchema = z
  .object({
    title: requiredText("Title", VACANCY_TITLE_MAX).optional(),
    subject: z.enum(VACANCY_SUBJECTS).optional(),
    description: requiredText("Description", VACANCY_DESCRIPTION_MAX).optional(),
    salaryMin: salary.optional().nullable(),
    salaryMax: salary.optional().nullable(),
    experienceRequired: z.number().int().min(0).max(60).optional().nullable(),
    facilities: z.array(z.enum(VACANCY_BENEFITS)).max(VACANCY_BENEFITS.length).optional(),
    status: z.enum(VACANCY_STATUSES).optional(),
  })
  .refine(salaryOrder, salaryOrderMessage);

export type VacancyCreateInput = z.infer<typeof vacancyCreateSchema>;
export type VacancyPatchInput = z.infer<typeof vacancyPatchSchema>;
