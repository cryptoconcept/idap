import { z } from "zod";
import { OFFER_KINDS } from "@/lib/constants";
import { validationError } from "@/lib/api/errors";
import { objectIdString, requiredText } from "./common";

export const createOfferSchema = z.object({
  title: requiredText("Offer title", 120),
  description: z.string().trim().max(600).optional(),
  kind: z.enum(OFFER_KINDS),
  value: z.number().min(0, "Must be 0 or more"),
  code: z.string().trim().max(40).optional(),
  academicUnitId: objectIdString.optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
});
export type CreateOfferInput = z.infer<typeof createOfferSchema>;

/** `status` is absent so a PATCH cannot skip the publish gate — Zod strips it. */
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
