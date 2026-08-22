import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";

const ActivitySchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    // Widened beyond LEAD/APPLICATION so platform-level events (API keys,
    // institutions, auth) share one audit trail.
    entityType: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId },
    entityRef: { type: String },
    action: { type: String, required: true },
    description: { type: String },
    performedBy: { type: Schema.Types.ObjectId, ref: "User" },
    performedByName: { type: String },
    ipAddress: { type: String },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { collection: "activities" },
);

ActivitySchema.index({ institutionId: 1, entityType: 1, entityId: 1, createdAt: -1 });

export type ActivityDoc = InferSchemaType<typeof ActivitySchema> & { _id: Types.ObjectId };

export const Activity: Model<ActivityDoc> =
  (models.Activity as Model<ActivityDoc>) ?? model<ActivityDoc>("Activity", ActivitySchema);
