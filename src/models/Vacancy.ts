import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import {
  VACANCY_CLAIM_STATES,
  VACANCY_LISTING_CONTRACTS,
  VACANCY_LISTING_REMOTE_STATUSES,
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
        // The id eduFleet dedupes on, stored rather than derived. It STARTS
        // life as the vacancy id and stops being it the first time a closed
        // listing is republished: a closed job keeps its `externalJobId`
        // permanently (no status filter on either the dedupe pre-check or the
        // unique index), so the replacement listing must carry a fresh one.
        // Required, and never defaulted back to the vacancy id, so no code
        // path can silently re-derive the id of a job that is no longer the
        // one this listing points at.
        externalJobId: { type: String, required: true, trim: true },
        contract: { type: String, required: true, enum: VACANCY_LISTING_CONTRACTS },
        lastPushedAt: { type: Date, required: true },
        claimState: { type: String, enum: VACANCY_CLAIM_STATES, default: "unclaimed" },
        // Whether the advert is still visible to teachers on eduFleet, in
        // eduFleet's own vocabulary. `closed` is what tells a later publish to
        // mint a new listing instead of PATCHing fields onto a dead advert and
        // reporting success.
        remoteStatus: {
          type: String,
          enum: VACANCY_LISTING_REMOTE_STATUSES,
          default: "active",
        },
        // The salary pair eduFleet holds after the last successful push.
        // eduFleet re-validates the MERGED record on a PATCH, and a partner
        // update has no way to clear a bound it already stored, so IDAP has to
        // remember what is over there to predict whether the next patch would
        // be rejected. Absent means eduFleet holds no bound.
        remoteSalaryMin: { type: Number, min: 0 },
        remoteSalaryMax: { type: Number, min: 0 },
        // Same reason as the salary pair above, for the third field a partner
        // update can change but never remove (`PartnerJobPatch`/`SchoolJobPatch`
        // declare `experienceRequired?: number`, never `null`, and both routes
        // gate on `!== undefined`). Unlike the bounds it is not needed to
        // predict a rejection — eduFleet cross-validates nothing against it —
        // so this exists purely so IDAP can tell a school the ACTUAL figure
        // their public advert will keep showing when they clear this field
        // here, rather than a vaguer sentence about a number it never
        // recorded.
        remoteExperienceRequired: { type: Number, min: 0 },
        // The advert's own page on eduFleet, exactly as eduFleet reported it
        // when the listing was created. Stored rather than derived because it
        // cannot be derived: the path is `/jobs/{slug}/{id}`, the slug is
        // minted remotely and returned only on the create, and the
        // credential's `baseUrl` is the API host, not necessarily the public
        // site origin. Optional — a listing adopted from a 409 never saw a
        // create response, and no PATCH ever repeats the URL — so every reader
        // must cope with its absence rather than assume a published listing
        // has one. Only ever written from `safePublicUrl` (`edufleet.ts`),
        // which is what keeps a non-http(s) scheme out of a stored value that
        // is rendered as a link.
        publicUrl: { type: String, trim: true },
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
