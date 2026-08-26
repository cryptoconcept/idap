import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { PLATFORMS } from "@/lib/constants";

const PlatformCredentialSchema = new Schema(
  {
    platform: { type: String, enum: PLATFORMS, required: true, unique: true },
    /** AES-256-GCM ciphertext of the platform key (pp_pkey_… / fbk_live_…). */
    keyEncrypted: { type: String, required: true, select: false },
    /** API origin, e.g. https://api.passpercent.in — configurable so dev points at localhost. */
    baseUrl: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type PlatformCredentialDoc = InferSchemaType<typeof PlatformCredentialSchema> & {
  _id: Types.ObjectId;
};

export const PlatformCredential: Model<PlatformCredentialDoc> =
  (models.PlatformCredential as Model<PlatformCredentialDoc>) ??
  model<PlatformCredentialDoc>("PlatformCredential", PlatformCredentialSchema);
