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
  distinction?: number;
  firstClass?: number;
  boys?: { appeared?: number; passed?: number };
  girls?: { appeared?: number; passed?: number };
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
  combinations?: {
    id: string;
    academicUnitId?: string;
    label: string;
    appeared?: number;
    passed?: number;
    distinction?: number;
    firstClass?: number;
    highestScore?: number;
    averageScore?: number;
    grades?: Record<string, number>;
    boys?: { appeared?: number; passed?: number };
    girls?: { appeared?: number; passed?: number };
    toppers?: ResultDTO["toppers"];
  }[];
  placement?: {
    eligible?: number;
    placed?: number;
    highestPackage?: number;
    averagePackage?: number;
    recruiters?: {
      name: string;
      category?: string;
      selected?: number;
      averagePackage?: number;
      tieUp: boolean;
      roles?: string[];
    }[];
  };
  selections?: {
    examCode: string;
    appeared?: number;
    qualified?: number;
    bestRank?: number;
    toppers?: ResultDTO["toppers"];
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

type ExistingTopperDoc = NonNullable<ResultDoc["toppers"]>[number];

function serializeToppers(toppers: ExistingTopperDoc[] | null | undefined): ResultDTO["toppers"] {
  return toppers?.length
    ? toppers.map((topper) => ({
        id: String(topper._id),
        name: topper.name,
        percentage: topper.percentage,
        rank: topper.rank ?? undefined,
        note: topper.note ?? undefined,
        photoUrl: topper.photoUrl ?? undefined,
        consentAcknowledged: topper.consentAcknowledged === true,
      }))
    : undefined;
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
    distinction: row.distinction ?? undefined,
    firstClass: row.firstClass ?? undefined,
    boys: row.boys
      ? { appeared: row.boys.appeared ?? undefined, passed: row.boys.passed ?? undefined }
      : undefined,
    girls: row.girls
      ? { appeared: row.girls.appeared ?? undefined, passed: row.girls.passed ?? undefined }
      : undefined,
    bands: row.bands?.length
      ? row.bands.map((band) => ({
          label: band.label,
          minPercentage: band.minPercentage,
          maxPercentage: band.maxPercentage,
          count: band.count,
        }))
      : undefined,
    toppers: serializeToppers(row.toppers),
    combinations: row.combinations?.length
      ? row.combinations.map((combination) => ({
          id: String(combination._id),
          academicUnitId: combination.academicUnitId
            ? String(combination.academicUnitId)
            : undefined,
          label: combination.label,
          appeared: combination.appeared ?? undefined,
          passed: combination.passed ?? undefined,
          distinction: combination.distinction ?? undefined,
          firstClass: combination.firstClass ?? undefined,
          highestScore: combination.highestScore ?? undefined,
          averageScore: combination.averageScore ?? undefined,
          grades: combination.grades
            ? (combination.grades as unknown as Record<string, number>)
            : undefined,
          boys: combination.boys
            ? { appeared: combination.boys.appeared ?? undefined, passed: combination.boys.passed ?? undefined }
            : undefined,
          girls: combination.girls
            ? { appeared: combination.girls.appeared ?? undefined, passed: combination.girls.passed ?? undefined }
            : undefined,
          toppers: serializeToppers(combination.toppers),
        }))
      : undefined,
    placement: row.placement
      ? {
          eligible: row.placement.eligible ?? undefined,
          placed: row.placement.placed ?? undefined,
          highestPackage: row.placement.highestPackage ?? undefined,
          averagePackage: row.placement.averagePackage ?? undefined,
          recruiters: row.placement.recruiters?.length
            ? row.placement.recruiters.map((recruiter) => ({
                name: recruiter.name,
                category: recruiter.category ?? undefined,
                selected: recruiter.selected ?? undefined,
                averagePackage: recruiter.averagePackage ?? undefined,
                tieUp: recruiter.tieUp === true,
                roles: recruiter.roles?.length ? recruiter.roles : undefined,
              }))
            : undefined,
        }
      : undefined,
    selections: row.selections?.length
      ? row.selections.map((selection) => ({
          examCode: selection.examCode,
          appeared: selection.appeared ?? undefined,
          qualified: selection.qualified ?? undefined,
          bestRank: selection.bestRank ?? undefined,
          toppers: serializeToppers(selection.toppers),
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

/**
 * A topper's `_id` is unique across the whole document regardless of which
 * array holds it — top-level, one combination's, or one selection's. Locates
 * it in all three so the photo endpoint stays unaware of where a topper
 * actually lives; only this function and the write below it need to know.
 */
function locateTopper(
  before: ResultDoc,
  topperId: string,
): { path: "toppers" | `combinations.${number}.toppers` | `selections.${number}.toppers`; topper: ExistingTopperDoc } | null {
  const direct = before.toppers?.find((row) => String(row._id) === topperId);
  if (direct) return { path: "toppers", topper: direct };

  for (let i = 0; i < (before.combinations?.length ?? 0); i += 1) {
    const found = before.combinations?.[i]?.toppers?.find((row) => String(row._id) === topperId);
    if (found) return { path: `combinations.${i}.toppers`, topper: found };
  }

  for (let i = 0; i < (before.selections?.length ?? 0); i += 1) {
    const found = before.selections?.[i]?.toppers?.find((row) => String(row._id) === topperId);
    if (found) return { path: `selections.${i}.toppers`, topper: found };
  }

  return null;
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
      distinction: input.distinction,
      firstClass: input.firstClass,
      boys: input.boys,
      girls: input.girls,
      bands: input.bands,
      toppers: input.toppers,
      combinations: input.combinations,
      placement: input.placement,
      selections: input.selections,
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
    const combinations = patch.combinations
      ? mergeCombinations(patch.combinations, before.combinations)
      : undefined;
    const selections = patch.selections
      ? mergeSelections(patch.selections, before.selections)
      : undefined;

    // Invariants hold against the MERGED record: a patch carrying only `passed`
    // must still be checked against the stored `appeared`. Toppers are checked
    // as merged, so what is validated is exactly what is written.
    const merged = { ...before, ...set };
    assertResultInvariants({
      board: merged.board,
      boardName: merged.boardName,
      appeared: merged.appeared ?? 0,
      passed: merged.passed ?? 0,
      distinction: merged.distinction,
      firstClass: merged.firstClass,
      boys: merged.boys,
      girls: merged.girls,
      bands: merged.bands,
      toppers: toppers ?? merged.toppers,
      combinations: combinations ?? merged.combinations,
      placement: merged.placement,
      selections: selections ?? merged.selections,
    });

    const setPatch: Record<string, unknown> = { ...set };
    if (toppers) setPatch.toppers = toppers;
    if (combinations) setPatch.combinations = combinations;
    if (selections) setPatch.selections = selections;

    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: setPatch },
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

    const located = locateTopper(before, topperId);
    if (!located) throw notFound("Topper not found");
    const { path, topper } = located;

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

    // The top-level filter's `[path]._id` condition is not redundant with
    // arrayFilters: it re-checks, at write time, that this topper is STILL in
    // the array `path` names. Without it, a concurrent edit that removed this
    // topper between the read above and this write would leave arrayFilters
    // matching zero elements while the document itself still matches — a
    // silent no-op that reports success and orphans the blob just stored.
    // With it, that same race makes the WHOLE query fail to match, `updated`
    // comes back null, and the branch below cleans up and reports NOT_FOUND.
    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId, [`${path}._id`]: topper._id },
      { $set: { [`${path}.$[topper].photoUrl`]: stored.key } },
      { new: true, arrayFilters: [{ "topper._id": topper._id }] },
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

    const located = locateTopper(before, topperId);
    if (!located) throw notFound("Topper not found");
    const { path, topper } = located;

    // Same re-check as setTopperPhoto's write, and for the same reason: without
    // `[path]._id` in the top-level filter, a topper removed between the read
    // above and this write would leave arrayFilters matching nothing while the
    // document still matches, silently reporting success on a no-op write.
    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId, [`${path}._id`]: topper._id },
      { $unset: { [`${path}.$[topper].photoUrl`]: "" } },
      { new: true, arrayFilters: [{ "topper._id": topper._id }] },
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

type ExistingCombination = NonNullable<ResultDoc["combinations"]>[number];
type IncomingCombination = NonNullable<UpdateInput["combinations"]>[number];
// Omits BOTH "id" (replaced by "_id") and "toppers" (replaced by the MERGED
// toppers below) — unlike the original MergedTopper, which never needed a
// second omission because a topper does not itself nest another toppers
// array. Omitting only "id" here would leave the UN-merged toppers type still
// present via the Omit, intersected against the merged one below — an
// ambiguous type, not the type this function actually returns.
type MergedCombination = Omit<IncomingCombination, "id" | "toppers"> & {
  _id?: ExistingCombination["_id"];
  toppers?: MergedTopper[];
};

/**
 * The same identity problem `mergeToppers` solves, one level up: a combination
 * nests toppers, so replacing the array wholesale on an edit as small as a
 * corrected label would mint a fresh combination subdocument and, with it,
 * fresh toppers — dropping every photograph underneath. A row naming an
 * existing combination by `id` keeps that combination's `_id`; its own
 * `toppers` field is then merged again, by the SAME `mergeToppers` used at the
 * top level, against whatever that specific combination already had.
 */
function mergeCombinations(
  incoming: IncomingCombination[],
  existing: ResultDoc["combinations"],
): MergedCombination[] {
  const byId = new Map((existing ?? []).map((row) => [String(row._id), row]));

  return incoming.map(({ id, toppers, ...fields }) => {
    const match = id ? byId.get(id) : undefined;
    if (!match) return { ...fields, toppers: toppers ? mergeToppers(toppers, undefined) : undefined };
    byId.delete(id as string);
    return {
      ...fields,
      _id: match._id,
      toppers: toppers ? mergeToppers(toppers, match.toppers) : undefined,
    };
  });
}

type IncomingSelection = NonNullable<UpdateInput["selections"]>[number];
// Same reasoning as MergedCombination above: "toppers" is omitted from the
// source type before being replaced, not merely added alongside it.
type MergedSelection = Omit<IncomingSelection, "toppers"> & { toppers?: MergedTopper[] };

/**
 * Matched by `examCode`, not a synthetic id — an exam code is a stable enum
 * value, never edited into a typo the way a combination's free-text label can
 * be, so no separate handle is needed for it to serve as identity.
 */
function mergeSelections(
  incoming: IncomingSelection[],
  existing: ResultDoc["selections"],
): MergedSelection[] {
  const byCode = new Map((existing ?? []).map((row) => [row.examCode, row]));

  return incoming.map((selection) => {
    const match = byCode.get(selection.examCode);
    // Claimed once, same as mergeToppers/mergeCombinations: two incoming rows
    // must not both inherit one stored selection's toppers. Inert today only
    // because assertResultInvariants already rejects a patch with a duplicate
    // examCode before this merge result is ever written — kept for the same
    // reason its siblings have it, not because it is currently reachable.
    if (match) byCode.delete(selection.examCode);
    return {
      ...selection,
      toppers: selection.toppers
        ? mergeToppers(selection.toppers, match?.toppers)
        : undefined,
    };
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
