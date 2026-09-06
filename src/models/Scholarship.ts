import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { SCHOLARSHIP_STATUSES, SCHOLARSHIP_LISTING_REMOTE_STATUSES } from "@/lib/constants";
import {
  HUB_SCHOLARSHIP_CATEGORIES, HUB_EDUCATION_LEVELS, HUB_GENDERS,
  HUB_COMMUNITY_CATEGORIES, HUB_QUESTION_TYPES, HUB_APPLICATION_MODES,
} from "@/lib/scholarship-hub/vocabulary";

const BenefitsSchema = new Schema({
  amountMin: Number, amountMax: Number, stipendMonthly: Number, awards: Number,
  tuitionWaiver: { type: Boolean, default: false },
}, { _id: false });

const EligibilitySchema = new Schema({
  stateCodes: [String], districtCodes: [String],
  educationLevels: [{ type: String, enum: HUB_EDUCATION_LEVELS }],
  classesOrCourses: [String], streams: [String],
  genders: [{ type: String, enum: HUB_GENDERS }],
  ageMin: Number, ageMax: Number, minPercentage: Number, maxAnnualIncome: Number,
  communityCategories: [{ type: String, enum: HUB_COMMUNITY_CATEGORIES }],
  disabilityRequired: { type: Boolean, default: false },
  otherCriteria: [String],
}, { _id: false });

const RequiredDocumentSchema = new Schema({
  key: { type: String, required: true }, label: { type: String, required: true },
  required: { type: Boolean, default: true },
}, { _id: false });

const CustomQuestionSchema = new Schema({
  key: { type: String, required: true }, label: { type: String, required: true },
  type: { type: String, enum: HUB_QUESTION_TYPES, required: true },
  options: [String], required: { type: Boolean, default: false }, helpText: String,
}, { _id: false });

const DatesSchema = new Schema({ opensAt: Date, closesAt: Date, resultAt: Date }, { _id: false });
const FaqSchema = new Schema({ q: { type: String, required: true }, a: { type: String, required: true } }, { _id: false });

const ScholarshipListingSchema = new Schema({
  hubId: { type: String, required: true },
  externalRef: { type: String, required: true },
  slug: String,
  publicUrl: String,
  remoteStatus: { type: String, enum: SCHOLARSHIP_LISTING_REMOTE_STATUSES, default: "published" },
  lastPushedAt: { type: Date, required: true },
  blockedReason: String,
}, { _id: false });

const ScholarshipSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    criteria: { type: String, trim: true },
    /**
     * Free-form on purpose: "Up to ₹50,000", "100% tuition for ranks 1-10".
     * A kind/value pair like Offer's cannot express the eligibility half
     * without losing it, so this is prose the institution controls.
     */
    amount: { type: String, trim: true },
    /**
     * Absent means the scholarship applies institution-wide. No `ref`:
     * nothing here uses Mongoose populate — the service queries the unit
     * directly — and a `ref` would imply an access pattern that does not exist.
     */
    academicUnitId: { type: Schema.Types.ObjectId, index: true },
    status: { type: String, enum: SCHOLARSHIP_STATUSES, default: "DRAFT" },
    publishedAt: { type: Date },
    summary: String,
    description: String,
    categories: [{ type: String, enum: HUB_SCHOLARSHIP_CATEGORIES }],
    tags: [String],
    benefits: { type: BenefitsSchema, default: undefined },
    eligibility: { type: EligibilitySchema, default: undefined },
    applicationMode: { type: String, enum: HUB_APPLICATION_MODES, default: "platform" },
    requiredDocuments: { type: [RequiredDocumentSchema], default: undefined },
    customQuestions: { type: [CustomQuestionSchema], default: undefined },
    applicationSteps: [String],
    dates: { type: DatesSchema, default: undefined },
    selectionProcess: String,
    terms: String,
    faqs: { type: [FaqSchema], default: undefined },
    sourceUrl: String,
    listing: { type: ScholarshipListingSchema, default: undefined },
  },
  { timestamps: true },
);

ScholarshipSchema.index({ institutionId: 1, createdAt: -1 });
ScholarshipSchema.index({ institutionId: 1, status: 1 });

export type ScholarshipDoc = InferSchemaType<typeof ScholarshipSchema> & { _id: Types.ObjectId };

export const Scholarship: Model<ScholarshipDoc> =
  (models.Scholarship as Model<ScholarshipDoc>) ??
  model<ScholarshipDoc>("Scholarship", ScholarshipSchema);
