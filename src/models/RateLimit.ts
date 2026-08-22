import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * Fixed-window rate limit counters. Shared across every server instance, unlike
 * an in-process map. Documents self-expire via a TTL index on `expiresAt`.
 */
const RateLimitSchema = new Schema(
  {
    _id: { type: String, required: true },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { collection: "rate_limits", versionKey: false },
);

RateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RateLimitDoc = InferSchemaType<typeof RateLimitSchema>;

export const RateLimit: Model<RateLimitDoc> =
  (models.RateLimit as Model<RateLimitDoc>) ?? model<RateLimitDoc>("RateLimit", RateLimitSchema);
