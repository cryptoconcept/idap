import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { ACHIEVEMENT_CATEGORIES, ACHIEVEMENT_LEVELS, SHOWCASE_STATUSES } from "@/lib/constants";

/**
 * No _id: a student entry is replaced wholesale with the rest of the array on
 * every patch, never addressed individually — unlike Result's TopperSchema,
 * nothing here attaches a photo to one student, only to the achievement as a
 * whole. Same reasoning as Result.ts's BandSchema.
 */
const AchievementStudentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    grade: { type: String, trim: true },
  },
  { _id: false },
);

const AchievementSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },

    category: { type: String, enum: ACHIEVEMENT_CATEGORIES, required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    eventDate: { type: Date },
    level: { type: String, enum: ACHIEVEMENT_LEVELS, default: "SCHOOL" },

    students: { type: [AchievementStudentSchema], default: undefined },
    /**
     * Storage keys, written only by the upload endpoints (Task 7's
     * addPhoto/addCertificate) — never accepted from a create or patch body.
     * Same reasoning as Result's TopperSchema.photoUrl.
     */
    photos: { type: [String], default: undefined },
    certificates: { type: [String], default: undefined },

    status: { type: String, enum: SHOWCASE_STATUSES, default: "ACTIVE" },
  },
  { timestamps: true },
);

AchievementSchema.index({ institutionId: 1, createdAt: -1 });
AchievementSchema.index({ institutionId: 1, status: 1, category: 1 });

export type AchievementDoc = InferSchemaType<typeof AchievementSchema> & { _id: Types.ObjectId };

export const Achievement: Model<AchievementDoc> =
  (models.Achievement as Model<AchievementDoc>) ??
  model<AchievementDoc>("Achievement", AchievementSchema);
