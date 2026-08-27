import { z } from "zod";
import {
  GENDER_TYPES,
  INSTITUTION_TYPES,
  MANAGEMENT_TYPES,
  MEDIA_CAPTION_MAX,
  MEDIA_STATUSES,
} from "@/lib/constants";
import {
  optionalEmailSchema,
  optionalPhoneSchema,
  optionalPincodeSchema,
  optionalText,
  optionalUrlSchema,
  requiredText,
} from "./common";

const brandingFields = {
  address: optionalText(300),
  city: optionalText(80),
  state: optionalText(80),
  pincode: optionalPincodeSchema,
  contactPerson: optionalText(120),
  phone: optionalPhoneSchema,
  email: optionalEmailSchema,
  website: optionalUrlSchema,
  logoUrl: optionalUrlSchema,
};

export const createInstitutionSchema = z.object({
  institutionId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^INS\d{4,6}$/, "Institution ID must look like INS0001")
    .optional(),
  institutionName: requiredText("Institution name", 160),
  institutionType: z.enum(INSTITUTION_TYPES),
  ...brandingFields,
  // Optional bootstrap admin created alongside the institution.
  adminName: optionalText(120),
  adminEmail: optionalEmailSchema,
  adminPassword: z.string().min(10, "Password must be at least 10 characters").max(128).optional(),
});

export const updateInstitutionSchema = z.object({
  institutionName: requiredText("Institution name", 160).optional(),
  institutionType: z.enum(INSTITUTION_TYPES).optional(),
  ...brandingFields,
  active: z.boolean().optional(),
});

const CURRENT_YEAR = 2200; // upper bound; lower bound 1800

const contactBlockSchema = z.object({
  secondaryPhone: optionalPhoneSchema,
  alternateEmail: optionalEmailSchema,
  whatsapp: optionalPhoneSchema,
});

const geoSchema = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  mapUrl: optionalUrlSchema,
});

const academicSchema = z.object({
  board: optionalText(80),
  affiliation: optionalText(120),
  recognition: optionalText(120),
  affiliationNumber: optionalText(60),
  udiseCode: optionalText(40),
  medium: z.array(requiredText("Medium", 40)).max(12).optional(),
  genderType: z.enum(GENDER_TYPES).optional(),
  currentAcademicYear: optionalText(20),
  classesOffered: z.array(requiredText("Class", 40)).max(60).optional(),
  coursesOffered: z.array(requiredText("Course", 120)).max(120).optional(),
});

const managementSchema = z.object({
  managementType: z.enum(MANAGEMENT_TYPES).optional(),
  trustName: optionalText(160),
  societyName: optionalText(160),
  managementName: optionalText(160),
  principalName: optionalText(120),
  headDesignation: optionalText(80),
  headEmail: optionalEmailSchema,
  headPhone: optionalPhoneSchema,
});

const facilitySchema = z.object({
  code: requiredText("Facility code", 40),
  label: requiredText("Facility label", 80),
  available: z.boolean().optional(),
  note: optionalText(200),
});

const socialSchema = z.object({
  facebook: optionalUrlSchema,
  instagram: optionalUrlSchema,
  youtube: optionalUrlSchema,
  linkedin: optionalUrlSchema,
  x: optionalUrlSchema,
  other: z
    .array(z.object({ label: requiredText("Label", 40), url: optionalUrlSchema }))
    .max(6)
    .optional(),
});

/** Everything an institute admin may change on their own profile. */
export const updateProfileSchema = z.object({
  institutionName: requiredText("Institution name", 160).optional(),
  legalName: optionalText(200),
  shortName: optionalText(80),
  institutionType: z.enum(INSTITUTION_TYPES).optional(),
  tagline: optionalText(160),
  description: optionalText(4000),
  establishedYear: z.number().int().min(1800).max(CURRENT_YEAR).optional(),

  ...brandingFields,

  /**
   * The two image fields are the only ones that accept an explicit `null`, and
   * it means *clear this image* — the documented way to remove a logo or cover,
   * since the media endpoint only ever replaces or appends. `undefined` (the
   * key simply absent) still means "don't touch it"; the service turns the
   * `null` into an `$unset`. Declared after the `brandingFields` spread so this
   * widened `logoUrl` replaces the plain one for this schema only: the platform
   * admin's and the create form's `logoUrl` stay non-nullable.
   */
  logoUrl: optionalUrlSchema.nullable(),
  coverImageUrl: optionalUrlSchema.nullable(),

  addressLine2: optionalText(200),
  locality: optionalText(120),
  area: optionalText(120),
  taluk: optionalText(120),
  district: optionalText(120),
  country: optionalText(80),

  contact: contactBlockSchema.optional(),
  geo: geoSchema.optional(),
  academic: academicSchema.optional(),
  management: managementSchema.optional(),
  facilities: z.array(facilitySchema).max(40).optional(),
  social: socialSchema.optional(),
});

/**
 * The platform admin provisions institutions; they do not author the profile.
 * The boundary lives in this schema so no route can widen it by accident.
 */
export const platformInstitutionPatchSchema = z.object({
  institutionName: requiredText("Institution name", 160).optional(),
  institutionType: z.enum(INSTITUTION_TYPES).optional(),
  regionCode: optionalText(12),
  active: z.boolean().optional(),
});

/** `target` is the upload DESTINATION. `kind` is the media TYPE. Having one
 *  word mean both in the same subsystem is what this rename avoids. */
export const mediaUploadSchema = z.object({
  target: z.enum(["LOGO", "COVER", "MEDIA"]),
  kind: z.enum(["IMAGE", "BROCHURE", "PROSPECTUS"]).optional(),
  title: optionalText(120),
  caption: optionalText(MEDIA_CAPTION_MAX),
});

export const mediaItemPatchSchema = z.object({
  title: optionalText(120),
  caption: optionalText(MEDIA_CAPTION_MAX),
  sortOrder: z.number().int().min(0).max(999).optional(),
  status: z.enum(MEDIA_STATUSES).optional(),
});
