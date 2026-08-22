import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";
import { DOCUMENT_TYPES } from "@/lib/constants";

const DocumentSchema = new Schema(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", required: true, index: true },
    institutionId: { type: String, required: true, index: true },
    documentType: { type: String, enum: DOCUMENT_TYPES, required: true },
    // Always generated, never the name the client sent.
    fileName: { type: String, required: true },
    // Where the bytes live. Large binaries stay in object storage, never in Mongo.
    storageKey: { type: String },
    // External URL for API-supplied documents, or the authenticated read route.
    fileUrl: { type: String, required: true },
    originalFileName: { type: String },
    mimeType: { type: String },
    sizeBytes: { type: Number },
    uploadedAt: { type: Date, default: Date.now },
  },
  { collection: "documents" },
);

export type DocumentRecordDoc = InferSchemaType<typeof DocumentSchema> & { _id: Types.ObjectId };

export const DocumentRecord: Model<DocumentRecordDoc> =
  (models.DocumentRecord as Model<DocumentRecordDoc>) ??
  model<DocumentRecordDoc>("DocumentRecord", DocumentSchema);
