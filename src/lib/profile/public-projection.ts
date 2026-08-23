/**
 * The only path from an Institution document to a public response.
 *
 * This is an allow-list: it names the fields that may leave. A field added to
 * the schema is private until someone deliberately adds it here. Rewriting this
 * as a spread with deletions would leak every future field on the day it was
 * added — a test exists specifically to catch that.
 */

type Doc = Record<string, any>;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const list = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length > 0 ? value.map(String) : undefined;

/** Drops a block entirely when every field in it is absent. */
function compact<T extends Record<string, unknown>>(block: T): T | undefined {
  const kept = Object.entries(block).filter(([, value]) => value !== undefined);
  return kept.length > 0 ? (Object.fromEntries(kept) as T) : undefined;
}

export type PublicProfile = ReturnType<typeof toPublicProfile>;

export function toPublicProfile(institution: Doc) {
  const doc = institution ?? {};

  const geo = compact({
    latitude: num(doc.geo?.latitude),
    longitude: num(doc.geo?.longitude),
    mapUrl: text(doc.geo?.mapUrl),
  });

  const academic = compact({
    board: text(doc.academic?.board),
    affiliation: text(doc.academic?.affiliation),
    recognition: text(doc.academic?.recognition),
    affiliationNumber: text(doc.academic?.affiliationNumber),
    udiseCode: text(doc.academic?.udiseCode),
    medium: list(doc.academic?.medium),
    genderType: text(doc.academic?.genderType),
    currentAcademicYear: text(doc.academic?.currentAcademicYear),
    classesOffered: list(doc.academic?.classesOffered),
    coursesOffered: list(doc.academic?.coursesOffered),
  });

  // Names and designations only. The head's direct line is not public.
  const management = compact({
    managementType: text(doc.management?.managementType),
    trustName: text(doc.management?.trustName),
    societyName: text(doc.management?.societyName),
    managementName: text(doc.management?.managementName),
    principalName: text(doc.management?.principalName),
    headDesignation: text(doc.management?.headDesignation),
  });

  const social = compact({
    facebook: text(doc.social?.facebook),
    instagram: text(doc.social?.instagram),
    youtube: text(doc.social?.youtube),
    linkedin: text(doc.social?.linkedin),
    x: text(doc.social?.x),
    other: Array.isArray(doc.social?.other)
      ? doc.social.other
          .map((entry: Doc) => compact({ label: text(entry?.label), url: text(entry?.url) }))
          .filter(Boolean)
      : undefined,
  });

  return {
    institutionId: String(doc.institutionId),
    slug: text(doc.slug),
    institutionName: String(doc.institutionName ?? ""),
    legalName: text(doc.legalName),
    shortName: text(doc.shortName),
    institutionType: String(doc.institutionType ?? ""),
    regionCode: text(doc.regionCode),
    tagline: text(doc.tagline),
    description: text(doc.description),
    establishedYear: num(doc.establishedYear),
    logoUrl: text(doc.logoUrl),
    coverImageUrl: text(doc.coverImageUrl),

    address: compact({
      addressLine1: text(doc.address),
      addressLine2: text(doc.addressLine2),
      locality: text(doc.locality),
      area: text(doc.area),
      city: text(doc.city),
      taluk: text(doc.taluk),
      district: text(doc.district),
      state: text(doc.state),
      country: text(doc.country),
      pincode: text(doc.pincode),
    }),

    geo,

    contact: compact({
      phone: text(doc.phone),
      secondaryPhone: text(doc.contact?.secondaryPhone),
      whatsapp: text(doc.contact?.whatsapp),
      email: text(doc.email),
      alternateEmail: text(doc.contact?.alternateEmail),
      website: text(doc.website),
      contactPerson: text(doc.contactPerson),
    }),

    academic,
    management,

    facilities: Array.isArray(doc.facilities)
      ? doc.facilities.map((facility: Doc) => ({
          code: String(facility?.code ?? ""),
          label: String(facility?.label ?? ""),
          available: facility?.available !== false,
          note: text(facility?.note),
        }))
      : [],

    social,

    gallery: Array.isArray(doc.gallery)
      ? doc.gallery
          .filter((item: Doc) => item?.status !== "HIDDEN")
          .sort((a: Doc, b: Doc) => (a?.sortOrder ?? 0) - (b?.sortOrder ?? 0))
          .map((item: Doc) => ({
            imageUrl: String(item?.imageUrl ?? ""),
            title: text(item?.title),
            description: text(item?.description),
          }))
      : [],
  };
}
