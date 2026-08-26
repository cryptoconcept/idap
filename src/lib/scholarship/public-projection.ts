/**
 * The only path from a Scholarship document to a public response.
 *
 * This is an allow-list: it names the fields that may leave. A field added to
 * the schema is private until someone deliberately adds it here. Rewriting
 * this as a spread with deletions would leak every future field on the day it
 * was added — a test exists specifically to catch that.
 *
 * The one rule that lives here and nowhere else: only a PUBLISHED scholarship
 * is ever projected. Callers already filter, but this is defence in depth on
 * the module's highest-risk boundary.
 */
type Doc = Record<string, unknown>;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export type PublicScholarship = NonNullable<ReturnType<typeof toPublicScholarship>>;

export function toPublicScholarship(scholarship: Doc) {
  const doc = scholarship ?? {};

  if (doc.status !== "PUBLISHED") return null;

  const publishedAt = doc.publishedAt;

  return {
    name: text(doc.name),
    criteria: text(doc.criteria),
    amount: text(doc.amount),
    /** Absent for an institution-wide scholarship — `text` drops the empty string. */
    classOrCourse: text(doc.classOrCourse),
    publishedAt: publishedAt instanceof Date ? publishedAt.toISOString() : text(publishedAt),
  };
}
