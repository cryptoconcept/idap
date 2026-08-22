import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";
import { LEAD_STATUSES, SOURCES } from "@/lib/constants";

const LeadSchema = new Schema(
  {
    leadNumber: { type: String, required: true, unique: true, index: true },
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
  },
  { timestamps: true, collection: "leads" },
);

// Every dashboard query is tenant-scoped and sorted newest-first.
LeadSchema.index({ institutionId: 1, createdAt: -1 });
LeadSchema.index({ institutionId: 1, status: 1, createdAt: -1 });

export type LeadDoc = InferSchemaType<typeof LeadSchema> & { _id: Types.ObjectId };

export const Lead: Model<LeadDoc> =
  (models.Lead as Model<LeadDoc>) ?? model<LeadDoc>("Lead", LeadSchema);
