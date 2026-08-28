import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import {
  VACANCY_CLAIM_STATES,
  VACANCY_LISTING_CONTRACTS,
  VACANCY_STATUSES,
  VACANCY_SUBJECTS,
} from "@/lib/constants";

const VacancySchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    subject: { type: String, required: true, enum: VACANCY_SUBJECTS },
    description: { type: String, required: true, trim: true },
    salaryMin: { type: Number, min: 0 },
    salaryMax: { type: Number, min: 0 },
    experienceRequired: { type: Number, min: 0 },
    facilities: { type: [String], default: undefined },
    status: { type: String, enum: VACANCY_STATUSES, default: "DRAFT" },
    listing: {
      type: {
        jobId: { type: String, required: true, trim: true },
        contract: { type: String, required: true, enum: VACANCY_LISTING_CONTRACTS },
        lastPushedAt: { type: Date, required: true },
        claimState: { type: String, enum: VACANCY_CLAIM_STATES, default: "unclaimed" },
        // Why a push is currently refused, when eduFleet answers 403. Free
        // text because two of the four triggers are reversible and IDAP
        // re-checks rather than latching — see the Global Constraints.
        blockedReason: { type: String, trim: true },
      },
      default: undefined,
      _id: false,
    },
  },
  { timestamps: true },
);

VacancySchema.index({ institutionId: 1, createdAt: -1 });
VacancySchema.index({ institutionId: 1, status: 1 });

export type VacancyDoc = InferSchemaType<typeof VacancySchema> & { _id: Types.ObjectId };

export const Vacancy: Model<VacancyDoc> =
  (models.Vacancy as Model<VacancyDoc>) ?? model<VacancyDoc>("Vacancy", VacancySchema);
