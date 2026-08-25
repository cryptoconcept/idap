import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { ACADEMIC_SEGMENTS } from "@/lib/constants";

const AcademicUnitSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    segment: { type: String, enum: ACADEMIC_SEGMENTS, required: true },
    /**
     * Explicit null for a root, never omitted — the unique sibling index has to
     * see one consistent value for "no parent", the same reason `Result.stream`
     * stores an explicit null.
     */
    parentId: { type: Schema.Types.ObjectId, default: null },
    /**
     * Denormalized: validating that a unit is within its blueprint, and
     * rendering it at the right indent, would otherwise both need an ancestor
     * walk on every read.
     */
    depth: { type: Number, required: true, min: 0 },
    name: { type: String, required: true, trim: true },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    /** "PUC 1st Year › PCMB" — denormalized so display never walks ancestors. */
    pathLabel: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

AcademicUnitSchema.index({ institutionId: 1, segment: 1, depth: 1, sortOrder: 1 });

/**
 * Siblings cannot share a name. Enforced by the index rather than a pre-read,
 * which would race two browser tabs into creating both. Names compare as
 * stored — "Grade 1" and "grade 1" are distinct, deliberately: institutions
 * type their own names and normalising case surprises more than it helps.
 */
AcademicUnitSchema.index(
  { institutionId: 1, segment: 1, parentId: 1, name: 1 },
  { unique: true },
);

export type AcademicUnitDoc = InferSchemaType<typeof AcademicUnitSchema> & {
  _id: Types.ObjectId;
};

export const AcademicUnit: Model<AcademicUnitDoc> =
  (models.AcademicUnit as Model<AcademicUnitDoc>) ??
  model<AcademicUnitDoc>("AcademicUnit", AcademicUnitSchema);
