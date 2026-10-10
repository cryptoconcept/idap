import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";
import { HUB_APPLICATION_STATUSES, SCHOLARSHIP_APPLICATION_REVIEW_STATUSES } from "@/lib/constants";

const ScholarshipApplicationDocumentSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
  },
  { _id: false },
);

const ScholarshipApplicantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true },
    mobile: { type: String, trim: true },
  },
  { _id: false },
);

const ScholarshipApplicationSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    scholarshipId: { type: Schema.Types.ObjectId, required: true, index: true },
    externalRef: { type: String, required: true },
    /**
     * The Scholarship Hub's own Application `_id` (a 24-char hex string) —
     * the idempotency key sync-back ingests on (see the unique index
     * below). Unlike `Lead`/`Application`'s `idempotencyKey` (optional,
     * partial-unique — only some rows carry one), EVERY row here always has
     * one: there is no manually-created ScholarshipApplication, so a plain
     * (not partial) unique compound index is correct here, and simpler.
     */
    hubApplicationId: { type: String, required: true },
    applicationNo: { type: String, trim: true },

    applicant: { type: ScholarshipApplicantSchema, required: true },
    answers: { type: Schema.Types.Mixed, default: () => ({}) },
    documents: { type: [ScholarshipApplicationDocumentSchema], default: [] },

    hubStatus: { type: String, required: true, enum: HUB_APPLICATION_STATUSES },
    reviewStatus: {
      type: String,
      required: true,
      enum: SCHOLARSHIP_APPLICATION_REVIEW_STATUSES,
      default: "NEW",
    },

    assignedTo: { type: String, index: true },
    assignedAt: { type: Date },

    submittedAt: { type: Date },
    withdrawnAt: { type: Date },

    /**
     * The Hub's own `updatedAt` for this application, copied verbatim at
     * every sync. The ingestion core's ordering guard (Task 3) compares an
     * incoming payload's `hubUpdatedAt` against this stored value before
     * writing any Hub-owned field, so a stale poll snapshot racing a newer
     * webhook-triggered pull can never revert it.
     */
    hubUpdatedAt: { type: Date, required: true },
    lastSyncedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "scholarshipApplications" },
);

ScholarshipApplicationSchema.index({ institutionId: 1, hubApplicationId: 1 }, { unique: true });
ScholarshipApplicationSchema.index({ institutionId: 1, createdAt: -1 });
ScholarshipApplicationSchema.index({ institutionId: 1, hubStatus: 1, createdAt: -1 });
ScholarshipApplicationSchema.index({ institutionId: 1, reviewStatus: 1, createdAt: -1 });
ScholarshipApplicationSchema.index({ institutionId: 1, assignedTo: 1, createdAt: -1 });
ScholarshipApplicationSchema.index({ institutionId: 1, scholarshipId: 1 });

export type ScholarshipApplicationDoc = InferSchemaType<typeof ScholarshipApplicationSchema> & {
  _id: Types.ObjectId;
};

export const ScholarshipApplication: Model<ScholarshipApplicationDoc> =
  (models.ScholarshipApplication as Model<ScholarshipApplicationDoc>) ??
  model<ScholarshipApplicationDoc>("ScholarshipApplication", ScholarshipApplicationSchema);
