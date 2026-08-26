import { z } from "zod";
import { OFFER_KINDS } from "@/lib/constants";
import { validationError } from "@/lib/api/errors";
import { objectIdString, requiredText } from "./common";

/**
 * A blank `type="date"` input submits `""`, which `z.coerce.date()` rejects
 * outright (it coerces to an Invalid Date and fails the type check) — and
 * `undefined` cannot mean "clear this" because the service's `stripUndefined`
 * reads an absent key as "leave alone" on a PATCH, the same reason
 * `academicUnitId` above is nullable rather than just optional. So `""`
 * folds to `null` here, which survives `JSON.stringify`, passes through
 * `stripUndefined` into the `$set`, and clears a previously-set date. Same
 * null-means-clear rule as `academicUnitId`, applied to both date fields.
 */
const clearableDate = z.preprocess(
  (value) => (value === "" ? null : value),
  z.coerce.date().nullable().optional(),
);

/** Matches a bare `YYYY-MM-DD`, never a full ISO timestamp. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `validUntil` only. A bare `YYYY-MM-DD` — what a `type="date"` control
 * submits — is ambiguous about which instant of that day it names, and
 * `z.coerce.date()` resolves the ambiguity to the FIRST instant
 * (`00:00:00.000Z`). For an end date that reads backwards: "valid until 31
 * August" means 31 August is included, so the field must resolve to the
 * LAST instant of that day instead. Rewriting the string to carry an
 * explicit end-of-day time before coercion gets there without touching
 * `listPublic`'s `$gte: new Date()` filter, which is what actually decides
 * visibility.
 *
 * A value that already carries a time component (a full ISO timestamp, or a
 * `Date` instance passed directly by a service) is left exactly as given —
 * only the date-only shorthand is ambiguous enough to need an opinion.
 * `validFrom` keeps using the plain `clearableDate` above: a start date at
 * midnight is already the earliest moment it should apply, so it needs no
 * such adjustment.
 */
const clearableEndOfDayDate = z.preprocess((value) => {
  if (value === "") return null;
  if (typeof value === "string" && DATE_ONLY.test(value)) return `${value}T23:59:59.999Z`;
  return value;
}, z.coerce.date().nullable().optional());

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
  validFrom: clearableDate,
  validUntil: clearableEndOfDayDate,
});
export type CreateOfferInput = z.infer<typeof createOfferSchema>;

/**
 * `status` is absent so a PATCH cannot skip the publish gate — Zod strips it,
 * the same mechanism `updateScholarshipSchema` uses.
 *
 * `academicUnitId`, `validFrom` and `validUntil` all inherit
 * `createOfferSchema`'s nullable-and-optional shape via `.partial()`, and for
 * all three the distinction actually matters: an *omitted* key means "leave
 * it alone" (the service's `stripUndefined` absorbs it, so a PATCH touching
 * only `value` cannot accidentally erase an existing scope or date), while an
 * explicit `null` is the only payload that clears one — back to
 * institution-wide for `academicUnitId`, to "no end date" for `validUntil`.
 * Without a nullable field there would be no way to ever un-scope an offer,
 * or remove a date once set — `undefined` cannot serve double duty as both
 * "leave alone" and "clear", since a browser's `JSON.stringify` drops
 * `undefined` keys entirely, making the two indistinguishable on the wire.
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
