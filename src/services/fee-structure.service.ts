import "server-only";
import { Types } from "mongoose";
import type { z } from "zod";
import { connectToDatabase } from "@/lib/db/mongoose";
import { AcademicUnit, FeeStructure, Institution, type FeeStructureDoc } from "@/models";
import { notFound } from "@/lib/api/errors";
import {
  assertFeeStructureInvariants,
  assertFeeStructurePublishable,
  type BulkCreateFeeInput,
  type createFeeStructureSchema,
  type updateFeeStructureSchema,
} from "@/lib/validation/fee-structure";
import { toPublicFeeStructure, type PublicFeeStructure } from "@/lib/fee-structure/public-projection";
import { ActivityService } from "./activity.service";

type CreateInput = z.infer<typeof createFeeStructureSchema>;
type UpdateInput = z.infer<typeof updateFeeStructureSchema>;

export type FeeStructureDTO = {
  id: string;
  academicUnitId: string;
  classOrCourse: string;
  academicYear: string;
  lineItems?: { label: string; amount: number; frequency: string; optional: boolean }[];
  status: string;
  publishedAt?: string;
  updatedAt?: string;
};

export type FeeHeadDTO = { label: string; amount?: number; frequency?: string };

/** A malformed id must read as "no such fee structure", not as a 500. */
function toObjectId(feeStructureId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(feeStructureId)) throw notFound("Fee structure not found");
  return new Types.ObjectId(feeStructureId);
}

/** A row with its label attached. The label is never stored — see `withLabels`. */
type FeeStructureRow = FeeStructureDoc & { classOrCourse: string };

/** A malformed unit id must read as "no such unit", not as a 500. */
function unitObjectId(academicUnitId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(academicUnitId)) throw notFound("Academic unit not found");
  return new Types.ObjectId(academicUnitId);
}

/**
 * Fee structures store a unit id, not a label. Every read path passes its rows
 * through here, which fetches the referenced units in ONE query and attaches each
 * row's `classOrCourse` from the unit's current `pathLabel`.
 *
 * Deriving rather than storing is what makes renaming a branch fix every fee
 * structure beneath it on the next read, with no cascade to maintain.
 */
async function withLabels(
  institutionId: string,
  rows: FeeStructureDoc[],
): Promise<FeeStructureRow[]> {
  if (rows.length === 0) return [];

  const units = await AcademicUnit.find({
    _id: { $in: rows.map((row) => row.academicUnitId) },
    institutionId,
  })
    .select("_id pathLabel")
    .lean<{ _id: Types.ObjectId; pathLabel: string }[]>();

  const labelById = new Map(units.map((unit) => [String(unit._id), unit.pathLabel]));

  return rows.map((row) => ({
    ...row,
    // A referenced unit cannot be missing while the delete guard holds. An empty
    // string keeps the DTO honest, and the public projection's `text()` drops an
    // empty value rather than publishing one.
    classOrCourse: labelById.get(String(row.academicUnitId)) ?? "",
  }));
}

/** Newest year first, then by the label a reader actually sees. */
function byYearThenLabel(a: FeeStructureRow, b: FeeStructureRow): number {
  if (a.academicYear !== b.academicYear) return b.academicYear.localeCompare(a.academicYear);
  return a.classOrCourse.localeCompare(b.classOrCourse);
}

/** How many removed structures a bulk-delete activity entry names individually. */
const REMOVED_SUMMARY_MAX = 5;

/**
 * Fee structures are hard-deleted, so a bulk delete's activity entry is the
 * only surviving record of what was removed — unlike the single-row `remove`,
 * which names the one structure it took. Naming all of them here too would
 * work for ten rows and produce an unreadable wall of text for a hundred, so
 * this names the academic year(s) touched, the total count, and up to
 * `REMOVED_SUMMARY_MAX` labels, then summarises the rest as "and N more".
 */
