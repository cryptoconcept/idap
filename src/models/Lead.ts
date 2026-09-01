import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";
import { LEAD_STATUSES, SOURCES } from "@/lib/constants";

const LeadSchema = new Schema(
  {
    leadNumber: { type: String, required: true, unique: true, index: true },
    // Request-dedup token from the public enquiry form (audit M4) — see the
    // matching field on Application. Sparse: only public submissions carry one.
    idempotencyKey: { type: String },
    institutionId: { type: String, required: true, index: true },
    studentName: { type: String, required: true, trim: true },
    parentName: { type: String, trim: true },
    phone: { type: String, required: true, trim: true, index: true },
    email: { type: String, trim: true, lowercase: true },
    classInterested: { type: String, trim: true },
    message: { type: String, trim: true },
    status: { type: String, enum: LEAD_STATUSES, default: "NEW", index: true },
    source: { type: String, enum: SOURCES, default: "API" },
    sourceApplication: { type: String, trim: true },
    sourceUrl: { type: String, trim: true },
    // The counselor (or admin) working this lead. Never a Front Desk user —
    // enforced at the service layer, since Front Desk doesn't do casework.
    assignedTo: { type: String, index: true },
    assignedAt: { type: Date },
    // Date-only semantics: stored at midnight UTC for the given calendar day.
    followUpAt: { type: Date },
    // Stamped by the daily reminder job the day it fires for the CURRENT
    // followUpAt. Cleared to undefined whenever followUpAt changes, which is
    // what re-arms the reminder after a date is edited.
    followUpNotifiedAt: { type: Date },
  },
  { timestamps: true, collection: "leads" },
);

// Every dashboard query is tenant-scoped and sorted newest-first.
LeadSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
LeadSchema.index({ institutionId: 1, createdAt: -1 });
LeadSchema.index({ institutionId: 1, status: 1, createdAt: -1 });
// "My queue": a counselor's own assigned leads, newest first.
LeadSchema.index({ institutionId: 1, assignedTo: 1, createdAt: -1 });
// The daily reminder job's query. Deliberately not institution-scoped — the
// job runs once across the whole platform and groups by institution/
// counselor in application code, not in the query.
LeadSchema.index({ followUpAt: 1, followUpNotifiedAt: 1 });

export type LeadDoc = InferSchemaType<typeof LeadSchema> & { _id: Types.ObjectId };

export const Lead: Model<LeadDoc> =
  (models.Lead as Model<LeadDoc>) ?? model<LeadDoc>("Lead", LeadSchema);
