import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Achievement, type AchievementDoc } from "@/models";
import { notFound } from "@/lib/api/errors";
import type { AchievementCreateInput, AchievementPatchInput } from "@/lib/validation/showcase";
import { ActivityService } from "./activity.service";

export type AchievementDTO = {
  id: string;
  category: string;
  title: string;
  description?: string;
  eventDate?: string;
  level: string;
  students?: { name: string; grade?: string }[];
  photos?: string[];
  certificates?: string[];
  status: string;
  createdAt?: string;
  updatedAt?: string;
};

/** A malformed id must read as "no such achievement", not as a cast error. */
function toObjectId(achievementId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(achievementId)) throw notFound("Achievement not found");
  return new Types.ObjectId(achievementId);
}

function serialize(row: AchievementDoc): AchievementDTO {
  return {
    id: String(row._id),
    category: row.category,
    title: row.title,
    description: row.description ?? undefined,
    eventDate: row.eventDate ? row.eventDate.toISOString() : undefined,
    level: row.level ?? "SCHOOL",
    students: row.students?.length
      ? row.students.map((student) => ({ name: student.name, grade: student.grade ?? undefined }))
      : undefined,
    photos: row.photos?.length ? row.photos : undefined,
    certificates: row.certificates?.length ? row.certificates : undefined,
    status: row.status ?? "ACTIVE",
    createdAt: (row as AchievementDoc & { createdAt?: Date }).createdAt?.toISOString(),
    updatedAt: (row as AchievementDoc & { updatedAt?: Date }).updatedAt?.toISOString(),
  };
}

/**
 * The exact key set `achievementPatchSchema` can produce. `institutionId` is
 * itself a schema path on `Achievement` (`Achievement.ts:20`), so Mongoose's
 * update path does not strip it from `$set` the way `strict` blocks an
 * unknown field — only Zod stripping unrecognised keys at the route layer
 * stands between an unparsed patch and a cross-tenant `$set`. This allow-list
 * makes that guarantee hold here too, in the service, rather than depending
 * on every future caller remembering to `.parse()` first. Defence in depth:
 * the route still parses, and still must.
 */
const PATCHABLE_FIELDS = new Set<keyof AchievementPatchInput>([
  "category",
  "title",
  "description",
  "eventDate",
  "level",
  "students",
  "status",
]);

/**
 * Three states, not two — same convention as `buildProfileUpdate`
 * (`institution.service.ts`). A key absent from the patch arrives as
 * `undefined` and is left alone: `$set: { description: undefined }` would
 * otherwise erase a stored value the caller never mentioned. A key carrying a
 * value is `$set`. A key explicitly `null` — which on `achievementPatchSchema`
 * only `description` and `eventDate` accept — is `$unset`, the documented way
 * to clear a field, so it goes away entirely rather than being stored as a
 * literal null the DTO would have to keep translating back.
 */
function buildAchievementUpdate(patch: AchievementPatchInput): {
  set: Record<string, unknown>;
  unset: Record<string, "">;
} {
  const set: Record<string, unknown> = {};
  const unset: Record<string, ""> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE_FIELDS.has(key as keyof AchievementPatchInput)) continue;
    if (value === undefined) continue;
    if (value === null) unset[key] = "";
    else set[key] = value;
  }

  return { set, unset };
}

export const AchievementService = {
  async list(institutionId: string): Promise<AchievementDTO[]> {
    await connectToDatabase();
    const rows = await Achievement.find({ institutionId })
      .sort({ createdAt: -1 })
      .lean<AchievementDoc[]>();
    return rows.map(serialize);
  },

  async create(
    institutionId: string,
    input: AchievementCreateInput,
    actor: { id: string; name: string },
  ): Promise<AchievementDTO> {
    await connectToDatabase();

    // `category` is not re-validated here: the model's own enum constraint
    // (ACHIEVEMENT_CATEGORIES) rejects an unrecognised value during
    // `Achievement.create`'s validation pass, before anything is written —
    // the same defense-in-depth the schema already provides, not duplicated
    // in application code. Matches `ResultService.create`'s convention of
    // trusting an already-typed `CreateInput` rather than re-parsing it.
    const created = await Achievement.create({ ...input, institutionId, status: "ACTIVE" });

    await ActivityService.record({
      institutionId,
      entityType: "ACHIEVEMENT",
      entityId: created._id,
      entityRef: institutionId,
      action: "Achievement created",
      description: `${input.title} created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(created.toObject() as AchievementDoc);
  },

  async update(
    institutionId: string,
    achievementId: string,
    patch: AchievementPatchInput,
    actor: { id: string; name: string },
  ): Promise<AchievementDTO> {
    await connectToDatabase();
    const objectId = toObjectId(achievementId);

    const { set, unset } = buildAchievementUpdate(patch);

    // An empty patch has nothing for Mongo's `$set`/`$unset` to do (an empty
    // operator object is rejected server-side), so it is read-only — but
    // still institution-scoped, so a foreign or bad id still 404s.
    if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
      const row = await Achievement.findOne({ _id: objectId, institutionId }).lean<AchievementDoc>();
      if (!row) throw notFound("Achievement not found");
      return serialize(row);
    }

    const update: Record<string, unknown> = {};
    if (Object.keys(set).length > 0) update.$set = set;
    if (Object.keys(unset).length > 0) update.$unset = unset;

    const updated = await Achievement.findOneAndUpdate(
      { _id: objectId, institutionId },
      update,
      { new: true },
    ).lean<AchievementDoc>();
    if (!updated) throw notFound("Achievement not found");

    await ActivityService.record({
      institutionId,
      entityType: "ACHIEVEMENT",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Achievement updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },

  async remove(
    institutionId: string,
    achievementId: string,
    actor: { id: string; name: string },
  ): Promise<void> {
    await connectToDatabase();
    const objectId = toObjectId(achievementId);

    const removed = await Achievement.findOneAndDelete({
      _id: objectId,
      institutionId,
    }).lean<AchievementDoc>();
    if (!removed) throw notFound("Achievement not found");

    await ActivityService.record({
      institutionId,
      entityType: "ACHIEVEMENT",
      entityId: removed._id,
      entityRef: institutionId,
      action: "Achievement deleted",
      description: `${removed.title} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },
};
