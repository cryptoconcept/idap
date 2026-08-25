import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";
import {
  ACADEMIC_SEGMENTS,
  GALLERY_STATUSES,
  GENDER_TYPES,
  INSTITUTION_TYPES,
  MANAGEMENT_TYPES,
  PROFILE_STATUSES,
} from "@/lib/constants";

const ContactSchema = new Schema(
  {
    secondaryPhone: { type: String, trim: true },
    alternateEmail: { type: String, trim: true, lowercase: true },
    whatsapp: { type: String, trim: true },
  },
  { _id: false },
);

const GeoSchema = new Schema(
  {
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    mapUrl: { type: String, trim: true },
  },
  { _id: false },
);

const AcademicSchema = new Schema(
  {
    board: { type: String, trim: true },
    affiliation: { type: String, trim: true },
    recognition: { type: String, trim: true },
    affiliationNumber: { type: String, trim: true },
    udiseCode: { type: String, trim: true },
    medium: { type: [String], default: undefined },
    genderType: { type: String, enum: GENDER_TYPES },
    currentAcademicYear: { type: String, trim: true },
    classesOffered: { type: [String], default: undefined },
    coursesOffered: { type: [String], default: undefined },
    /**
     * Which academic segments this institution runs — one or more, because a
     * school with a PU college attached is the norm, not the exception.
     * `undefined` means "never chosen" and reads through
     * `defaultSegmentsFor(institutionType)`. Written only by the
     * academic-structure endpoint, never by a profile PATCH.
     */
    segments: { type: [String], enum: ACADEMIC_SEGMENTS, default: undefined },
  },
  { _id: false },
);

const ManagementSchema = new Schema(
  {
    managementType: { type: String, enum: MANAGEMENT_TYPES },
    trustName: { type: String, trim: true },
    societyName: { type: String, trim: true },
    managementName: { type: String, trim: true },
    principalName: { type: String, trim: true },
    headDesignation: { type: String, trim: true },
    headEmail: { type: String, trim: true, lowercase: true },
    headPhone: { type: String, trim: true },
  },
  { _id: false },
);

const SocialLinkSchema = new Schema(
  { label: { type: String, trim: true }, url: { type: String, trim: true } },
  { _id: false },
);

const SocialSchema = new Schema(
  {
    facebook: { type: String, trim: true },
    instagram: { type: String, trim: true },
    youtube: { type: String, trim: true },
    linkedin: { type: String, trim: true },
    x: { type: String, trim: true },
    other: { type: [SocialLinkSchema], default: undefined },
  },
  { _id: false },
);

/**
 * Free-form by design: any code with any label is storable, so a new facility
 * type never needs a schema change or a migration.
 */
const FacilitySchema = new Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    label: { type: String, required: true, trim: true },
    available: { type: Boolean, default: true },
    note: { type: String, trim: true },
  },
  { _id: false },
);

/** Keeps its _id — the media delete endpoint addresses items by it. */
const GalleryItemSchema = new Schema({
  imageUrl: { type: String, required: true, trim: true },
  title: { type: String, trim: true },
  description: { type: String, trim: true },
  sortOrder: { type: Number, default: 0 },
  status: { type: String, enum: GALLERY_STATUSES, default: "ACTIVE" },
  uploadedAt: { type: Date, default: Date.now },
});

const InstitutionSchema = new Schema(
  {
    institutionId: { type: String, required: true, unique: true, index: true, trim: true },
    institutionName: { type: String, required: true, trim: true },
    institutionType: { type: String, enum: INSTITUTION_TYPES, required: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    contactPerson: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    website: { type: String, trim: true },
    logoUrl: { type: String, trim: true },
    active: { type: Boolean, default: true, index: true },

    // --- identity ---
    slug: { type: String, trim: true, lowercase: true },
    regionCode: { type: String, trim: true, uppercase: true },
    legalName: { type: String, trim: true },
    shortName: { type: String, trim: true },
    coverImageUrl: { type: String, trim: true },
    establishedYear: { type: Number, min: 1800, max: 2200 },
    tagline: { type: String, trim: true },
    description: { type: String, trim: true },
    profileStatus: { type: String, enum: PROFILE_STATUSES, default: "DRAFT", index: true },
    publishedAt: { type: Date },

    // --- contact (primary phone/email/website/contactPerson stay flat above) ---
    contact: { type: ContactSchema, default: undefined },

    // --- address (address/city/state/pincode stay flat above) ---
    addressLine2: { type: String, trim: true },
    locality: { type: String, trim: true },
    area: { type: String, trim: true },
    taluk: { type: String, trim: true },
    district: { type: String, trim: true, index: true },
    country: { type: String, trim: true, default: "India" },
    geo: { type: GeoSchema, default: undefined },

    // --- blocks ---
    academic: { type: AcademicSchema, default: undefined },
    management: { type: ManagementSchema, default: undefined },
    facilities: { type: [FacilitySchema], default: undefined },
    social: { type: SocialSchema, default: undefined },
    gallery: { type: [GalleryItemSchema], default: undefined },
  },
  { timestamps: true, collection: "institutions" },
);

// Sparse: institutions predating the backfill legitimately have no slug.
InstitutionSchema.index({ slug: 1 }, { unique: true, sparse: true });
InstitutionSchema.index({ institutionType: 1 });
InstitutionSchema.index({ "academic.board": 1 });
InstitutionSchema.index({ city: 1 });
InstitutionSchema.index({ institutionName: "text" });

export type InstitutionDoc = InferSchemaType<typeof InstitutionSchema> & { _id: Types.ObjectId };

export const Institution: Model<InstitutionDoc> =
  (models.Institution as Model<InstitutionDoc>) ?? model<InstitutionDoc>("Institution", InstitutionSchema);
