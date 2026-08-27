import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Alumnus, type AlumnusDoc } from "@/models";
import { notFound } from "@/lib/api/errors";
import type { AlumnusCreateInput, AlumnusPatchInput } from "@/lib/validation/showcase";
import { ActivityService } from "./activity.service";

export type AlumnusDTO = {
  id: string;
  name: string;
  batch?: string;
  category: string;
  currentRole?: string;
  org?: string;
  photo?: string;
  note?: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
};

/** A malformed id must read as "no such alumnus", not as a cast error. */
function toObjectId(alumnusId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(alumnusId)) throw notFound("Alumnus not found");
  return new Types.ObjectId(alumnusId);
}

function serialize(row: AlumnusDoc): AlumnusDTO {
  return {
    id: String(row._id),
    name: row.name,
    batch: row.batch ?? undefined,
    category: row.category,
    currentRole: row.currentRole ?? undefined,
    org: row.org ?? undefined,
    photo: row.photo ?? undefined,
    note: row.note ?? undefined,
    status: row.status ?? "ACTIVE",
    createdAt: (row as AlumnusDoc & { createdAt?: Date }).createdAt?.toISOString(),
    updatedAt: (row as AlumnusDoc & { updatedAt?: Date }).updatedAt?.toISOString(),
  };
}

/**
 * The exact key set `alumnusPatchSchema` can produce. `institutionId` is
 * itself a schema path on `Alumnus` (`Alumnus.ts:6`), so Mongoose's update
 * path does not strip it from `$set` the way `strict` blocks an unknown
 * field — only Zod stripping unrecognised keys at the route layer stands
 * between an unparsed patch and a cross-tenant `$set`. This allow-list makes
 * that guarantee hold here too, in the service, rather than depending on
 * every future caller remembering to `.parse()` first. Defence in depth:
 * the route still parses, and still must. `photo` is deliberately absent —
 * it's a storage key written only by the upload endpoint (Task 7), never by
 * this patch path.
 */
const PATCHABLE_FIELDS = new Set<keyof AlumnusPatchInput>([
  "name",
  "batch",
  "category",
  "currentRole",
  "org",
  "note",
  "status",
]);

/**
 * Three states, not two — same convention as `buildProfileUpdate`
 * (`institution.service.ts`). A key absent from the patch arrives as
 * `undefined` and is left alone: `$set: { batch: undefined }` would
 * otherwise erase a stored value the caller never mentioned. A key carrying
 * a value is `$set`. A key explicitly `null` — which on `alumnusPatchSchema`
 * only `batch`, `currentRole`, `org` and `note` accept — is `$unset`, the
 * documented way to clear a field, so it goes away entirely rather than
 * being stored as a literal null the DTO would have to keep translating
 * back.
 */
function buildAlumnusUpdate(patch: AlumnusPatchInput): {
  set: Record<string, unknown>;
  unset: Record<string, "">;
} {
  const set: Record<string, unknown> = {};
  const unset: Record<string, ""> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE_FIELDS.has(key as keyof AlumnusPatchInput)) continue;
    if (value === undefined) continue;
    if (value === null) unset[key] = "";
    else set[key] = value;
  }

  return { set, unset };
}

export const AlumniService = {
  async list(institutionId: string): Promise<AlumnusDTO[]> {
    await connectToDatabase();
    const rows = await Alumnus.find({ institutionId })
      .sort({ batch: -1, name: 1 })
      .lean<AlumnusDoc[]>();
    return rows.map(serialize);
  },

  async create(
    institutionId: string,
    input: AlumnusCreateInput,
    actor: { id: string; name: string },
  ): Promise<AlumnusDTO> {
    await connectToDatabase();

    // `category` is not re-validated here: the model's own enum constraint
    // (ALUMNI_CATEGORIES) rejects an unrecognised value during
    // `Alumnus.create`'s validation pass, before anything is written — the
    // same defense-in-depth the schema already provides, not duplicated in
    // application code. Matches `ResultService.create`'s convention of
    // trusting an already-typed `CreateInput` rather than re-parsing it.
    const created = await Alumnus.create({ ...input, institutionId, status: "ACTIVE" });

    await ActivityService.record({
      institutionId,
      entityType: "ALUMNUS",
      entityId: created._id,
      entityRef: institutionId,
      action: "Alumnus created",
      description: `${input.name} created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(created.toObject() as AlumnusDoc);
  },

  async update(
    institutionId: string,
    alumnusId: string,
    patch: AlumnusPatchInput,
    actor: { id: string; name: string },
  ): Promise<AlumnusDTO> {
    await connectToDatabase();
    const objectId = toObjectId(alumnusId);

    const { set, unset } = buildAlumnusUpdate(patch);

    // An empty patch has nothing for Mongo's `$set`/`$unset` to do (an empty
    // operator object is rejected server-side), so it is read-only — but
    // still institution-scoped, so a foreign or bad id still 404s.
    if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
      const row = await Alumnus.findOne({ _id: objectId, institutionId }).lean<AlumnusDoc>();
      if (!row) throw notFound("Alumnus not found");
      return serialize(row);
    }

    const update: Record<string, unknown> = {};
    if (Object.keys(set).length > 0) update.$set = set;
    if (Object.keys(unset).length > 0) update.$unset = unset;

    const updated = await Alumnus.findOneAndUpdate(
      { _id: objectId, institutionId },
      update,
      { new: true },
    ).lean<AlumnusDoc>();
    if (!updated) throw notFound("Alumnus not found");

    await ActivityService.record({
      institutionId,
      entityType: "ALUMNUS",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Alumnus updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },

  async remove(
    institutionId: string,
    alumnusId: string,
    actor: { id: string; name: string },
  ): Promise<void> {
    await connectToDatabase();
    const objectId = toObjectId(alumnusId);

    const removed = await Alumnus.findOneAndDelete({
      _id: objectId,
      institutionId,
    }).lean<AlumnusDoc>();
    if (!removed) throw notFound("Alumnus not found");

    await ActivityService.record({
      institutionId,
      entityType: "ALUMNUS",
      entityId: removed._id,
      entityRef: institutionId,
      action: "Alumnus deleted",
      description: `${removed.name} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },
};
