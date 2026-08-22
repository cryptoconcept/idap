import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";
import { USER_ROLES } from "@/lib/constants";

const UserSchema = new Schema(
  {
    // Absent for SUPER_ADMIN, required for INSTITUTION_ADMIN.
    institutionId: { type: String, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    // `select: false` keeps the hash out of every query result by default.
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: USER_ROLES, required: true },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
    // Bumped on password change / forced logout so existing tokens stop validating.
    sessionVersion: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "users" },
);

export type UserDoc = InferSchemaType<typeof UserSchema> & { _id: Types.ObjectId };

export const User: Model<UserDoc> =
  (models.User as Model<UserDoc>) ?? model<UserDoc>("User", UserSchema);
