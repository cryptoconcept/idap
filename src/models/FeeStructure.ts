import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { FEE_FREQUENCIES, FEE_STRUCTURE_STATUSES } from "@/lib/constants";

/**
 * No `_id`: a line item has no identity of its own — nothing (no photo, no
 * separate endpoint) ever addresses one individually, so the whole array
 * replaces wholesale on every write, the same way `Result.bands` does.
 */
const FeeLineItemSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    frequency: { type: String, enum: FEE_FREQUENCIES, required: true },
    optional: { type: Boolean, default: false },
  },
  { _id: false },
);

const FeeStructureSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    /**
     * The academic unit this prices. No `ref`: nothing here uses Mongoose
     * `populate`, and the service's enrichment helper queries the model
     * directly — a `ref` would imply an access pattern that does not exist.
     */
    academicUnitId: { type: Schema.Types.ObjectId, required: true, index: true },
    academicYear: { type: String, required: true, trim: true },

    lineItems: { type: [FeeLineItemSchema], default: undefined },

    status: { type: String, enum: FEE_STRUCTURE_STATUSES, default: "DRAFT" },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

FeeStructureSchema.index({ institutionId: 1, createdAt: -1 });
FeeStructureSchema.index({ institutionId: 1, status: 1, academicYear: -1 });

/** One fee structure per unit per academic year. Refused by the index, not a pre-read. */
FeeStructureSchema.index(
  { institutionId: 1, academicUnitId: 1, academicYear: 1 },
  { unique: true },
);

export type FeeStructureDoc = InferSchemaType<typeof FeeStructureSchema> & { _id: Types.ObjectId };

export const FeeStructure: Model<FeeStructureDoc> =
  (models.FeeStructure as Model<FeeStructureDoc>) ?? model<FeeStructureDoc>("FeeStructure", FeeStructureSchema);
