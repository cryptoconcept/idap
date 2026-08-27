import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { ALUMNI_CATEGORIES, SHOWCASE_STATUSES } from "@/lib/constants";

const AlumnusSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },

    name: { type: String, required: true, trim: true },
    /**
     * Free text on purpose — "2015" or "2012-2015" — a school describing a
     * cohort as a range is not an error to be normalised away.
     */
    batch: { type: String, trim: true },
    category: { type: String, enum: ALUMNI_CATEGORIES, required: true },
    currentRole: { type: String, trim: true },
    org: { type: String, trim: true },
    /**
     * Storage key, written only by the upload endpoint (Task 7's setPhoto) —
     * never accepted from a create or patch body. Same reasoning as
     * Achievement's photos/certificates.
     */
    photo: { type: String, trim: true },
    note: { type: String, trim: true },

    status: { type: String, enum: SHOWCASE_STATUSES, default: "ACTIVE" },
  },
  { timestamps: true },
);

AlumnusSchema.index({ institutionId: 1, createdAt: -1 });
AlumnusSchema.index({ institutionId: 1, status: 1, category: 1 });

export type AlumnusDoc = InferSchemaType<typeof AlumnusSchema> & { _id: Types.ObjectId };

export const Alumnus: Model<AlumnusDoc> =
  (models.Alumnus as Model<AlumnusDoc>) ?? model<AlumnusDoc>("Alumnus", AlumnusSchema);
