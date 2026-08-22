import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";
import { ENTITY_TYPES } from "@/lib/constants";

const NoteSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    entityType: { type: String, enum: ENTITY_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true, index: true },
    note: { type: String, required: true, trim: true, maxlength: 4000 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdByName: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "notes" },
);

NoteSchema.index({ institutionId: 1, entityType: 1, entityId: 1, createdAt: -1 });

export type NoteDoc = InferSchemaType<typeof NoteSchema> & { _id: Types.ObjectId };

export const Note: Model<NoteDoc> =
  (models.Note as Model<NoteDoc>) ?? model<NoteDoc>("Note", NoteSchema);
