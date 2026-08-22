import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";
import { INSTITUTION_TYPES } from "@/lib/constants";

const InstitutionSchema = new Schema(
  {
    institutionId: { type: String, required: true, unique: true, index: true, trim: true },
    institutionName: { type: String, required: true, trim: true },
    institutionType: { type: String, enum: INSTITUTION_TYPES, required: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    contactPerson: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    website: { type: String, trim: true },
    logoUrl: { type: String, trim: true },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, collection: "institutions" },
);

export type InstitutionDoc = InferSchemaType<typeof InstitutionSchema> & { _id: Types.ObjectId };

export const Institution: Model<InstitutionDoc> =
  (models.Institution as Model<InstitutionDoc>) ?? model<InstitutionDoc>("Institution", InstitutionSchema);
