import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Alumnus, type AlumnusDoc } from "@/models";
import { notFound } from "@/lib/api/errors";
import { validateImage } from "@/lib/media/image";
import { storage } from "@/lib/storage";
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

  /**
   * Sets the alumnus's photograph. An alumnus has exactly one, so this is a
   * replace-in-place rather than a capped push — there is no `$expr` cap to
   * enforce, only the obligation not to orphan the object it replaced.
   *
   * `validateImage` runs before anything is stored: JPEG/PNG/WebP only,
   * non-empty, size-bounded, and a magic-byte sniff that must agree with the
   * declared content type. A multipart form's `contentType` and filename are
   * both client-supplied and prove nothing, so a file refused for its bytes or
   * its size never reaches storage at all.
   */
  async setPhoto(
    institutionId: string,
    alumnusId: string,
    input: { contentType: string; bytes: Buffer },
    actor: { id: string; name: string },
  ): Promise<AlumnusDTO> {
    const { extension } = validateImage(input);

    await connectToDatabase();
    const objectId = toObjectId(alumnusId);

    // An unknown or foreign id 404s before anything is stored, so a mistyped
    // id never burns a storage write this then has to take back out.
    const before = await Alumnus.findOne({ _id: objectId, institutionId })
      .select("_id photo")
      .lean<AlumnusDoc>();
    if (!before) throw notFound("Alumnus not found");

    // Never derived from the client-supplied filename.
    const assetId = new Types.ObjectId();
    const key = `showcase/${institutionId}/alumni/${assetId.toHexString()}${extension}`;
    const stored = await storage.putPublic({
      key,
      body: input.bytes,
      contentType: input.contentType,
    });

    // `institutionId` in this filter is deliberate defence in depth, NOT dead
    // weight — and no external test can pin it, so do not delete it as
    // untested. The institution-scoped pre-read above is what actually refuses
    // a foreign id (verified by mutation: dropping `institutionId` from BOTH
    // fails this method's isolation test; dropping it from this filter alone
    // fails nothing, because the pre-read short-circuits first). What it buys
    // is that the write is atomic with respect to its own tenancy, and that the
    // guard survives if the pre-read is ever moved or removed. Same note as
    // `storeAsset` in achievement.service.ts.
    const updated = await Alumnus.findOneAndUpdate(
      { _id: objectId, institutionId },
      { $set: { photo: stored.key } },
      { new: true },
    ).lean<AlumnusDoc>();
    if (!updated) {
      // The record was deleted between the read above and this write. Take the
      // object back out rather than leaving it in storage referenced by nothing.
      await storage.deletePublic(stored.key).catch(() => undefined);
      throw notFound("Alumnus not found");
    }

    // The photo this replaced is now referenced by nothing.
    //
    // There is deliberately NO `isOwnedMediaUrl`-style provenance guard here,
    // and adding one would be a regression rather than a hardening:
    //
    // 1. Nothing to guard against. Unlike `logoUrl` — free text on the profile
    //    PATCH, which is exactly why `addMediaImage` guards its equivalent —
    //    `photo` is never accepted from a request body: it is absent from
    //    `alumnusCreateSchema`, from `alumnusPatchSchema` and from
    //    `PATCHABLE_FIELDS`, so its stored value is always a key this service
    //    minted under this institution's own prefix.
    // 2. `isOwnedMediaUrl` matches `/media/{institutionId}/`, and showcase
    //    keys live under `showcase/{institutionId}/` — so it returns false
    //    for every key here. Dropping it in would silently disable this
    //    cleanup and orphan a stored object on every photo replacement, with
    //    no test failing to say so.
    //
    // Best-effort: a cleanup failure must not fail the request that has
    // already stored the new object.
    if (before.photo && before.photo !== stored.key) {
      await storage.deletePublic(before.photo).catch(() => undefined);
    }

    await ActivityService.record({
      institutionId,
      entityType: "ALUMNUS",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Alumnus photo updated",
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

    // The deleted record was the only thing referencing this object, so it
    // goes with it — otherwise every deletion leaks its photo. Same
    // provenance argument as `setPhoto` above, including why there is no
    // `isOwnedMediaUrl` guard: `photo` is written only by that method, and
    // that helper matches `/media/` rather than `showcase/`, so adding it
    // would silently turn this cleanup into a no-op. Best-effort: a storage
    // failure must not fail a deletion that has already happened.
    if (removed.photo) {
      await storage.deletePublic(removed.photo).catch(() => undefined);
    }

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
