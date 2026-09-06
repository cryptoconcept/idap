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
import { ScholarshipPublishService } from "./scholarship-publish.service";

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

    // Task 9: the explicit status action drives the Hub listing. `publish`
    // is the institution's own explicit action — a hard connector error is
    // allowed to surface to the caller, unlike `update`'s `pushEdit`, which
    // never throws. `unpublish`/`archive` withdraw the listing the same way.
    if (action === "publish") {
      await ScholarshipPublishService.publish(institutionId, scholarshipId, actor);
    } else {
      await ScholarshipPublishService.pushClose(institutionId, scholarshipId, actor);
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

    // Task 9: withdraw the Hub listing BEFORE the local row is gone, so a
    // published scholarship never disappears from IDAP while staying live
    // and orphaned on Scholarship Hub. Unlike `update`'s `pushEdit`, this is
    // not wrapped — a hard connector error refuses the delete rather than
    // risk exactly that orphan. Resolves quietly (`NOT_LISTED`) when there
    // is nothing to close.
    await ScholarshipPublishService.pushClose(institutionId, scholarshipId, actor);

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
