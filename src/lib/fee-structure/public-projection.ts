/**
 * The only path from a FeeStructure document to a public response.
 *
 * This is an allow-list: it names the fields that may leave. A field added to
 * the schema is private until someone deliberately adds it here. Rewriting
 * this as a spread with deletions would leak every future field on the day it
 * was added — a test exists specifically to catch that.
 *
 * The one rule that lives here and nowhere else: only a PUBLISHED fee
 * structure is ever projected. Callers already filter, but this is defence
 * in depth on the module's highest-risk boundary.
 */
type Doc = Record<string, unknown>;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const bool = (value: unknown): boolean => value === true;

const rows = (value: unknown): Doc[] => (Array.isArray(value) ? (value as Doc[]) : []);

/** Drops an array entirely when it has no members, so `[]` never reaches a consumer. */
const listOrUndefined = <T>(values: T[]): T[] | undefined =>
  values.length > 0 ? values : undefined;

export type PublicFeeStructure = NonNullable<ReturnType<typeof toPublicFeeStructure>>;

export function toPublicFeeStructure(feeStructure: Doc) {
  const doc = feeStructure ?? {};

  if (doc.status !== "PUBLISHED") return null;

  const lineItems = rows(doc.lineItems).map((item) => ({
    label: text(item.label),
    amount: num(item.amount),
    frequency: text(item.frequency),
    optional: bool(item.optional),
  }));

  const publishedAt = doc.publishedAt;

  return {
    classOrCourse: text(doc.classOrCourse),
    academicYear: text(doc.academicYear),
    lineItems: listOrUndefined(lineItems),
    publishedAt: publishedAt instanceof Date ? publishedAt.toISOString() : text(publishedAt),
  };
}
