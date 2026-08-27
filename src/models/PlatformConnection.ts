import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { CONNECTION_STATUSES, PLATFORMS, SYNC_STATUSES } from "@/lib/constants";

const PlatformConnectionSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    platform: { type: String, enum: PLATFORMS, required: true },
    status: { type: String, enum: CONNECTION_STATUSES, default: "PENDING" },
    /** The remote system's own status string, verbatim, for display/debugging. */
    remoteStatus: { type: String, trim: true },
    /** PassPercent's connection-request id, needed to poll and redeem. */
    remoteRequestId: { type: String, trim: true },
    /** What IDAP submitted as its identifier for this institution (institutionId). */
    externalRef: { type: String, required: true, trim: true },
    /** AES-256-GCM ciphertext of the per-institution grant (PassPercent only; FeesBasket holds its grant server-side). */
    grantTokenEncrypted: { type: String, select: false },
    /** Scopes the grant carries, as the platform reported them. */
    scopes: { type: [String], default: undefined },
    /** Snapshot of the remote institution identity, from the redeem/connect response. */
    remoteInstitution: {
      type: new Schema({ name: String, city: String, slug: String }, { _id: false }),
      default: undefined,
    },
    lastSyncAt: { type: Date },
    lastSyncStatus: { type: String, enum: SYNC_STATUSES },
    lastError: { type: String, trim: true },
    /**
     * Atomic sync lock (Task 8). Flipped true by the same
     * `findOneAndUpdate({..., syncInProgress: {$ne: true}}, {$set: {syncInProgress: true}})`
     * that admits exactly one concurrent `syncNow` per connection; cleared in
     * a `finally` regardless of outcome. Added here rather than in Task 2
     * because it exists solely to serve Task 8's lock — see plan ledger
     * Ruling 1.
     */
    syncInProgress: { type: Boolean, default: false },
  },
  { timestamps: true },
);
PlatformConnectionSchema.index({ institutionId: 1, platform: 1 }, { unique: true });

export type PlatformConnectionDoc = InferSchemaType<typeof PlatformConnectionSchema> & {
  _id: Types.ObjectId;
};

export const PlatformConnection: Model<PlatformConnectionDoc> =
  (models.PlatformConnection as Model<PlatformConnectionDoc>) ??
  model<PlatformConnectionDoc>("PlatformConnection", PlatformConnectionSchema);
