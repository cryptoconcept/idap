import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";
import { APPLICATION_STATUSES, DOCUMENT_TYPES, SOURCES } from "@/lib/constants";

const EmbeddedDocumentSchema = new Schema(
  {
    documentType: { type: String, enum: DOCUMENT_TYPES, required: true },
    fileName: { type: String, required: true },
    fileUrl: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const ApplicationSchema = new Schema(
  {
    applicationNumber: { type: String, required: true, unique: true, index: true },
    // Request-dedup token from the public apply form (audit M4). A retry after
    // a dropped response replays the same key, so the second write collapses
    // onto the first instead of creating a duplicate application. Sparse: only
    // public submissions carry one; dashboard manual entry does not.
    idempotencyKey: { type: String },
    institutionId: { type: String, required: true, index: true },
    academicYear: { type: String, required: true, trim: true, index: true },

    student: {
      firstName: { type: String, required: true, trim: true },
      middleName: { type: String, trim: true },
      lastName: { type: String, trim: true },
      dateOfBirth: { type: Date },
      gender: { type: String, trim: true },
      bloodGroup: { type: String, trim: true },
    },

    parent: {
      fatherName: { type: String, trim: true },
      motherName: { type: String, trim: true },
      guardianName: { type: String, trim: true },
      phone: { type: String, required: true, trim: true, index: true },
      alternatePhone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
    },

    address: {
      addressLine1: { type: String, trim: true },
      addressLine2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
    },

    academic: {
      previousInstitution: { type: String, trim: true },
      previousClass: { type: String, trim: true },
      previousPercentage: { type: Number, min: 0, max: 100 },
    },

    admission: {
      applyingFor: { type: String, required: true, trim: true, index: true },
      admissionType: { type: String, trim: true },
    },

    message: { type: String, trim: true },
    documents: { type: [EmbeddedDocumentSchema], default: [] },

    status: { type: String, enum: APPLICATION_STATUSES, default: "SUBMITTED", index: true },
    source: { type: String, enum: SOURCES, default: "API" },
    sourceUrl: { type: String, trim: true },

    // Denormalised for search; kept in sync by the service layer.
    studentFullName: { type: String, trim: true, index: true },
  },
  { timestamps: true, collection: "applications" },
);

// Tenant-scoped dedup (audit architecture M1): the key is unique WITHIN an
// institution, not globally, so a key reused across tenants can never return
// another tenant's record. Partial, not sparse: institutionId is always
// present, so a sparse compound index would index every row and collide two
// keyless submissions on { inst, null }; partialFilterExpression constrains
// only the rows that actually carry a key.
ApplicationSchema.index(
  { institutionId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true } } },
);
ApplicationSchema.index({ institutionId: 1, createdAt: -1 });
ApplicationSchema.index({ institutionId: 1, status: 1, createdAt: -1 });
ApplicationSchema.index({ institutionId: 1, academicYear: 1, createdAt: -1 });

export type ApplicationDoc = InferSchemaType<typeof ApplicationSchema> & { _id: Types.ObjectId };

export const Application: Model<ApplicationDoc> =
  (models.Application as Model<ApplicationDoc>) ?? model<ApplicationDoc>("Application", ApplicationSchema);
