import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { AcademicUnit, Institution, Scholarship, type ScholarshipDoc } from "@/models";
import { notFound, validationError } from "@/lib/api/errors";
import { SCHOLARSHIP_MAX_PER_INSTITUTION } from "@/lib/constants";
import {
  assertScholarshipPublishable,
  type CreateScholarshipInput,
  type UpdateScholarshipInput,
} from "@/lib/validation/scholarship";
import { assertOwnedAcademicUnit } from "@/lib/academic/assert-owned";
import { toPublicScholarship, type PublicScholarship } from "@/lib/scholarship/public-projection";
import { ActivityService } from "./activity.service";
// Task 9: one-way dependency, same direction `vacancy.service.ts` already
// takes on `vacancy-publish.service.ts` — `ScholarshipPublishService` must
// never import this file back (see its own docblock).
import {
  ScholarshipPublishService,
  toScholarshipListingDTO,
  type ScholarshipListingDTO,
} from "./scholarship-publish.service";

export type ScholarshipBenefitsDTO = {
  amountMin?: number;
  amountMax?: number;
  stipendMonthly?: number;
  awards?: number;
  tuitionWaiver?: boolean;
};

export type ScholarshipEligibilityDTO = {
  stateCodes?: string[];
  districtCodes?: string[];
  educationLevels?: string[];
  classesOrCourses?: string[];
  streams?: string[];
  genders?: string[];
  ageMin?: number;
  ageMax?: number;
  minPercentage?: number;
  maxAnnualIncome?: number;
  communityCategories?: string[];
  disabilityRequired?: boolean;
  otherCriteria?: string[];
};

export type ScholarshipRequiredDocumentDTO = {
  key: string;
  label: string;
  required?: boolean;
};

export type ScholarshipCustomQuestionDTO = {
  key: string;
  label: string;
  type: string;
  options?: string[];
  required?: boolean;
  helpText?: string;
};

export type ScholarshipDatesDTO = {
  opensAt?: string;
  closesAt?: string;
  resultAt?: string;
};

export type ScholarshipFaqDTO = { q: string; a: string };

export type ScholarshipDTO = {
  id: string;
  name: string;
  criteria?: string;
  amount?: string;
  academicUnitId?: string;
  classOrCourse?: string;
  status: string;
  publishedAt?: string;
  updatedAt?: string;
  // Structured fields for Scholarship Hub syndication (Task 3's model
  // fields, Task 4's validation) — the dashboard editor's read side.
  summary?: string;
  description?: string;
  categories?: string[];
  tags?: string[];
  benefits?: ScholarshipBenefitsDTO;
  eligibility?: ScholarshipEligibilityDTO;
  applicationMode?: string;
  externalUrl?: string;
  requiredDocuments?: ScholarshipRequiredDocumentDTO[];
  customQuestions?: ScholarshipCustomQuestionDTO[];
  applicationSteps?: string[];
  dates?: ScholarshipDatesDTO;
  selectionProcess?: string;
  terms?: string;
  faqs?: ScholarshipFaqDTO[];
  sourceUrl?: string;
  /**
   * What Scholarship Hub knows about this listing, absent until it is
   * published there. This is the DASHBOARD DTO, not the public projection
   * (`toPublicScholarship` below, which deliberately withholds it) — the
   * settings UI needs to show a school whether its listing is live, where to
   * read it, or why the last push was blocked, exactly as `VacancyDTO`
   * exposes its own `listing` for the same reason.
   */
  listing?: ScholarshipListingDTO;
};

/** A row with its label attached. The label is never stored — see `withLabels`. */
type ScholarshipRow = ScholarshipDoc & { classOrCourse?: string };

/** A malformed id must read as "no such scholarship", not as a 500. */
function toObjectId(scholarshipId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(scholarshipId)) throw notFound("Scholarship not found");
  return new Types.ObjectId(scholarshipId);
}

/**
 * Scholarships store a unit id, not a label. Every read path passes its rows
 * through here, which fetches the referenced units in ONE query and attaches
 * each row's `classOrCourse` from the unit's current `pathLabel`.
 *
 * Rows with no `academicUnitId` are institution-wide and get no label at all.
 */
async function withLabels(
  institutionId: string,
  rows: ScholarshipDoc[],
): Promise<ScholarshipRow[]> {
  if (rows.length === 0) return [];

  const unitIds = rows.map((row) => row.academicUnitId).filter(Boolean);
  const units = unitIds.length
    ? await AcademicUnit.find({ _id: { $in: unitIds }, institutionId })
        .select("_id pathLabel")
        .lean<{ _id: Types.ObjectId; pathLabel: string }[]>()
    : [];

  const labelById = new Map(units.map((unit) => [String(unit._id), unit.pathLabel]));

  return rows.map((row) => ({
    ...row,
    classOrCourse: row.academicUnitId ? labelById.get(String(row.academicUnitId)) : undefined,
  }));
}

