import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import {
  EXAM_CODES,
  RECRUITER_CATEGORIES,
  RESULT_BOARDS,
  RESULT_LEVELS,
  RESULT_STATUSES,
  RESULT_STREAMS,
} from "@/lib/constants";

/** No _id: bands are replaced wholesale, never addressed individually. */
const BandSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    minPercentage: { type: Number, required: true, min: 0, max: 100 },
    maxPercentage: { type: Number, required: true, min: 0, max: 100 },
    count: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

/** Keeps its _id — the topper photo endpoint addresses toppers by it. */
const TopperSchema = new Schema({
  name: { type: String, required: true, trim: true },
  percentage: { type: Number, required: true, min: 0, max: 100 },
  rank: { type: Number, min: 1 },
  note: { type: String, trim: true },
  /**
   * Written only by the photo upload endpoint, never accepted from a create or
   * patch body. A client-settable media URL is exactly the shape that produced
   * Phase 1's cross-tenant deletion finding.
   */
  photoUrl: { type: String, trim: true },
  consentAcknowledged: { type: Boolean, default: false },
});

/** PassPercent's own fixed bucket scheme, unlike the flexible `bands` above. */
const GradeCountsSchema = new Schema(
  {
    "90+": { type: Number, min: 0, default: 0 },
    "80-90": { type: Number, min: 0, default: 0 },
    "70-80": { type: Number, min: 0, default: 0 },
    "60-70": { type: Number, min: 0, default: 0 },
    "50-60": { type: Number, min: 0, default: 0 },
    below50: { type: Number, min: 0, default: 0 },
  },
  { _id: false },
);

const CohortSplitSchema = new Schema(
  {
    appeared: { type: Number, min: 0 },
    passed: { type: Number, min: 0 },
  },
  { _id: false },
);

/**
 * A branch or combination inside one exam cycle — PUC Science versus Commerce,
 * engineering CSE versus ECE. Keeps its _id (unlike BandSchema): it nests
 * toppers, and an update that cannot tell one combination from another on the
 * next save would mint fresh topper subdocuments and drop every photograph —
 * the same failure TopperSchema.photoUrl's own comment above already names.
 */
const CombinationSchema = new Schema({
  academicUnitId: { type: Schema.Types.ObjectId },
  label: { type: String, required: true, trim: true },
  appeared: { type: Number, min: 0 },
  passed: { type: Number, min: 0 },
  distinction: { type: Number, min: 0, default: 0 },
  firstClass: { type: Number, min: 0, default: 0 },
  highestScore: { type: Number, min: 0, max: 100 },
  averageScore: { type: Number, min: 0, max: 100 },
  grades: GradeCountsSchema,
  boys: CohortSplitSchema,
  girls: CohortSplitSchema,
  toppers: { type: [TopperSchema], default: undefined },
});

/** No photo in this phase — nothing here is server-written, so replacing the
 *  array wholesale on every patch loses nothing, exactly like BandSchema. */
const RecruiterSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: RECRUITER_CATEGORIES },
    selected: { type: Number, min: 0 },
    averagePackage: { type: Number, min: 0 },
    tieUp: { type: Boolean, default: false },
    roles: { type: [String], default: undefined },
  },
  { _id: false },
);

/** Attaches to the whole cycle, not a combination — a college recruits across
 *  branches from one drive. */
const PlacementSchema = new Schema(
  {
    eligible: { type: Number, min: 0 },
    placed: { type: Number, min: 0 },
    highestPackage: { type: Number, min: 0 },
    averagePackage: { type: Number, min: 0 },
    recruiters: { type: [RecruiterSchema], default: undefined },
  },
  { _id: false },
);

/**
 * One competitive-exam outcome for this cycle. No _id: unlike a combination, a
 * selection is matched on update by its `examCode` — a stable enum that can
 * never be edited into a typo the way a free-text label can.
 */
const SelectionSchema = new Schema(
  {
    examCode: { type: String, enum: EXAM_CODES, required: true },
    appeared: { type: Number, min: 0 },
    qualified: { type: Number, min: 0 },
    bestRank: { type: Number, min: 1 },
    toppers: { type: [TopperSchema], default: undefined },
  },
  { _id: false },
);

const ResultSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },

    board: { type: String, enum: RESULT_BOARDS, required: true },
    boardName: { type: String, trim: true },
    level: { type: String, enum: RESULT_LEVELS, required: true },
    /**
     * Stored as an explicit null rather than omitted, so the unique cycle index
     * treats "no stream" as one consistent value across every document.
     */
    stream: { type: String, enum: [...RESULT_STREAMS, null], default: null },
    academicYear: { type: String, required: true, trim: true },
    examLabel: { type: String, trim: true },

    appeared: { type: Number, required: true, min: 0 },
    passed: { type: Number, required: true, min: 0 },
    averageScore: { type: Number, min: 0, max: 100 },
    highestScore: { type: Number, min: 0, max: 100 },

    bands: { type: [BandSchema], default: undefined },
    toppers: { type: [TopperSchema], default: undefined },

    distinction: { type: Number, min: 0, default: 0 },
    firstClass: { type: Number, min: 0, default: 0 },
    boys: CohortSplitSchema,
    girls: CohortSplitSchema,
    combinations: { type: [CombinationSchema], default: undefined },
    placement: { type: PlacementSchema, default: undefined },
    selections: { type: [SelectionSchema], default: undefined },

    status: { type: String, enum: RESULT_STATUSES, default: "DRAFT" },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

ResultSchema.index({ institutionId: 1, createdAt: -1 });
ResultSchema.index({ institutionId: 1, status: 1, academicYear: -1 });

/** One record per exam cycle. Duplicates are refused by the index, not by a pre-read. */
ResultSchema.index(
  { institutionId: 1, board: 1, level: 1, stream: 1, academicYear: 1 },
  { unique: true },
);

/**
 * Serves no query in this phase. It exists so the cross-institution discovery
 * API PassPercent needs is a purely additive change later — no migration, and
 * no index build against a populated collection.
 */
ResultSchema.index({ status: 1, board: 1, level: 1, academicYear: -1 });

export type ResultDoc = InferSchemaType<typeof ResultSchema> & { _id: Types.ObjectId };

export const Result: Model<ResultDoc> =
  (models.Result as Model<ResultDoc>) ?? model<ResultDoc>("Result", ResultSchema);