function summarizeRemoved(rows: FeeStructureRow[]): string {
  const sorted = [...rows].sort(byYearThenLabel);
  const years = Array.from(new Set(sorted.map((row) => row.academicYear))).sort();
  const named = sorted
    .slice(0, REMOVED_SUMMARY_MAX)
    .map((row) => `${row.classOrCourse} ${row.academicYear}`);
  const remaining = sorted.length - named.length;

  const list = remaining > 0 ? `${named.join(", ")} and ${remaining} more` : named.join(", ");
  return `${sorted.length} deleted for ${years.join(", ")}: ${list}`;
}

function serialize(row: FeeStructureRow): FeeStructureDTO {
  return {
    id: String(row._id),
    academicUnitId: String(row.academicUnitId),
    classOrCourse: row.classOrCourse,
    academicYear: row.academicYear,
    lineItems: row.lineItems?.length
      ? row.lineItems.map((item) => ({
          label: item.label,
          amount: item.amount,
          frequency: item.frequency,
          optional: item.optional === true,
        }))
      : undefined,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString(),
    updatedAt: (row as FeeStructureDoc & { updatedAt?: Date }).updatedAt?.toISOString(),
  };
}

/** Every read is scoped by institutionId, so a foreign id is simply not found. */
async function findOwned(institutionId: string, feeStructureId: string): Promise<FeeStructureDoc> {
  const row = await FeeStructure.findOne({
    _id: toObjectId(feeStructureId),
    institutionId,
  }).lean<FeeStructureDoc>();
  if (!row) throw notFound("Fee structure not found");
  return row;
}

/**
 * A key absent from a patch arrives as `undefined` and must be left alone —
 * `$set: { academicYear: undefined }` would otherwise erase a stored value
 * the caller never mentioned.
 */
function stripUndefined<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** `"archive" + "ed"` reads as "archiveed" — spelled out instead of concatenated. */
const ACTION_LABELS: Record<"publish" | "unpublish" | "archive", string> = {
  publish: "published",
  unpublish: "unpublished",
  archive: "archived",
};

