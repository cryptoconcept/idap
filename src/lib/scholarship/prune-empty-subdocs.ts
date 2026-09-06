import type { CreateScholarshipInput } from "@/lib/validation/scholarship";

type PrunableScholarshipFields = Pick<CreateScholarshipInput, "benefits" | "eligibility" | "dates">;

/**
 * Whether a single value inside a `benefits`/`eligibility`/`dates`
 * sub-document is worth saving. `false` counts as "unset" here — a provider
 * saying "no waiver"/"no disability requirement" is the absence of that
 * flag, matching `scholarship.ts`'s own Hub-publish gate (`hasBenefit`),
 * which treats `tuitionWaiver: false` the same way. An empty array and a
 * blank string are likewise the untouched-form default, not a real value —
 * `""` in particular is what an untouched `<input type="date">` submits
 * (its own `setValueAs` only fires on a genuine change/blur). A `0`,
 * conversely, IS a value someone typed, so numbers other than these
 * excluded cases always count as meaningful.
 */
function isMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function hasContent(sub: Record<string, unknown> | null | undefined): boolean {
  if (!sub) return false;
  return Object.values(sub).some(isMeaningfulValue);
}

/**
 * Drops `benefits`/`eligibility`/`dates` from a scholarship form payload
 * when the section was never actually touched, so an untouched scholarship
 * round-trips the same as the pre-Task-10 baseline (field absent — not a
 * spurious `{}` / `{tuitionWaiver: false}` / `[]`). Called from
 * `scholarship-form.tsx`'s submit handler, after the payload is built, on
 * validated form values.
 *
 * Setting the key to `undefined` rather than deleting it is enough:
 * `JSON.stringify` drops an `undefined`-valued key entirely — the same fact
 * the form's own submit handler already relies on for `academicUnitId` —
 * which is exactly how this payload leaves the browser.
 *
 * A section the user DID populate is returned untouched: `hasContent` only
 * has to see one meaningful value anywhere in the sub-document to keep the
 * whole thing, so every value the user actually set survives exactly.
 */
export function pruneEmptyScholarshipSubdocs<T extends PrunableScholarshipFields>(payload: T): T {
  return {
    ...payload,
    benefits: hasContent(payload.benefits) ? payload.benefits : undefined,
    eligibility: hasContent(payload.eligibility) ? payload.eligibility : undefined,
    dates: hasContent(payload.dates) ? payload.dates : undefined,
  };
}
