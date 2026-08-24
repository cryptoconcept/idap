import "server-only";
import { Types } from "mongoose";
import type { z } from "zod";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution, Result, type ResultDoc } from "@/models";
import { notFound } from "@/lib/api/errors";
import {
  assertPublishable,
  assertResultInvariants,
  type createResultSchema,
  type updateResultSchema,
} from "@/lib/validation/result";
import { storage } from "@/lib/storage";
import { validateImage } from "@/lib/media/image";
import { isOwnedMediaUrl } from "@/lib/media/ownership";
import { toPublicResult, type PublicResult } from "@/lib/results/public-projection";
import { ActivityService } from "./activity.service";

type CreateInput = z.infer<typeof createResultSchema>;
type UpdateInput = z.infer<typeof updateResultSchema>;

export type ResultDTO = {
  id: string;
  board: string;
  boardName?: string;
  level: string;
  stream: string | null;
  academicYear: string;
  examLabel?: string;
  appeared: number;
  passed: number;
  passPercentage: number | null;
  averageScore?: number;
  highestScore?: number;
  bands?: { label: string; minPercentage: number; maxPercentage: number; count: number }[];
  toppers?: {
    id: string;
    name: string;
    percentage: number;
    rank?: number;
    note?: string;
    photoUrl?: string;
    consentAcknowledged: boolean;
  }[];
  status: string;
  publishedAt?: string;
  updatedAt?: string;
};

/**
 * A malformed id must read as "no such result", not as a 500. Every lookup
 * goes through here so a cast error can never escape as an internal error.
 */
function toObjectId(resultId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(resultId)) throw notFound("Result not found");
  return new Types.ObjectId(resultId);
}

function serialize(row: ResultDoc): ResultDTO {
  const appeared = row.appeared ?? 0;
  const passed = row.passed ?? 0;

  return {
    id: String(row._id),
    board: row.board,
    boardName: row.boardName ?? undefined,
    level: row.level,
    stream: row.stream ?? null,
    academicYear: row.academicYear,
    examLabel: row.examLabel ?? undefined,
    appeared,
    passed,
    passPercentage: appeared > 0 ? Math.round((passed / appeared) * 1000) / 10 : null,
    averageScore: row.averageScore ?? undefined,
    highestScore: row.highestScore ?? undefined,
    bands: row.bands?.length
      ? row.bands.map((band) => ({
          label: band.label,
          minPercentage: band.minPercentage,
          maxPercentage: band.maxPercentage,
          count: band.count,
        }))
      : undefined,
    toppers: row.toppers?.length
      ? row.toppers.map((topper) => ({
          id: String(topper._id),
          name: topper.name,
          percentage: topper.percentage,
          rank: topper.rank ?? undefined,
          note: topper.note ?? undefined,
          photoUrl: topper.photoUrl ?? undefined,
          consentAcknowledged: topper.consentAcknowledged === true,
        }))
      : undefined,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString(),
    updatedAt: (row as ResultDoc & { updatedAt?: Date }).updatedAt?.toISOString(),
  };
}

/** Every read is scoped by institutionId, so a foreign id is simply not found. */
async function findOwned(institutionId: string, resultId: string): Promise<ResultDoc> {
  const row = await Result.findOne({ _id: toObjectId(resultId), institutionId }).lean<ResultDoc>();
  if (!row) throw notFound("Result not found");
  return row;
}

/**
 * Deletes a stored public object only when it provably belongs to this
 * institution. A stored URL can be attacker-influenced, and `deletePublic` is
 * not tenant-scoped, so an unguarded cleanup would delete another tenant's
 * object out of the shared store. A URL that fails the check is left alone —
 * never deleted, and never allowed to block the operation that triggered it.
 */
async function deleteOwnedPhoto(url: string | null | undefined, institutionId: string) {
  if (!isOwnedMediaUrl(url, institutionId)) return;
  await storage.deletePublic(url as string).catch(() => undefined);
}

/** `"archive" + "ed"` reads as "archiveed" — spelled out instead of concatenated. */
const ACTION_LABELS: Record<"publish" | "unpublish" | "archive", string> = {
  publish: "published",
  unpublish: "unpublished",
  archive: "archived",
};

