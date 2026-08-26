import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { OFFER_KINDS, OFFER_STATUSES } from "@/lib/constants";

const OfferSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    kind: { type: String, enum: OFFER_KINDS, required: true },
    /** Percent (0-100) when kind is PERCENTAGE; rupees (>= 0) when FLAT. */
    value: { type: Number, required: true, min: 0 },
    /**
     * Published as text and never validated or counted — IDAP has no student
     * accounts, so there is no identity to redeem against. The institution
     * honours it offline.
     */
    code: { type: String, trim: true },
    /** Absent means the offer applies institution-wide. No `ref` — see Scholarship. */
    academicUnitId: { type: Schema.Types.ObjectId, index: true },
    validFrom: { type: Date },
    /** Absent means the offer never expires. See the service's listPublic filter. */
    validUntil: { type: Date },
    status: { type: String, enum: OFFER_STATUSES, default: "DRAFT" },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

OfferSchema.index({ institutionId: 1, createdAt: -1 });
OfferSchema.index({ institutionId: 1, status: 1, validUntil: 1 });

export type OfferDoc = InferSchemaType<typeof OfferSchema> & { _id: Types.ObjectId };

export const Offer: Model<OfferDoc> =
  (models.Offer as Model<OfferDoc>) ?? model<OfferDoc>("Offer", OfferSchema);
