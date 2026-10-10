import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { PLATFORMS } from "@/lib/constants";

const PlatformCredentialSchema = new Schema(
  {
    platform: { type: String, enum: PLATFORMS, required: true, unique: true },
    /** AES-256-GCM ciphertext of the platform key (pp_pkey_… / fbk_live_…). */
    keyEncrypted: { type: String, required: true, select: false },
    /** API origin, e.g. https://api.passpercent.in — configurable so dev points at localhost. */
    baseUrl: { type: String, required: true, trim: true },
    /**
     * HMAC signing secret for verifying the Scholarship Hub's inbound
     * `application.changed` webhook (sync-back Plan 2B). AES-256-GCM,
     * same vault as `keyEncrypted`. Absent until the webhook is registered
     * (`PUT /api/partner/webhook` on the Hub, done once during deploy
     * setup) — Task 5's receiver treats its absence as "not configured yet"
     * and 401s, never a 500.
     */
    webhookSecretEncrypted: { type: String, select: false },
    /**
     * Opaque pagination cursor for the reconciliation pull (Task 4) — one
     * platform-wide stream, since the Hub's partner API is partner-scoped,
     * not institution-scoped. Treated as opaque everywhere except Task 4's
     * own documented, flagged construction of one from a known item.
     */
    applicationsSyncCursor: { type: String },
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
