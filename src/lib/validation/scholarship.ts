import { z } from "zod";
import { validationError } from "@/lib/api/errors";
import { objectIdString, requiredText } from "./common";
import {
  HUB_SCHOLARSHIP_CATEGORIES,
  HUB_EDUCATION_LEVELS,
  HUB_GENDERS,
  HUB_COMMUNITY_CATEGORIES,
  HUB_QUESTION_TYPES,
  HUB_APPLICATION_MODES,
  HUB_STATE_CODES,
} from "@/lib/scholarship-hub/vocabulary";

/**
 * Mirrors the Hub's shared `httpsUrlSchema`
 * (scholarship-hub/packages/shared/src/validation/scholarship.ts):
 * `z.url().max(2000)` plus a refine that the protocol is exactly `https:`.
 * Defined once and reused for both `externalUrl` and `sourceUrl` below — an
 * `http:` value on either field used to clear this local gate and then 422
 * at push, since a plain `z.string().url()` accepts any protocol.
 */
const httpsUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine(
    (value) => {
      // Zod's string checks don't short-circuit on an earlier failure — a
      // value that already failed `.url()` above still reaches this refine,
      // and `new URL()` throws a raw (non-Zod) `TypeError` on anything that
      // isn't a parseable URL. Caught here so a malformed value fails
      // validation gracefully instead of crashing the request.
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "must start with https://" },
  );

const benefitsSchema = z
  .object({
    amountMin: z.number().min(0).optional(),
    amountMax: z.number().min(0).optional(),
    stipendMonthly: z.number().min(0).optional(),
    awards: z.number().int().min(0).optional(),
    tuitionWaiver: z.boolean().optional(),
  })
  .optional();

const eligibilitySchema = z
  .object({
    stateCodes: z.array(z.enum(HUB_STATE_CODES)).optional(),
    districtCodes: z.array(z.string()).optional(),
    educationLevels: z.array(z.enum(HUB_EDUCATION_LEVELS)).optional(),
    classesOrCourses: z.array(z.string()).optional(),
    streams: z.array(z.string()).optional(),
    genders: z.array(z.enum(HUB_GENDERS)).optional(),
    ageMin: z.number().int().min(0).optional(),
    ageMax: z.number().int().min(0).optional(),
    minPercentage: z.number().min(0).max(100).optional(),
    maxAnnualIncome: z.number().min(0).optional(),
    communityCategories: z.array(z.enum(HUB_COMMUNITY_CATEGORIES)).optional(),
    disabilityRequired: z.boolean().optional(),
    otherCriteria: z.array(z.string()).optional(),
  })
  .optional();

const requiredDocumentSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean().optional(),
});

const customQuestionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(HUB_QUESTION_TYPES),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  helpText: z.string().optional(),
});

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
  // Structured fields for Scholarship Hub syndication (Task 3's model
  // fields). All optional: a draft scholarship needs only `name`, and
  // `scholarshipHubMissingFields`/`assertScholarshipHubPublishable` below are
  // the actual publish gate a syndicated listing must clear.
  summary: z.string().max(500).optional(),
  description: z.string().max(20000).optional(),
  categories: z.array(z.enum(HUB_SCHOLARSHIP_CATEGORIES)).optional(),
  tags: z.array(z.string()).max(20).optional(),
  benefits: benefitsSchema,
  eligibility: eligibilitySchema,
  applicationMode: z.enum(HUB_APPLICATION_MODES).optional(),
  externalUrl: httpsUrlSchema.optional(),
  requiredDocuments: z.array(requiredDocumentSchema).max(30).optional(),
  customQuestions: z.array(customQuestionSchema).max(50).optional(),
  applicationSteps: z.array(z.string()).max(20).optional(),
  dates: z
    .object({
      opensAt: z.string().optional(),
      closesAt: z.string().optional(),
      resultAt: z.string().optional(),
    })
    .optional(),
  selectionProcess: z.string().max(5000).optional(),
  terms: z.string().max(20000).optional(),
  faqs: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).max(30).optional(),
  sourceUrl: httpsUrlSchema.optional(),
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

// --- Scholarship Hub syndication gate ---------------------------------------
//
// Mirrors the Hub's `missingScholarshipFields`/`hasBenefit`
// (scholarship-hub/packages/shared/src/validation/scholarship.ts, spec §5.4)
// field-for-field so a listing IDAP considers publishable is one the Hub
// would also accept. The only deliberate divergence is naming — IDAP calls
// the title field `name`, not `title` — and that free-text `amount` (this
// platform's pre-existing field) satisfies the benefit check the same way the
// Hub's `benefits.amountText` does.
type GateInput = {
  name?: string | null;
  summary?: string | null;
  description?: string | null;
  categories?: string[];
  amount?: string | null;
  benefits?: {
    amountMin?: number;
    amountMax?: number;
    stipendMonthly?: number;
    awards?: number;
    tuitionWaiver?: boolean;
  };
  dates?: { closesAt?: string | Date | null };
  applicationMode?: "platform" | "external";
  externalUrl?: string | null;
  requiredDocuments?: { required?: boolean }[];
};

const blank = (s?: string | null) => !s || s.trim().length === 0;

/**
 * Whether the listing promises the student anything at all. A `tuitionWaiver`
 * of `false` does not count — that is the provider saying there is no
 * waiver — and neither does a zero amount. Free-text `amount` is the
 * fallback, mirroring the Hub's `benefits.amountText`.
 */
function hasBenefit(i: GateInput): boolean {
  const b = i.benefits;
  if (b) {
    for (const n of [b.amountMin, b.amountMax, b.stipendMonthly, b.awards]) {
      if (typeof n === "number" && n > 0) return true;
    }
    if (b.tuitionWaiver) return true;
  }
  return !blank(i.amount); // free-text amount → amountText
}

/**
 * THE definition of "this listing is ready to syndicate to Scholarship Hub".
 * Returns the list of missing fields rather than a boolean, same reason as
 * the Hub's version: the useful answer to "why can't I publish this" is
 * *which* fields are missing. `now` is a parameter, never `new Date()`
 * internally, so the deadline boundary is testable.
 */
export function scholarshipHubMissingFields(i: GateInput, now: Date = new Date()): string[] {
  const missing: string[] = [];
  if (blank(i.name)) missing.push("name");
  if (blank(i.summary)) missing.push("summary");
  if (!i.description || i.description.trim().length < 200) missing.push("description");
  if (!(i.categories?.length)) missing.push("categories");
  if (!hasBenefit(i)) missing.push("benefits");
  const c = i.dates?.closesAt ? new Date(i.dates.closesAt) : null;
  if (!c || Number.isNaN(c.getTime()) || c.getTime() <= now.getTime()) missing.push("closesAt");
  if ((i.applicationMode ?? "platform") === "external") {
    if (blank(i.externalUrl)) missing.push("externalUrl");
  } else if (!(i.requiredDocuments ?? []).some((d) => d.required !== false)) {
    missing.push("requiredDocuments");
  }
  return missing;
}

/** Throws with the missing-field list when a listing is not yet syndicatable. */
export function assertScholarshipHubPublishable(i: GateInput): void {
  const missing = scholarshipHubMissingFields(i);
  if (missing.length > 0) {
    throw validationError(`Not publishable to Scholarship Hub — missing: ${missing.join(", ")}`);
  }
}
