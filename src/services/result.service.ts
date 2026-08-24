import "server-only";
import { Types } from "mongoose";
import type { z } from "zod";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Result, type ResultDoc } from "@/models";
import { notFound } from "@/lib/api/errors";
import {
  assertPublishable,
  assertResultInvariants,
  type createResultSchema,
  type updateResultSchema,
} from "@/lib/validation/result";
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

export const ResultService = {
  async list(institutionId: string): Promise<ResultDTO[]> {
    await connectToDatabase();
    const rows = await Result.find({ institutionId })
      .sort({ academicYear: -1, createdAt: -1 })
      .lean<ResultDoc[]>();
    return rows.map(serialize);
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

    // Invariants hold against the MERGED record: a patch carrying only `passed`
    // must still be checked against the stored `appeared`.
    const merged = { ...before, ...stripUndefined(patch) };
    assertResultInvariants({
      board: merged.board,
      boardName: merged.boardName,
      appeared: merged.appeared ?? 0,
      passed: merged.passed ?? 0,
      bands: merged.bands,
      toppers: merged.toppers,
    });

    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: stripUndefined(patch) },
      { new: true },
    ).lean<ResultDoc>();
    if (!updated) throw notFound("Result not found");

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
      action: `Result ${action}ed`,
      description: `${updated.board} ${updated.level} ${updated.academicYear}`,
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