/** ISO-string a possibly-absent stored Date — same `??`/optional-chaining
 *  convention as every other date field in this file's `serialize`. */
function toIso(date?: Date | null): string | undefined {
  return date ? new Date(date).toISOString() : undefined;
}

/** `undefined` for an absent or empty array, never `[]` — matches
 *  `facilities?.length ? ... : undefined` in `vacancy.service.ts`'s own
 *  serializer, so an empty list and "never set" read identically here too. */
function nonEmpty<T>(values?: T[] | null): T[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

function mapBenefits(benefits?: ScholarshipDoc["benefits"] | null): ScholarshipBenefitsDTO | undefined {
  if (!benefits) return undefined;
  return {
    amountMin: benefits.amountMin ?? undefined,
    amountMax: benefits.amountMax ?? undefined,
    stipendMonthly: benefits.stipendMonthly ?? undefined,
    awards: benefits.awards ?? undefined,
    tuitionWaiver: benefits.tuitionWaiver ?? undefined,
  };
}

function mapEligibility(
  eligibility?: ScholarshipDoc["eligibility"] | null,
): ScholarshipEligibilityDTO | undefined {
  if (!eligibility) return undefined;
  return {
    stateCodes: nonEmpty(eligibility.stateCodes as string[] | undefined),
    districtCodes: nonEmpty(eligibility.districtCodes as string[] | undefined),
    educationLevels: nonEmpty(eligibility.educationLevels as string[] | undefined),
    classesOrCourses: nonEmpty(eligibility.classesOrCourses as string[] | undefined),
    streams: nonEmpty(eligibility.streams as string[] | undefined),
    genders: nonEmpty(eligibility.genders as string[] | undefined),
    ageMin: eligibility.ageMin ?? undefined,
    ageMax: eligibility.ageMax ?? undefined,
    minPercentage: eligibility.minPercentage ?? undefined,
    maxAnnualIncome: eligibility.maxAnnualIncome ?? undefined,
    communityCategories: nonEmpty(eligibility.communityCategories as string[] | undefined),
    disabilityRequired: eligibility.disabilityRequired ?? undefined,
    otherCriteria: nonEmpty(eligibility.otherCriteria as string[] | undefined),
  };
}

function mapDates(dates?: ScholarshipDoc["dates"] | null): ScholarshipDatesDTO | undefined {
  if (!dates) return undefined;
  const opensAt = toIso(dates.opensAt);
  const closesAt = toIso(dates.closesAt);
  const resultAt = toIso(dates.resultAt);
  if (!opensAt && !closesAt && !resultAt) return undefined;
  return { opensAt, closesAt, resultAt };
}

function mapRequiredDocuments(
  docs?: ScholarshipDoc["requiredDocuments"] | null,
): ScholarshipRequiredDocumentDTO[] | undefined {
  return nonEmpty(docs)?.map((doc) => ({
    key: doc.key,
    label: doc.label,
    required: doc.required ?? undefined,
  }));
}

function mapCustomQuestions(
  questions?: ScholarshipDoc["customQuestions"] | null,
): ScholarshipCustomQuestionDTO[] | undefined {
  return nonEmpty(questions)?.map((question) => ({
    key: question.key,
    label: question.label,
    type: question.type,
    options: nonEmpty(question.options as string[] | undefined),
    required: question.required ?? undefined,
    helpText: question.helpText || undefined,
  }));
}

function mapFaqs(faqs?: ScholarshipDoc["faqs"] | null): ScholarshipFaqDTO[] | undefined {
  return nonEmpty(faqs)?.map((faq) => ({ q: faq.q, a: faq.a }));
}

function serialize(row: ScholarshipRow): ScholarshipDTO {
  return {
    id: String(row._id),
    name: row.name,
    criteria: row.criteria || undefined,
    amount: row.amount || undefined,
    academicUnitId: row.academicUnitId ? String(row.academicUnitId) : undefined,
    classOrCourse: row.classOrCourse || undefined,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString(),
    updatedAt: (row as ScholarshipDoc & { updatedAt?: Date }).updatedAt?.toISOString(),
    summary: row.summary || undefined,
    description: row.description || undefined,
    categories: nonEmpty(row.categories as string[] | undefined),
    tags: nonEmpty(row.tags as string[] | undefined),
    benefits: mapBenefits(row.benefits),
    eligibility: mapEligibility(row.eligibility),
    applicationMode: row.applicationMode || undefined,
    externalUrl: row.externalUrl || undefined,
    requiredDocuments: mapRequiredDocuments(row.requiredDocuments),
    customQuestions: mapCustomQuestions(row.customQuestions),
    applicationSteps: nonEmpty(row.applicationSteps as string[] | undefined),
    dates: mapDates(row.dates),
    selectionProcess: row.selectionProcess || undefined,
    terms: row.terms || undefined,
    faqs: mapFaqs(row.faqs),
    sourceUrl: row.sourceUrl || undefined,
    // Built by `scholarship-publish.service.ts`'s own `toScholarshipListingDTO`
    // rather than re-mapped here, so the listing a school reads on its
    // dashboard and the one a push hands back are the same shape by
    // construction — same rationale as `vacancy.service.ts`'s `toListingDTO`.
    listing: row.listing ? toScholarshipListingDTO(row.listing) : undefined,
  };
}

/** Every read is scoped by institutionId, so a foreign id is simply not found. */
async function findOwned(institutionId: string, scholarshipId: string): Promise<ScholarshipDoc> {
  const row = await Scholarship.findOne({
    _id: toObjectId(scholarshipId),
    institutionId,
  }).lean<ScholarshipDoc>();
  if (!row) throw notFound("Scholarship not found");
  return row;
}

/**
 * A key absent from a patch arrives as `undefined` and must be left alone —
 * `$set: { amount: undefined }` would otherwise erase a stored value the
 * caller never mentioned.
 */
function stripUndefined<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

const ACTION_LABELS: Record<"publish" | "unpublish" | "archive", string> = {
  publish: "published",
  unpublish: "unpublished",
  archive: "archived",
};

export const ScholarshipService = {
  async list(institutionId: string): Promise<ScholarshipDTO[]> {
    await connectToDatabase();
    const rows = await Scholarship.find({ institutionId })
      .sort({ createdAt: -1 })
      .lean<ScholarshipDoc[]>();
    return (await withLabels(institutionId, rows)).map(serialize);
  },

  /**
   * Returns null when the institution is not publicly visible at all — the
   * caller turns that into a 404. An empty array means "visible, but nothing
   * published", a 200. The visibility gate matches the profile, results and
   * fees endpoints' exactly, so a scholarship can never be reachable on an
   * institution whose profile 404s.
   */
  async listPublic(query: {
    institutionId?: string;
    slug?: string;
  }): Promise<PublicScholarship[] | null> {
    await connectToDatabase();

    const key = query.institutionId
      ? { institutionId: query.institutionId.toUpperCase() }
      : { slug: (query.slug ?? "").toLowerCase() };

    const institution = await Institution.findOne({
      ...key,
      active: true,
      profileStatus: "PUBLISHED",
    })
      .select("institutionId")
      .lean();
    if (!institution) return null;

    const rows = await Scholarship.find({
      institutionId: institution.institutionId,
      status: "PUBLISHED",
    })
      .sort({ createdAt: -1 })
      .lean<ScholarshipDoc[]>();

    // The projection is the allow-list; it also re-checks PUBLISHED, so a
    // filter mistake here cannot leak an unpublished record.
    return (await withLabels(institution.institutionId, rows))
      .map((row) => toPublicScholarship(row as unknown as Record<string, unknown>))
      .filter((row): row is PublicScholarship => row !== null);
  },

  async get(institutionId: string, scholarshipId: string): Promise<ScholarshipDTO> {
    await connectToDatabase();
    const row = await findOwned(institutionId, scholarshipId);
    const [enriched] = await withLabels(institutionId, [row]);
    return serialize(enriched);
  },

  async create(
    institutionId: string,
    input: CreateScholarshipInput,
    actor: { id: string; name: string },
  ): Promise<ScholarshipDTO> {
    await connectToDatabase();

    const count = await Scholarship.countDocuments({ institutionId });
    if (count >= SCHOLARSHIP_MAX_PER_INSTITUTION) {
      throw validationError(
        `You can keep up to ${SCHOLARSHIP_MAX_PER_INSTITUTION} scholarships. Delete one to add another.`,
      );
    }

    const unit = await assertOwnedAcademicUnit(institutionId, input.academicUnitId);

    const created = await Scholarship.create({ ...input, institutionId, status: "DRAFT" });

    await ActivityService.record({
      institutionId,
      entityType: "SCHOLARSHIP",
      entityId: created._id,
      entityRef: institutionId,
      action: "Scholarship created",
      description: `${input.name} created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize({
      ...(created.toObject() as ScholarshipDoc),
      // Derived inline from the unit already loaded above rather than via
      // `withLabels`, which would re-query it. The two must agree: any change
      // to how `withLabels` builds a label belongs here too, or a create
      // response will disagree with the very next read.
      classOrCourse: unit?.pathLabel,
    });
  },

  async update(
    institutionId: string,
    scholarshipId: string,
    patch: UpdateScholarshipInput,
    actor: { id: string; name: string },
  ): Promise<ScholarshipDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, scholarshipId);

    await assertOwnedAcademicUnit(institutionId, patch.academicUnitId);

    const set = stripUndefined(patch);

    // A published scholarship must stay publishable: a patch that blanks the
    // name would otherwise leave it publicly visible with no name.
    const merged = { ...before, ...set };
    if (before.status === "PUBLISHED") {
      assertScholarshipPublishable({ name: merged.name });
    }

    const updated = await Scholarship.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<ScholarshipDoc>();
    if (!updated) throw notFound("Scholarship not found");
    const [enriched] = await withLabels(institutionId, [updated]);

    await ActivityService.record({
      institutionId,
      entityType: "SCHOLARSHIP",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Scholarship updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    // Task 9: an edit to a published scholarship keeps its Hub listing in
    // step. `pushEdit` never throws — the edit above is already committed,
    // so "your change was saved" must not collapse into "and the push
    // failed"; any failure is recorded on the listing instead.
    if (updated.status === "PUBLISHED") {
      await ScholarshipPublishService.pushEdit(institutionId, scholarshipId, actor);
    }

    return serialize(enriched);
  },

  async setStatus(
    institutionId: string,
    scholarshipId: string,
    action: "publish" | "unpublish" | "archive",
    actor: { id: string; name: string },
  ): Promise<ScholarshipDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, scholarshipId);

    const status = action === "publish" ? "PUBLISHED" : action === "archive" ? "ARCHIVED" : "DRAFT";

    if (action === "publish") {
      assertScholarshipPublishable({ name: before.name });
    }

    const set: Record<string, unknown> = { status };
    // Stamped on first publication and never moved: it records when this
    // scholarship was first made public, not when it was last touched.
    if (action === "publish" && !before.publishedAt) set.publishedAt = new Date();

    const updated = await Scholarship.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<ScholarshipDoc>();
    if (!updated) throw notFound("Scholarship not found");
    const [enriched] = await withLabels(institutionId, [updated]);

    await ActivityService.record({
      institutionId,
      entityType: "SCHOLARSHIP",
      entityId: updated._id,
      entityRef: institutionId,
      action: `Scholarship ${ACTION_LABELS[action]}`,
      description: enriched.name,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    // Fix round 1: the local status change above has already landed —
    // LOCAL scholarship actions are IDAP-owned and must always succeed
    // regardless of Scholarship Hub connection/readiness. Hub syndication
    // from here on is a best-effort side-effect: `publish`/`pushClose`
    // already report "not connected"/"not yet Hub-publishable" as a
    // `SKIPPED` outcome rather than throwing, and this try/catch is the
    // remaining backstop for anything that can still throw once CONNECTED
    // (an unreachable Hub, a spent rate limit, a payload the Hub rejects
    // outright) — none of which may turn "publish"/"unpublish"/"archive"
    // into a failed request. A `BLOCKED` push already gets its reason
    // recorded onto the listing by the orchestrator itself.
    try {
      if (action === "publish") {
        await ScholarshipPublishService.publish(institutionId, scholarshipId, actor);
      } else {
        await ScholarshipPublishService.pushClose(institutionId, scholarshipId, actor);
      }
    } catch {
      // Best-effort: swallowed on purpose — see comment above.
    }

    return serialize(enriched);
  },

  async remove(
    institutionId: string,
    scholarshipId: string,
    actor: { id: string; name: string },
  ): Promise<void> {
    await connectToDatabase();
    const before = await findOwned(institutionId, scholarshipId);

    // Fix round 1: withdraw the Hub listing BEFORE the local row is gone,
    // best-effort — but a withdraw failure must never block the delete.
    // LOCAL scholarship actions are IDAP-owned and must always succeed
    // regardless of Scholarship Hub connection/readiness; `pushClose`
    // already resolves quietly (`NOT_LISTED`/`SKIPPED`) rather than
    // throwing for the ordinary cases, and this try/catch is the backstop
    // for anything else (an unreachable Hub, a spent rate limit). The
    // accepted trade-off: a listing that cannot be withdrawn here (Hub
    // unreachable, or the institution disconnected while still live) may
    // stay live and orphaned on Scholarship Hub after this row is deleted.
    try {
      await ScholarshipPublishService.pushClose(institutionId, scholarshipId, actor);
    } catch {
      // Best-effort: swallowed on purpose — see comment above.
    }

    await Scholarship.deleteOne({ _id: before._id, institutionId });

    await ActivityService.record({
      institutionId,
      entityType: "SCHOLARSHIP",
      entityId: before._id,
      entityRef: institutionId,
      action: "Scholarship deleted",
      description: `${before.name} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },
};
