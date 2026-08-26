import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { PLATFORMS, SYNC_STATUSES } from "@/lib/constants";

const SyncRunSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    platform: { type: String, enum: PLATFORMS, required: true },
    trigger: { type: String, enum: ["MANUAL"], default: "MANUAL" },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    status: { type: String, enum: SYNC_STATUSES, required: true },
    /** One entry per push step: { step, ok, detail } — "profile", "results:2025-26", … */
    steps: {
      type: [new Schema({ step: String, ok: Boolean, detail: String }, { _id: false })],
      default: undefined,
    },
    /** Mapping losses the admin should know about: unmapped streams, skipped toppers, dropped enum values. */
    warnings: { type: [String], default: undefined },
    error: { type: String, trim: true },
  },
  { timestamps: true },
);
SyncRunSchema.index({ institutionId: 1, platform: 1, createdAt: -1 });

export type SyncRunDoc = InferSchemaType<typeof SyncRunSchema> & { _id: Types.ObjectId };

export const SyncRun: Model<SyncRunDoc> =
  (models.SyncRun as Model<SyncRunDoc>) ?? model<SyncRunDoc>("SyncRun", SyncRunSchema);
