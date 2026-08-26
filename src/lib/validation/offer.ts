import { z } from "zod";
import { OFFER_KINDS } from "@/lib/constants";
import { validationError } from "@/lib/api/errors";
import { objectIdString, requiredText } from "./common";

/**
 * A `type="date"` input reports an untouched or cleared field as `""`, never
 * as an absent key — the DOM has no way to omit a registered form field's
 * value entirely. Bare `z.coerce.date().optional()` treats only `undefined`
 * as "no value supplied" and tries to coerce anything else, so a blank date
 * input becomes `new Date("")` (an Invalid Date) and fails validation on
 * every offer with no `validFrom`/`validUntil` — which, per the brief's own
 * verification step, must be a valid, publishable state ("No end date").
 * Folding the empty string to `undefined` before coercion runs is what makes
 * the plain `register()` + `type="date"` pattern actually work.
 */
const optionalDate = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.coerce.date().optional(),
);

export const createOfferSchema = z.object({
  title: requiredText("Offer title", 120),
  description: z.string().trim().max(600).optional(),
  kind: z.enum(OFFER_KINDS),
  value: z.number().min(0, "Must be 0 or more"),
  code: z.string().trim().max(40).optional(),
  /**
   * Nullable as well as optional. At create there is no prior value to
   * distinguish "clear" from "unset", so `null` and an absent key behave
   * identically here — both mean institution-wide. It is defined this way
   * anyway, rather than plain `.optional()`, so `updateOfferSchema` (below)
   * can share this exact field definition instead of needing its own: one
   * rule for what a caller may send is easier to reason about than two
   * different ones for create vs. update. See `updateOfferSchema` for why
   * the distinction matters there.
   */
  academicUnitId: objectIdString.nullable().optional(),
  validFrom: optionalDate,
  validUntil: optionalDate,
});
export type CreateOfferInput = z.infer<typeof createOfferSchema>;

/**
 * `status` is absent so a PATCH cannot skip the publish gate — Zod strips it,
 * the same mechanism `updateScholarshipSchema` uses.
 *
 * `academicUnitId` inherits `createOfferSchema`'s nullable-and-optional shape
 * via `.partial()`, and here the distinction actually matters: an *omitted*
 * key means "leave it alone" (the service's `stripUndefined` absorbs it, so
 * a PATCH touching only `value` cannot accidentally erase an existing
 * scope), while an explicit `null` is the only payload that means "clear the
 * scope and make this offer institution-wide". Without a nullable field
 * there would be no way to ever un-scope an offer once given one —
 * `undefined` cannot serve double duty as both "leave alone" and "clear",
 * since a browser's `JSON.stringify` drops `undefined` keys entirely, making
 * the two indistinguishable on the wire.
 */
export const updateOfferSchema = createOfferSchema.partial();
export type UpdateOfferInput = z.infer<typeof updateOfferSchema>;

export type OfferInvariantInput = {
  kind: string;
  value: number;
  validFrom?: Date | null;
  validUntil?: Date | null;
};

/**
 * Cross-field rules, checked against the MERGED record rather than the request
 * body — a PATCH carrying only `validUntil` has no `validFrom` of its own to
 * compare against, so the service merges first and calls this second.
 */
export function assertOfferInvariants(input: OfferInvariantInput): void {
  if (input.kind === "PERCENTAGE" && input.value > 100) {
    throw validationError("value: a percentage discount cannot exceed 100");
  }

  // Guarded on BOTH bounds being given: an absent bound means "unreported",
  // not "zero" or "epoch". A `?? new Date(0)` here would manufacture a false
  // violation on an offer with only an end date.
  if (input.validFrom != null && input.validUntil != null && input.validUntil < input.validFrom) {
    throw validationError("validUntil: the end date cannot fall before the start date");
  }
}

/**
 * The publish gate. Stricter than `assertOfferInvariants`, which a draft may
 * still satisfy while incomplete.
 */
export function assertOfferPublishable(input: OfferInvariantInput & { title?: string | null }): void {
  assertOfferInvariants(input);

  if (!input.title?.trim()) {
    throw validationError("title: give this offer a title before publishing it");
  }

  if (input.value <= 0) {
    throw validationError("value: set a discount greater than zero before publishing this offer");
  }
}
