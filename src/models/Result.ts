import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { RESULT_BOARDS, RESULT_LEVELS, RESULT_STATUSES, RESULT_STREAMS } from "@/lib/constants";

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
