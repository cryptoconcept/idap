import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";
import { API_PERMISSIONS } from "@/lib/constants";

const ApiClientSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    keyId: { type: String, required: true, unique: true, index: true },
    // Only the hash is ever persisted; the plaintext secret is shown once.
    secretHash: { type: String, required: true, select: false },
    active: { type: Boolean, default: true },
    permissions: {
      type: [String],
      enum: API_PERMISSIONS,
      default: ["CREATE_LEAD", "CREATE_APPLICATION"],
    },
    allowedOrigins: { type: [String], default: [] },
    lastUsedAt: { type: Date },
    requestCount: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    revokedAt: { type: Date },
  },
  { timestamps: true, collection: "api_clients" },
);

export type ApiClientDoc = InferSchemaType<typeof ApiClientSchema> & { _id: Types.ObjectId };

export const ApiClient: Model<ApiClientDoc> =
  (models.ApiClient as Model<ApiClientDoc>) ?? model<ApiClientDoc>("ApiClient", ApiClientSchema);