export const FeeStructureService = {
  async list(institutionId: string): Promise<FeeStructureDTO[]> {
    await connectToDatabase();
    const rows = await FeeStructure.find({ institutionId }).lean<FeeStructureDoc[]>();
    // Sorted in memory: the database cannot sort by a label that lives on another
    // collection, and a $lookup is disproportionate for tens of rows.
    return (await withLabels(institutionId, rows)).sort(byYearThenLabel).map(serialize);
  },

  /**
   * Returns null when the institution is not publicly visible at all — the
   * caller turns that into a 404. An empty array means "visible, but nothing
   * published", a 200. The visibility gate matches the profile and results
   * endpoints' exactly, so a fee structure can never be reachable on an
   * institution whose profile 404s.
   */
  async listPublic(query: {
    institutionId?: string;
    slug?: string;
    academicYear?: string;
  }): Promise<PublicFeeStructure[] | null> {
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

    const filter: Record<string, unknown> = {
      institutionId: institution.institutionId,
      status: "PUBLISHED",
    };
    if (query.academicYear) filter.academicYear = query.academicYear;

    const rows = await FeeStructure.find(filter).lean<FeeStructureDoc[]>();

    // The projection is the allow-list; it also re-checks PUBLISHED, so a
    // filter mistake here cannot leak an unpublished record.
    return (await withLabels(institution.institutionId, rows))
      .sort(byYearThenLabel)
      .map((row) => toPublicFeeStructure(row as unknown as Record<string, unknown>))
      .filter((row): row is PublicFeeStructure => row !== null);
  },

  async get(institutionId: string, feeStructureId: string): Promise<FeeStructureDTO> {
    await connectToDatabase();
    const row = await findOwned(institutionId, feeStructureId);
    const [enriched] = await withLabels(institutionId, [row]);
    return serialize(enriched);
  },

  async create(
    institutionId: string,
    input: CreateInput,
    actor: { id: string; name: string },
  ): Promise<FeeStructureDTO> {
    await connectToDatabase();

    assertFeeStructureInvariants({ lineItems: input.lineItems });

    // Scoped by institutionId, so another institution's unit is "no such unit" —
    // NOT_FOUND, never FORBIDDEN.
    const unit = await AcademicUnit.findOne({
      _id: unitObjectId(input.academicUnitId),
      institutionId,
    })
      .select("_id pathLabel")
      .lean();
    if (!unit) throw notFound("Academic unit not found");

    // Duplicate (academicUnitId, academicYear) is refused by the unique index
    // rather than a pre-read: a read-then-write races two browser tabs and
    // creates both.
    const created = await FeeStructure.create({ ...input, institutionId, status: "DRAFT" });

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityId: created._id,
      entityRef: institutionId,
      action: "Fee structure created",
      description: `${unit.pathLabel} ${input.academicYear} created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize({
      ...(created.toObject() as FeeStructureDoc),
      // Derived inline from the unit already loaded above rather than via
      // `withLabels`, which would re-query it. The two must agree: any change to
      // how `withLabels` builds a label belongs here too, or a create response
      // will disagree with the very next read.
      classOrCourse: unit.pathLabel,
    });
  },

  async createMany(
    institutionId: string,
    input: BulkCreateFeeInput,
    actor: { id: string; name: string },
  ): Promise<{ created: number; skipped: { academicUnitId: string; classOrCourse: string }[] }> {
    await connectToDatabase();

    // Checked once on the shared set, before anything is written: every structure in
    // the batch gets identical line items, so a per-unit check would repeat the same
    // work N times and could half-apply the batch.
    assertFeeStructureInvariants({ lineItems: input.lineItems });

    const ids = input.academicUnitIds.map(unitObjectId);
    const units = await AcademicUnit.find({ _id: { $in: ids }, institutionId })
      .select("_id pathLabel")
      .lean<{ _id: Types.ObjectId; pathLabel: string }[]>();

    // A foreign or nonexistent unit fails the WHOLE batch, before any write. That is
    // deliberately different from an already-priced unit, which is skipped below: the
    // first is a caller bug, the second is the expected outcome of bulk work.
    if (units.length !== ids.length) throw notFound("Academic unit not found");

    const existing = await FeeStructure.find({
      institutionId,
      academicUnitId: { $in: ids },
      academicYear: input.academicYear,
    })
      .select("academicUnitId")
      .lean<{ academicUnitId: Types.ObjectId }[]>();
    const taken = new Set(existing.map((row) => String(row.academicUnitId)));

    const skipped = units
      .filter((unit) => taken.has(String(unit._id)))
      .map((unit) => ({ academicUnitId: String(unit._id), classOrCourse: unit.pathLabel }));
    const fresh = units.filter((unit) => !taken.has(String(unit._id)));

    // Counted from what the database actually inserted (below), never from
    // `fresh.length` — that would only be true because `insertMany` used to be
    // ordered and threw before this point was ever reached.
    let created = 0;

    if (fresh.length > 0) {
      try {
        // Unordered: a duplicate key at document k must not cost documents k+1..n
        // the rest of the batch. `existing` was read moments ago, not inside a
        // transaction (the test harness's standalone mongod cannot start one, and
        // this repo has none in production either), so another request racing
        // between that read and this write can already hold one of these units —
        // ordered:true would half-apply the batch on that single collision.
        // `throwOnValidationError` keeps a genuine per-document validation failure
        // from vanishing with no signal at all: the driver-error branch below only
        // ever reports duplicate-key failures, so without this a validation error
        // would just be dropped, uncounted as both created and skipped.
        const inserted = await FeeStructure.insertMany(
          fresh.map((unit) => ({
            institutionId,
            academicUnitId: unit._id,
            academicYear: input.academicYear,
            lineItems: input.lineItems,
            status: "DRAFT",
          })),
          { ordered: false, throwOnValidationError: true },
        );
        created = inserted.length;
      } catch (err) {
        // Verified against the installed mongoose@8.24.3 (see task report): under
        // `ordered: false`, a duplicate-key bulk-write error's `writeErrors` is an
        // array of `{ index, err: { code, ... } }` — the code lives one level down,
        // under `.err`, not on the entry itself — and `insertedDocs` holds the
        // Mongoose documents that DID make it into the database. `index` is the
        // position in the array passed to `insertMany`, i.e. an index into `fresh`.
        const writeErrors = (
          err as { writeErrors?: { index: number; err?: { code?: number } }[] }
        ).writeErrors;

        // Every write error must be a duplicate key for this to be "someone else
        // priced it first" — a raced insert of the same unit is exactly what this
        // feature already calls skipped. Anything else (a real validation failure,
        // a dropped connection, anything not code 11000) is a genuine failure and
        // must propagate rather than being read as a batch of skips.
        // COUPLING, and it leaves no evidence if it ever breaks: this branch can
        // only report duplicate-key failures. Mongoose filters a document that
        // fails schema validation OUT of the batch before the driver sees it, and
        // the resulting error carries no trace of it — `validationErrors` is only
        // attached under `rawResult: true`, which this call does not pass. So a
        // batch containing BOTH a validation failure and a raced duplicate would
        // pass the check below and drop the invalid document silently.
        //
        // That is unreachable today, and only for a reason that is easy to undo:
        // every document here is byte-identical except `academicUnitId`, which
        // comes from a `.lean()` read rather than user input, and `FeeStructure`
        // has no per-document validators — so validation is all-or-nothing for the
        // batch. Introduce any per-document field (per-unit line-item overrides, a
        // validator keyed on unit type) and this stops being true, with no failing
        // test and no error to notice. Re-check this branch if that ever changes.
        const allDuplicates =
          Array.isArray(writeErrors) &&
          writeErrors.length > 0 &&
          writeErrors.every((writeError) => writeError.err?.code === 11000);
        if (!allDuplicates) throw err;

        created = (err as { insertedDocs?: unknown[] }).insertedDocs?.length ?? 0;

        for (const writeError of writeErrors) {
          const unit = fresh[writeError.index];
          if (unit) {
            skipped.push({ academicUnitId: String(unit._id), classOrCourse: unit.pathLabel });
          }
        }
      }
    }

    // One entry for the batch, not one per structure — an audit trail with sixty
    // identical lines is harder to read than one that says what happened.
    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityRef: institutionId,
      action: "Fee structures created in bulk",
      description: `${created} created, ${skipped.length} skipped for ${input.academicYear}`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return { created, skipped };
  },

  async update(
    institutionId: string,
    feeStructureId: string,
    patch: UpdateInput,
    actor: { id: string; name: string },
  ): Promise<FeeStructureDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, feeStructureId);

    const set = stripUndefined(patch);

    // Invariants hold against the MERGED record: a patch carrying only one
    // new line item must still be checked against the whole stored list. A
    // PUBLISHED record must keep satisfying the publish gate on every edit —
    // otherwise a PATCH could empty a live fee structure's line items while
    // leaving it publicly visible with nothing in it.
    const merged = { ...before, ...set };
    if (before.status === "PUBLISHED") {
      assertFeeStructurePublishable({ lineItems: merged.lineItems });
    } else {
      assertFeeStructureInvariants({ lineItems: merged.lineItems });
    }

    const updated = await FeeStructure.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<FeeStructureDoc>();
    if (!updated) throw notFound("Fee structure not found");
    const [enriched] = await withLabels(institutionId, [updated]);

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Fee structure updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(enriched);
  },

  async setStatus(
    institutionId: string,
    feeStructureId: string,
    action: "publish" | "unpublish" | "archive",
    actor: { id: string; name: string },
  ): Promise<FeeStructureDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, feeStructureId);

    const status = action === "publish" ? "PUBLISHED" : action === "archive" ? "ARCHIVED" : "DRAFT";

    if (action === "publish") {
      assertFeeStructurePublishable({ lineItems: before.lineItems });
    }

    const set: Record<string, unknown> = { status };
    // Stamped on first publication and never moved: it records when this
    // structure was first made public, not when it was last touched.
    if (action === "publish" && !before.publishedAt) set.publishedAt = new Date();

    const updated = await FeeStructure.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<FeeStructureDoc>();
    if (!updated) throw notFound("Fee structure not found");
    const [enriched] = await withLabels(institutionId, [updated]);

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityId: updated._id,
      entityRef: institutionId,
      action: `Fee structure ${ACTION_LABELS[action]}`,
      description: `${enriched.classOrCourse} ${enriched.academicYear}`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(enriched);
  },

  async remove(
    institutionId: string,
    feeStructureId: string,
    actor: { id: string; name: string },
  ): Promise<void> {
    await connectToDatabase();
    const before = await findOwned(institutionId, feeStructureId);
    const [enriched] = await withLabels(institutionId, [before]);

    await FeeStructure.deleteOne({ _id: before._id, institutionId });

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityId: before._id,
      entityRef: institutionId,
      action: "Fee structure deleted",
      description: `${enriched.classOrCourse} ${enriched.academicYear} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },

  async removeMany(
    institutionId: string,
    feeStructureIds: string[],
    actor: { id: string; name: string },
  ): Promise<{ deleted: number }> {
    await connectToDatabase();
    const ids = feeStructureIds.map(toObjectId);

    // Ownership is verified BEFORE anything is deleted, via a `find` rather
    // than the bare `countDocuments` this used to be — the rows are needed
    // below to describe what gets removed, and `owned.length !== ids.length`
    // catches a foreign id exactly as the count comparison did. A scoped
    // `deleteMany` alone would remove nothing for a foreign id and report a
    // lower count — succeeding silently where a foreign id must fail the
    // batch. This check is load-bearing; do not weaken it back to a length
    // check on the delete result.
    const owned = await FeeStructure.find({ _id: { $in: ids }, institutionId }).lean<
      FeeStructureDoc[]
    >();
    if (owned.length !== ids.length) throw notFound("Fee structure not found");

    const result = await FeeStructure.deleteMany({ _id: { $in: ids }, institutionId });

    // Labelled the same way every read path is — see `withLabels` — so a
    // hard-deleted batch still leaves a description naming what it removed,
    // not just how many.
    const removed = await withLabels(institutionId, owned);

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityRef: institutionId,
      action: "Fee structures deleted in bulk",
      description: summarizeRemoved(removed),
      performedBy: actor.id,
      performedByName: actor.name,
    });

    // The count the database actually removed, never the length of the id
    // list — reporting an intended count is how a scoping regression hides.
    return { deleted: result.deletedCount };
  },

  async getFeeHeads(institutionId: string): Promise<FeeHeadDTO[]> {
    await connectToDatabase();
    const institution = await Institution.findOne({ institutionId })
      .select("feeHeads")
      .lean();
    if (!institution) throw notFound("Institution not found");

    return (institution.feeHeads ?? []).map((head) => ({
      label: head.label,
      amount: head.amount ?? undefined,
      frequency: head.frequency ?? undefined,
    }));
  },

  async setFeeHeads(
    institutionId: string,
    feeHeads: FeeHeadDTO[],
    actor: { id: string; name: string },
  ): Promise<FeeHeadDTO[]> {
    await connectToDatabase();

    // Replaced wholesale, like every other array on this document.
    const updated = await Institution.findOneAndUpdate(
      { institutionId },
      { $set: { feeHeads } },
      { new: true },
    )
      .select("feeHeads")
      .lean();
    if (!updated) throw notFound("Institution not found");

    await ActivityService.record({
      institutionId,
      entityType: "FEE_HEAD",
      entityRef: institutionId,
      action: "Fee heads updated",
      // The database's own array, not the input's — identical by construction
      // today, but a count must reflect what was actually persisted, not what
      // was requested.
      description: `${(updated.feeHeads ?? []).length} head(s)`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return (updated.feeHeads ?? []).map((head) => ({
      label: head.label,
      amount: head.amount ?? undefined,
      frequency: head.frequency ?? undefined,
    }));
  },
};