export const ResultService = {
  async list(institutionId: string): Promise<ResultDTO[]> {
    await connectToDatabase();
    const rows = await Result.find({ institutionId })
      .sort({ academicYear: -1, createdAt: -1 })
      .lean<ResultDoc[]>();
    return rows.map(serialize);
  },

  /**
   * Returns null when the institution is not publicly visible at all — the
   * caller turns that into a 404. An empty array means "visible, but nothing
   * published", which is a 200. Keeping the two apart here is what lets the
   * route stay free of a 403 branch.
   *
   * The visibility gate is deliberately identical to the profile endpoint's, so
   * results can never be reachable on an institution whose profile 404s.
   */
  async listPublic(query: {
    institutionId?: string;
    slug?: string;
    academicYear?: string;
    level?: string;
    board?: string;
  }): Promise<PublicResult[] | null> {
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
    if (query.level) filter.level = query.level;
    if (query.board) filter.board = query.board;

    const rows = await Result.find(filter)
      .sort({ academicYear: -1, createdAt: -1 })
      .lean<ResultDoc[]>();

    // The projection is the allow-list; it also re-checks PUBLISHED and drops
    // unconsented toppers, so a filter mistake here cannot leak either.
    return rows
      .map((row) => toPublicResult(row as unknown as Record<string, unknown>))
      .filter((row): row is PublicResult => row !== null);
  },

  async get(institutionId: string, resultId: string): Promise<ResultDTO> {
    await connectToDatabase();
    return serialize(await findOwned(institutionId, resultId));
  },

  async create(
    institutionId: string,
    input: CreateInput,
    actor: { id: string; name: string },
  ): Promise<ResultDTO> {
    await connectToDatabase();

    assertResultInvariants({
      board: input.board,
      boardName: input.boardName,
      appeared: input.appeared,
      passed: input.passed,
      bands: input.bands,
      toppers: input.toppers,
    });

    // Duplicate cycles are refused by the unique index rather than a pre-read:
    // a read-then-write races two browser tabs and creates both.
    const created = await Result.create({ ...input, institutionId, status: "DRAFT" });

    await ActivityService.record({
      institutionId,
      entityType: "RESULT",
      entityId: created._id,
      entityRef: institutionId,
      action: "Result created",
      description: `${input.board} ${input.level} ${input.academicYear} created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(created.toObject() as ResultDoc);
  },

  async update(
    institutionId: string,
    resultId: string,
    patch: UpdateInput,
    actor: { id: string; name: string },
  ): Promise<ResultDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, resultId);

    const set = stripUndefined(patch);
    // A toppers patch still replaces the list — but two of a topper's fields
    // are not the caller's to replace: its `_id`, which the photo endpoint
    // addresses it by, and the `photoUrl` that endpoint wrote. Rows naming an
    // existing topper carry both across; everything else comes from the patch.
    const toppers = patch.toppers ? mergeToppers(patch.toppers, before.toppers) : undefined;

    // Invariants hold against the MERGED record: a patch carrying only `passed`
    // must still be checked against the stored `appeared`. Toppers are checked
    // as merged, so what is validated is exactly what is written.
    const merged = { ...before, ...set };
    assertResultInvariants({
      board: merged.board,
      boardName: merged.boardName,
      appeared: merged.appeared ?? 0,
      passed: merged.passed ?? 0,
      bands: merged.bands,
      toppers: toppers ?? merged.toppers,
    });

    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: toppers ? { ...set, toppers } : set },
      { new: true },
    ).lean<ResultDoc>();
    if (!updated) throw notFound("Result not found");

    // A patched `toppers` list replaces the array wholesale — a row simply
    // absent from it (not merged by id) is a topper the caller deleted, and
    // its photo, if any, is now unreferenced. Only genuinely-gone toppers are
    // cleaned up here; ones `mergeToppers` matched by id keep their photo.
    if (toppers) {
      const kept = new Set(toppers.filter((t) => t._id).map((t) => String(t._id)));
      for (const stale of before.toppers ?? []) {
        if (!kept.has(String(stale._id))) {
          await deleteOwnedPhoto(stale.photoUrl, institutionId);
        }
      }
    }

    await ActivityService.record({
      institutionId,
      entityType: "RESULT",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Result updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },

  async setStatus(
    institutionId: string,
    resultId: string,
    action: "publish" | "unpublish" | "archive",
    actor: { id: string; name: string },
  ): Promise<ResultDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, resultId);

    const status = action === "publish" ? "PUBLISHED" : action === "archive" ? "ARCHIVED" : "DRAFT";

    if (action === "publish") {
      assertPublishable({
        board: before.board,
        boardName: before.boardName,
        appeared: before.appeared ?? 0,
        passed: before.passed ?? 0,
        bands: before.bands,
        toppers: before.toppers,
      });
    }

    const set: Record<string, unknown> = { status };
    // Stamped on first publication and never moved: it records when this cycle
    // was first made public, not when it was last touched.
    if (action === "publish" && !before.publishedAt) set.publishedAt = new Date();

    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<ResultDoc>();
    if (!updated) throw notFound("Result not found");

    await ActivityService.record({
      institutionId,
      entityType: "RESULT",
      entityId: updated._id,
      entityRef: institutionId,
      action: `Result ${ACTION_LABELS[action]}`,
      description: `${updated.board} ${updated.level} ${updated.academicYear}`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },

  async setTopperPhoto(
    institutionId: string,
    resultId: string,
    topperId: string,
    input: { contentType: string; bytes: Buffer },
    actor: { id: string; name: string },
  ): Promise<ResultDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, resultId);

    const topper = before.toppers?.find((row) => String(row._id) === topperId);
    if (!topper) throw notFound("Topper not found");

    const { extension } = validateImage(input);

    // Never derived from a client-supplied filename, and always under the
    // institution's own prefix so isOwnedMediaUrl covers it.
    const objectId = new Types.ObjectId();
    const key = `media/${institutionId}/results/${String(before._id)}/${objectId.toHexString()}${extension}`;
    const stored = await storage.putPublic({
      key,
      body: input.bytes,
      contentType: input.contentType,
    });

    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId, "toppers._id": topper._id },
      { $set: { "toppers.$.photoUrl": stored.key } },
      { new: true },
    ).lean<ResultDoc>();
    if (!updated) {
      await storage.deletePublic(stored.key).catch(() => undefined);
      throw notFound("Result not found");
    }

    await deleteOwnedPhoto(topper.photoUrl, institutionId);

    await ActivityService.record({
      institutionId,
      entityType: "RESULT",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Topper photo updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },

  async removeTopperPhoto(
    institutionId: string,
    resultId: string,
    topperId: string,
    actor: { id: string; name: string },
  ): Promise<ResultDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, resultId);

    const topper = before.toppers?.find((row) => String(row._id) === topperId);
    if (!topper) throw notFound("Topper not found");

    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId, "toppers._id": topper._id },
      { $unset: { "toppers.$.photoUrl": "" } },
      { new: true },
    ).lean<ResultDoc>();
    if (!updated) throw notFound("Result not found");

    await deleteOwnedPhoto(topper.photoUrl, institutionId);

    await ActivityService.record({
      institutionId,
      entityType: "RESULT",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Topper photo removed",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },

  async remove(
    institutionId: string,
    resultId: string,
    actor: { id: string; name: string },
  ): Promise<void> {
    await connectToDatabase();
    const before = await findOwned(institutionId, resultId);

    await Result.deleteOne({ _id: before._id, institutionId });

    for (const topper of before.toppers ?? []) {
      await deleteOwnedPhoto(topper.photoUrl, institutionId);
    }

    await ActivityService.record({
      institutionId,
      entityType: "RESULT",
      entityId: before._id,
      entityRef: institutionId,
      action: "Result deleted",
      description: `${before.board} ${before.level} ${before.academicYear} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },
};

type ExistingTopper = NonNullable<ResultDoc["toppers"]>[number];
type IncomingTopper = NonNullable<UpdateInput["toppers"]>[number];
type MergedTopper = Omit<IncomingTopper, "id"> & {
  _id?: ExistingTopper["_id"];
  photoUrl?: string;
};

/**
 * Bands replace wholesale because a band has no identity to lose. A topper
 * does: the photo endpoint writes `photoUrl` against its `_id`, so replacing
 * the array with the caller's version would mint fresh subdocuments and drop
 * every photograph the institution had uploaded — silently, on an edit as
 * small as a corrected spelling.
 *
 * So a row that names an existing topper by `id` keeps that topper's `_id` and
 * photo; a row with no `id`, or an `id` matching nothing on this result, is a
 * new topper with neither. The caller still cannot set either field: both are
 * read from the stored document, never from the patch.
 */
function mergeToppers(
  incoming: IncomingTopper[],
  existing: ResultDoc["toppers"],
): MergedTopper[] {
  const byId = new Map((existing ?? []).map((topper) => [String(topper._id), topper]));

  return incoming.map(({ id, ...fields }) => {
    const match = id ? byId.get(id) : undefined;
    if (!match) return fields;
    // Claimed once: two rows naming the same topper must not both inherit its
    // identity, which would put two subdocuments with one `_id` in the array.
    byId.delete(id as string);
    return match.photoUrl
      ? { ...fields, _id: match._id, photoUrl: match.photoUrl }
      : { ...fields, _id: match._id };
  });
}

/**
 * A key absent from a patch arrives as `undefined` and must be left alone —
 * `$set: { averageScore: undefined }` would otherwise erase a stored value the
 * caller never mentioned. Arrays replace wholesale; they never merge.
 */
function stripUndefined<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
