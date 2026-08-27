/**
 * The only path from an Institution document to a public response.
 *
 * This is an allow-list: it names the fields that may leave. A field added to
 * the schema is private until someone deliberately adds it here. Rewriting this
 * as a spread with deletions would leak every future field on the day it was
 * added — a test exists specifically to catch that.
 */

import { toPublicUrl } from "@/lib/media/public-url";

type Doc = Record<string, unknown>;

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

export function toPublicProfile(
  institution: Doc,
  /**
   * Offerings derived from the academic tree. Optional on purpose: without it
   * the stored arrays are used exactly as before, which is what an institution
   * that has not built a tree keeps publishing.
   */
  offerings?: { classesOffered: string[]; coursesOffered: string[] },
) {
  const doc = institution ?? {};

  const geo = compact({
    latitude: num((doc.geo as Record<string, unknown> | undefined)?.latitude),
    longitude: num((doc.geo as Record<string, unknown> | undefined)?.longitude),
    mapUrl: text((doc.geo as Record<string, unknown> | undefined)?.mapUrl),
  });

  const academic = compact({
    board: text((doc.academic as Record<string, unknown> | undefined)?.board),
    affiliation: text((doc.academic as Record<string, unknown> | undefined)?.affiliation),
    recognition: text((doc.academic as Record<string, unknown> | undefined)?.recognition),
    affiliationNumber: text((doc.academic as Record<string, unknown> | undefined)?.affiliationNumber),
    udiseCode: text((doc.academic as Record<string, unknown> | undefined)?.udiseCode),
    medium: list((doc.academic as Record<string, unknown> | undefined)?.medium),
    genderType: text((doc.academic as Record<string, unknown> | undefined)?.genderType),
    currentAcademicYear: text((doc.academic as Record<string, unknown> | undefined)?.currentAcademicYear),
    // Per array, not per institution. A school+PU college that has built its class
    // tree but not its course tree must keep publishing its stored courses — losing
    // them because a *class* exists is not something the admin did or could predict.
    classesOffered: list(
      offerings?.classesOffered.length
        ? offerings.classesOffered
        : (doc.academic as Record<string, unknown> | undefined)?.classesOffered,
    ),
    coursesOffered: list(
      offerings?.coursesOffered.length
        ? offerings.coursesOffered
        : (doc.academic as Record<string, unknown> | undefined)?.coursesOffered,
    ),
  });

  // Names and designations only. The head's direct line is not public.
  const management = compact({
    managementType: text((doc.management as Record<string, unknown> | undefined)?.managementType),
    trustName: text((doc.management as Record<string, unknown> | undefined)?.trustName),
    societyName: text((doc.management as Record<string, unknown> | undefined)?.societyName),
    managementName: text((doc.management as Record<string, unknown> | undefined)?.managementName),
    principalName: text((doc.management as Record<string, unknown> | undefined)?.principalName),
    headDesignation: text((doc.management as Record<string, unknown> | undefined)?.headDesignation),
  });

  const social = compact({
    facebook: text((doc.social as Record<string, unknown> | undefined)?.facebook),
    instagram: text((doc.social as Record<string, unknown> | undefined)?.instagram),
    youtube: text((doc.social as Record<string, unknown> | undefined)?.youtube),
    linkedin: text((doc.social as Record<string, unknown> | undefined)?.linkedin),
    x: text((doc.social as Record<string, unknown> | undefined)?.x),
    other: Array.isArray((doc.social as Record<string, unknown> | undefined)?.other)
      ? ((doc.social as Record<string, unknown>).other as unknown[])
          .map((entry: unknown) => compact({ label: text((entry as Record<string, unknown> | undefined)?.label), url: text((entry as Record<string, unknown> | undefined)?.url) }))
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
      secondaryPhone: text((doc.contact as Record<string, unknown> | undefined)?.secondaryPhone),
      whatsapp: text((doc.contact as Record<string, unknown> | undefined)?.whatsapp),
      email: text(doc.email),
      alternateEmail: text((doc.contact as Record<string, unknown> | undefined)?.alternateEmail),
      website: text(doc.website),
      contactPerson: text(doc.contactPerson),
    }),

    academic,
    management,

    facilities: Array.isArray(doc.facilities)
      ? (doc.facilities as unknown[]).map((facility: unknown) => ({
          code: String((facility as Record<string, unknown> | undefined)?.code ?? ""),
          label: String((facility as Record<string, unknown> | undefined)?.label ?? ""),
          available: (facility as Record<string, unknown> | undefined)?.available !== false,
          note: text((facility as Record<string, unknown> | undefined)?.note),
        }))
      : [],

    social,

    // Parity with the pre-rename `gallery` projection: same filter (hidden
    // items excluded — MUST stay first, before anything below reads the
    // array), same sort (by `sortOrder`, then `uploadedAt` to break ties).
    // Task 7 adds absolute URL resolution and `id`/`kind`/`provider`/`videoId`
    // so a consuming website can address, categorise and, for videos, embed
    // each item without a second lookup.
    media: Array.isArray(doc.media)
      ? (doc.media as unknown[])
          .filter((item: unknown) => (item as Record<string, unknown> | undefined)?.status !== "HIDDEN")
          .sort((a: unknown, b: unknown) => {
            const left = a as Record<string, unknown> | undefined;
            const right = b as Record<string, unknown> | undefined;
            const bySortOrder = (num(left?.sortOrder) ?? 0) - (num(right?.sortOrder) ?? 0);
            if (bySortOrder !== 0) return bySortOrder;
            const leftUploaded = left?.uploadedAt ? new Date(left.uploadedAt as string | Date).getTime() : 0;
            const rightUploaded = right?.uploadedAt ? new Date(right.uploadedAt as string | Date).getTime() : 0;
            return leftUploaded - rightUploaded;
          })
          .map((item: unknown) => {
            const rec = item as Record<string, unknown> | undefined;
            const rawUrl = text(rec?.url);
            return {
              id: String(rec?._id ?? ""),
              kind: String(rec?.kind ?? ""),
              // Deliberately NOT `assertExternallyReachable`-guarded, unlike
              // `feesbasket-mapping.ts`: a localhost URL here is harmless
              // (IDAP serves its own API to itself in dev), but the mirror
              // guard on the FeesBasket path exists because that URL is
              // handed to a third party that only ever links to it, never
              // fetches it. See I5 / `public-projection.test.ts` for the
              // test pinning this asymmetry as deliberate.
              url: rawUrl ? toPublicUrl(rawUrl) : "",
              title: text(rec?.title),
              caption: text(rec?.caption),
              provider: text(rec?.provider),
              videoId: text(rec?.videoId),
              sortOrder: num(rec?.sortOrder) ?? 0,
            };
          })
      : [],
  };
}
