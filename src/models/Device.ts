import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * A push destination. `institutionId` is written from the authenticated session,
 * never from a request body — otherwise a modified client could subscribe itself
 * to another institution's submissions.
 *
 * `deviceId` is the same stable per-installation id the app sends at token
 * issue. It is what lets sign-out drop this installation's registrations
 * without touching the user's other phones: the FCM push token is not known at
 * revoke time, and it rotates, so it cannot serve as that handle.
 */
const DeviceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    institutionId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    pushToken: { type: String, required: true, unique: true, index: true },
    platform: { type: String, enum: ["android", "ios"], required: true },
    lastSeenAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "devices", versionKey: false },
);

export type DeviceDoc = InferSchemaType<typeof DeviceSchema> & { _id: Types.ObjectId };

export const Device: Model<DeviceDoc> =
  (models.Device as Model<DeviceDoc>) ?? model<DeviceDoc>("Device", DeviceSchema);
