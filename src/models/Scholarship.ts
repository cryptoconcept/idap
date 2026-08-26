import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { SCHOLARSHIP_STATUSES } from "@/lib/constants";

const ScholarshipSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    criteria: { type: String, trim: true },
    /**
     * Free-form on purpose: "Up to ₹50,000", "100% tuition for ranks 1-10".
     * A kind/value pair like Offer's cannot express the eligibility half
     * without losing it, so this is prose the institution controls.
     */
    amount: { type: String, trim: true },
    /**
     * Absent means the scholarship applies institution-wide. No `ref`:
     * nothing here uses Mongoose populate — the service queries the unit
     * directly — and a `ref` would imply an access pattern that does not exist.
     */
    academicUnitId: { type: Schema.Types.ObjectId, index: true },
    status: { type: String, enum: SCHOLARSHIP_STATUSES, default: "DRAFT" },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

ScholarshipSchema.index({ institutionId: 1, createdAt: -1 });
ScholarshipSchema.index({ institutionId: 1, status: 1 });

export type ScholarshipDoc = InferSchemaType<typeof ScholarshipSchema> & { _id: Types.ObjectId };

export const Scholarship: Model<ScholarshipDoc> =
  (models.Scholarship as Model<ScholarshipDoc>) ??
  model<ScholarshipDoc>("Scholarship", ScholarshipSchema);
