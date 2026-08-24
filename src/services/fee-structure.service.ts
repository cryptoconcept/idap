import "server-only";
import { Types } from "mongoose";
import type { z } from "zod";
import { connectToDatabase } from "@/lib/db/mongoose";
import { FeeStructure, type FeeStructureDoc } from "@/models";
import { notFound } from "@/lib/api/errors";
import {
  assertFeeStructureInvariants,
  assertFeeStructurePublishable,
  type createFeeStructureSchema,
  type updateFeeStructureSchema,
} from "@/lib/validation/fee-structure";
import { ActivityService } from "./activity.service";

type CreateInput = z.infer<typeof createFeeStructureSchema>;
type UpdateInput = z.infer<typeof updateFeeStructureSchema>;

export type FeeStructureDTO = {
  id: string;
  classOrCourse: string;
  academicYear: string;
  lineItems?: { label: string; amount: number; frequency: string; optional: boolean }[];
  status: string;
  publishedAt?: string;
  updatedAt?: string;
};

/** A malformed id must read as "no such fee structure", not as a 500. */
function toObjectId(feeStructureId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(feeStructureId)) throw notFound("Fee structure not found");
  return new Types.ObjectId(feeStructureId);
}

function serialize(row: FeeStructureDoc): FeeStructureDTO {
  return {
    id: String(row._id),
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
 * `$set: { classOrCourse: undefined }` would otherwise erase a stored value
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
    const rows = await FeeStructure.find({ institutionId })
      .sort({ academicYear: -1, classOrCourse: 1 })
      .lean<FeeStructureDoc[]>();
    return rows.map(serialize);
  },

  async get(institutionId: string, feeStructureId: string): Promise<FeeStructureDTO> {
    await connectToDatabase();
    return serialize(await findOwned(institutionId, feeStructureId));
  },

  async create(
    institutionId: string,
    input: CreateInput,
    actor: { id: string; name: string },
  ): Promise<FeeStructureDTO> {
    await connectToDatabase();

    assertFeeStructureInvariants({ lineItems: input.lineItems });

    // Duplicate (classOrCourse, academicYear) is refused by the unique index
    // rather than a pre-read: a read-then-write races two browser tabs and
    // creates both.
    const created = await FeeStructure.create({ ...input, institutionId, status: "DRAFT" });

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityId: created._id,
      entityRef: institutionId,
      action: "Fee structure created",
      description: `${input.classOrCourse} ${input.academicYear} created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(created.toObject() as FeeStructureDoc);
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
    // new line item must still be checked against the whole stored list.
    const merged = { ...before, ...set };
    assertFeeStructureInvariants({ lineItems: merged.lineItems });

    const updated = await FeeStructure.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<FeeStructureDoc>();
    if (!updated) throw notFound("Fee structure not found");

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Fee structure updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
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

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityId: updated._id,
      entityRef: institutionId,
      action: `Fee structure ${ACTION_LABELS[action]}`,
      description: `${updated.classOrCourse} ${updated.academicYear}`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },

  async remove(
    institutionId: string,
    feeStructureId: string,
    actor: { id: string; name: string },
  ): Promise<void> {
    await connectToDatabase();
    const before = await findOwned(institutionId, feeStructureId);

    await FeeStructure.deleteOne({ _id: before._id, institutionId });

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityId: before._id,
      entityRef: institutionId,
      action: "Fee structure deleted",
      description: `${before.classOrCourse} ${before.academicYear} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },
};
