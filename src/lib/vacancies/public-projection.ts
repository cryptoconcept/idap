/**
 * The only path from a Vacancy document to a public response.
 *
 * This is an allow-list: it names the fields that may leave. A field added to
 * the schema is private until someone deliberately adds it here. Rewriting it
 * as a spread with deletions would leak every future field on the day it was
 * added — the same rule `results/public-projection.ts` states, and for the
 * same reason.
 *
 * Two rules live here and nowhere else:
 *
 *  1. Only an OPEN vacancy projects at all. Callers already filter, so this is
 *     defence in depth on the module's highest-risk boundary. `DRAFT` is
 *     unfinished, and `FILLED`/`CLOSED` are roles a careers page must not
 *     still be advertising — a closed advert that stays up collects
 *     applications nobody will read.
 *
 *  2. **The entire `listing` sub-document is withheld**, and this is the rule
 *     most worth stating out loud, because `listing` is the largest and
 *     newest part of the schema and an allow-list is the only thing keeping it
 *     out. It holds eduFleet integration state — `jobId`, `externalJobId`,
 *     `contract`, `claimState`, `blockedReason`, `remoteStatus` and the
 *     `remote*` echo fields. None of it is of any use to a website, and
 *     publishing it would disclose which schools syndicate to eduFleet, which
 *     of their adverts a school has claimed there, and the text of integration
 *     failures — three things about a school's commercial arrangements that
 *     the school never agreed to publish.
 *
 * `facilities` on the document projects as `benefits`. The stored name matches
 * eduFleet's wire field, but the values are unambiguously employee benefits
 * ("Provident Fund (PF)", "ESI (medical insurance)", "Gratuity"), and this is
 * an external contract whose job is to read clearly to someone building a
 * careers page. The rename lives here so the internal name stays consistent
 * everywhere else.
 */

type Doc = Record<string, unknown>;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Drops an array entirely when it has no members, so `[]` never reaches a consumer. */
const listOrUndefined = (values: string[]): string[] | undefined =>
  values.length > 0 ? values : undefined;

const iso = (value: unknown): string | undefined => {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export type PublicVacancy = NonNullable<ReturnType<typeof toPublicVacancy>>;

export function toPublicVacancy(vacancy: Doc) {
  const doc = vacancy ?? {};

  // Rule 1. Re-checked here rather than trusted from the caller's filter.
  if (doc.status !== "OPEN") return null;

  const title = text(doc.title);
  const subject = text(doc.subject);
  const description = text(doc.description);
  // A vacancy missing any of these is not advertisable. The schema marks all
  // three required, so this is unreachable through the product — it guards a
  // hand-edited or partially-migrated document, which is exactly when a
  // careers page would otherwise render an empty card.
  if (!title || !subject || !description) return null;

  return {
    id: String(doc._id ?? ""),
    title,
    subject,
    description,
    salaryMin: num(doc.salaryMin),
    salaryMax: num(doc.salaryMax),
    experienceRequired: num(doc.experienceRequired),
    benefits: listOrUndefined(
      (Array.isArray(doc.facilities) ? doc.facilities : [])
        .map((entry) => text(entry))
        .filter((entry): entry is string => entry !== undefined),
    ),
    // `createdAt` is when the row appeared, which for a careers page is the
    // closest honest answer to "how long has this been open". `updatedAt` is
    // not used: editing a typo would silently re-date the advert.
    postedAt: iso(doc.createdAt),
  };
}
