import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * One row per issued refresh token. Tokens are single-use: rotating one marks it
 * consumed and issues its successor in the same family. A family is the chain of
 * tokens belonging to one device login, so a detected reuse can revoke all of it.
 */
const RefreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    familyId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    consumedAt: { type: Date },
    revokedAt: { type: Date },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "refresh_tokens", versionKey: false },
);

// Expired rows are reaped automatically rather than accumulating forever.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshTokenDoc = InferSchemaType<typeof RefreshTokenSchema> & {
  _id: Types.ObjectId;
};

export const RefreshToken: Model<RefreshTokenDoc> =
  (models.RefreshToken as Model<RefreshTokenDoc>) ??
  model<RefreshTokenDoc>("RefreshToken", RefreshTokenSchema);
