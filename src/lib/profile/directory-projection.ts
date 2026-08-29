/**
 * The only path from an Institution document to a **directory card**.
 *
 * Separate from `public-projection.ts` on purpose. That module answers "show
 * me this school" and returns the whole profile — contact details, management,
 * achievements, alumni, the media library. This one answers "which schools are
 * there", and a list of two hundred schools has no business carrying two
 * hundred copies of that. Reusing the full projection here would have made the
 * directory the largest response in the API and put every field it returns —
 * including the contact block — on an endpoint nobody has to name an
 * institution to call.
 *
 * So this is a deliberately small allow-list: enough to render a card and link
 * to the full profile, and nothing else. `contact`, `geo`, `management`,
 * `achievements`, `alumni`, `media` and `facilities` are all absent by design,
 * not by omission — a consumer that needs them fetches the one profile it is
 * actually showing.
 *
 * The same allow-list rule applies as everywhere else: adding a field to the
 * schema must not add it here. A test asserts the exact key set.
 */

type Doc = Record<string, unknown>;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const nested = (doc: Doc, key: string): Doc =>
  (doc[key] && typeof doc[key] === "object" ? doc[key] : {}) as Doc;

export type DirectoryCard = ReturnType<typeof toDirectoryCard>;

export function toDirectoryCard(institution: Doc) {
  const doc = institution ?? {};
  const academic = nested(doc, "academic");

  return {
    institutionId: text(doc.institutionId) ?? "",
    // Absent until the institution claims one. A card without a slug can still
    // be linked by id, which is why this is optional rather than a filter.
    slug: text(doc.slug),
    institutionName: text(doc.institutionName) ?? "",
    shortName: text(doc.shortName),
    institutionType: text(doc.institutionType),
    tagline: text(doc.tagline),
    logoUrl: text(doc.logoUrl),
    coverImageUrl: text(doc.coverImageUrl),
    // Read flat, because that is how they are STORED: `city`, `district` and
    // `state` are top-level columns on the document. The nested `address`
    // object in the full public profile is assembled by `public-projection.ts`
    // on the way out; it does not exist in the database, and reading
    // `address.city` here silently returns undefined for every institution.
    city: text(doc.city),
    district: text(doc.district),
    state: text(doc.state),
    board: text(academic.board),
    genderType: text(academic.genderType),
  };
}
