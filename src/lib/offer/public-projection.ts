/**
 * The only path from an Offer document to a public response.
 *
 * This is an allow-list: it names the fields that may leave. A field added to
 * the schema is private until someone deliberately adds it here. Rewriting
 * this as a spread with deletions would leak every future field on the day it
 * was added — a test exists specifically to catch that.
 *
 * Only a PUBLISHED offer is ever projected. Expiry is deliberately NOT checked
 * here: it lives in the service's query, because a projection that reads the
 * clock cannot be tested deterministically.
 */
type Doc = Record<string, unknown>;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const iso = (value: unknown): string | undefined =>
  value instanceof Date ? value.toISOString() : text(value);

export type PublicOffer = NonNullable<ReturnType<typeof toPublicOffer>>;

export function toPublicOffer(offer: Doc) {
  const doc = offer ?? {};

  if (doc.status !== "PUBLISHED") return null;

  return {
    title: text(doc.title),
    description: text(doc.description),
    kind: text(doc.kind),
    value: num(doc.value),
    code: text(doc.code),
    /** Absent for an institution-wide offer — `text` drops the empty string. */
    classOrCourse: text(doc.classOrCourse),
    validFrom: iso(doc.validFrom),
    validUntil: iso(doc.validUntil),
    publishedAt: iso(doc.publishedAt),
  };
}
