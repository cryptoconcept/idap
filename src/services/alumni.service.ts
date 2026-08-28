import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Alumnus, type AlumnusDoc } from "@/models";
import { notFound, validationError } from "@/lib/api/errors";
import { ALUMNI_MAX_RECORDS } from "@/lib/constants";
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

/**
 * Every showcase storage cleanup is best-effort: a failure must never fail a
 * database write that has already been applied. Best-effort is not the same as
 * silent, though — an unlogged failure is a leaked object nobody can find, so
 * the key and the institution go to the log where an operator can act on them.
 *
 * Deliberately a twin of `achievement.service.ts`'s, not an import from it: a
 * service reaching into a sibling service for a utility is a dependency this
 * repo does not otherwise have, and a shared module is more surface than eight
 * lines of cleanup deserve.
 */
async function deleteStoredObject(key: string, institutionId: string): Promise<void> {
  try {
    await storage.deletePublic(key);
  } catch (error) {
    console.error(`[showcase] failed to delete stored object ${key} for ${institutionId}`, error);
  }
}

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
      // `create` already refuses the 201st record, so this limit is never the
      // thing that truncates a list an admin built through the UI. It is here
      // for the institution that somehow holds more anyway — a direct write, a
      // future import, a cap lowered later — because without it the sort is a
      // blocking in-memory sort over the whole collection slice (neither sort
      // key is indexed) and an unbounded response. With it, MongoDB does a
      // top-K sort bounded by this number instead.
      .limit(ALUMNI_MAX_RECORDS)
      .lean<AlumnusDoc[]>();
    return rows.map(serialize);
  },

  /**
   * The alumni the public profile may show: ACTIVE only.
   *
   * Deliberately a second method rather than a filter bolted onto `list`.
   * `list` serves the dashboard, which must see HIDDEN records in order to
   * manage them; this surface must never see one. The filter runs at the
   * DATABASE, so a projection bug downstream cannot leak a record that was
   * never fetched — in-memory filtering after the fact would not have that
   * property. The sort is the same as `list`'s, which is coincidence rather
   * than shared intent, and not a reason to merge the two.
   *
   * `batch` is free text (`Alumnus.ts`) — "2015" or "2012-2015" — so
   * `{ batch: -1 }` is a lexicographic string sort and only coincidentally a
   * chronological one. `batch` is also optional, and MongoDB sorts a missing
   * field before every value ascending, so descending puts alumni with no
   * batch last, which is where a public page wants them.
   */
  async listPublic(institutionId: string): Promise<AlumnusDTO[]> {
    await connectToDatabase();
    const rows = await Alumnus.find({ institutionId, status: "ACTIVE" })
      .sort({ batch: -1, name: 1 })
      // Same defence as `list`'s, and it matters more here: this one feeds an
      // unauthenticated, CORS-open response, so an over-cap institution would
      // otherwise 500 the WHOLE public profile rather than just this block.
      .limit(ALUMNI_MAX_RECORDS)
      .lean<AlumnusDoc[]>();
    return rows.map(serialize);
  },

  async create(
    institutionId: string,
    input: AlumnusCreateInput,
    actor: { id: string; name: string },
  ): Promise<AlumnusDTO> {
    await connectToDatabase();

    // A cap on records per institution. Alumni have no per-record cap to sit
    // beside (one photo, no arrays), so this is the only bound on how much of
    // this collection the public payload can carry. Same `countDocuments` +
    // 400 shape as `OfferService.create` and `ScholarshipService.create`, and
    // the same accepted looseness: two simultaneous creates at the boundary
    // can both pass and land on 201 records, which is fine for a cap whose
    // job is to bound an order of magnitude.
    const count = await Alumnus.countDocuments({ institutionId });
    if (count >= ALUMNI_MAX_RECORDS) {
      throw validationError(
        `You can keep up to ${ALUMNI_MAX_RECORDS} alumni. Delete one to add another.`,
      );
    }

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
    // Only existence matters here now: the key this write displaces is read
    // out of the write itself below, not from this pre-image.
    const before = await Alumnus.findOne({ _id: objectId, institutionId })
      .select("_id")
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

    // `{ new: false }`, deliberately: this returns the PRE-image, and
    // `displaced.photo` is therefore the key this write actually replaced —
    // not the key read before it. With `{ new: true }` the only key available
    // is `before.photo`, and two concurrent uploads both read the same one:
    // both would delete it and the loser's freshly stored object would be
    // orphaned. Reading the displaced key out of the write itself makes the
    // delete follow the write instead of racing it, so each caller cleans up
    // exactly the object it displaced.
    //
    // `institutionId` in this filter is deliberate defence in depth, NOT dead
    // weight — and no external test can pin it, so do not delete it as
    // untested. The institution-scoped pre-read above is what actually refuses
    // a foreign id (verified by mutation: dropping `institutionId` from BOTH
    // fails this method's isolation test; dropping it from this filter alone
    // fails nothing, because the pre-read short-circuits first). What it buys
    // is that the write is atomic with respect to its own tenancy, and that the
    // guard survives if the pre-read is ever moved or removed. Same note as
    // `storeAsset` in achievement.service.ts.
    //
    // The object is in storage before this write runs, so BOTH ways the write
    // can fail have to take it back out — a null result (the record vanished)
    // and a thrown error alike. Without the catch, a connection drop leaks the
    // object with nothing left in the database pointing at it.
    let displaced: AlumnusDoc | null;
    try {
      displaced = await Alumnus.findOneAndUpdate(
        { _id: objectId, institutionId },
        { $set: { photo: stored.key } },
        { new: false },
      ).lean<AlumnusDoc>();
    } catch (error) {
      await deleteStoredObject(stored.key, institutionId);
      throw error;
    }
    if (!displaced) {
      // The record was deleted between the read above and this write. Take the
      // object back out rather than leaving it in storage referenced by nothing.
      await deleteStoredObject(stored.key, institutionId);
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
    if (displaced.photo && displaced.photo !== stored.key) {
      await deleteStoredObject(displaced.photo, institutionId);
    }

    await ActivityService.record({
      institutionId,
      entityType: "ALUMNUS",
      entityId: displaced._id,
      entityRef: institutionId,
      action: "Alumnus photo updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    // `displaced` is the pre-image, so it cannot be serialized as-is. Mongoose
    // stamps `updatedAt` inside the update and ignores an explicit value
    // (verified against the driver), so the pre-image's copy is one write
    // stale — and a "last updated" that predates the upload you just did is a
    // visible lie. One scoped re-read costs far less than the storage write
    // that has already happened. If the record has been deleted since, fall
    // back to the state this call created rather than failing a write that
    // succeeded.
    const current = await Alumnus.findOne({ _id: objectId, institutionId }).lean<AlumnusDoc>();
    return serialize(current ?? { ...displaced, photo: stored.key });
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
      await deleteStoredObject(removed.photo, institutionId);
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
