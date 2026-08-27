import "server-only";
import { Types, type UpdateQuery } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Achievement, type AchievementDoc } from "@/models";
import { AppError, notFound, validationError } from "@/lib/api/errors";
import {
  ACHIEVEMENT_MAX_CERTIFICATES,
  ACHIEVEMENT_MAX_PHOTOS,
  SHOWCASE_MAX_PDF_BYTES,
} from "@/lib/constants";
import { validateImage } from "@/lib/media/image";
import { storage } from "@/lib/storage";
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

/**
 * The two asset kinds an achievement holds. Each owns its own array, its own
 * cap and its own storage rollback — a certificate never counts against the
 * photo limit and vice versa, which is why the cap below filters on one field
 * rather than on the record's total asset count.
 */
export type AchievementAssetKind = "PHOTO" | "CERTIFICATE";

const ASSET_KINDS = {
  PHOTO: {
    field: "photos",
    max: ACHIEVEMENT_MAX_PHOTOS,
    noun: "photos",
    addedAction: "Achievement photo added",
    removedAction: "Achievement photo removed",
  },
  CERTIFICATE: {
    field: "certificates",
    max: ACHIEVEMENT_MAX_CERTIFICATES,
    noun: "certificates",
    addedAction: "Achievement certificate added",
    removedAction: "Achievement certificate removed",
  },
} as const satisfies Record<
  AchievementAssetKind,
  { field: string; max: number; noun: string; addedAction: string; removedAction: string }
>;

/**
 * Stores one already-validated asset and appends its key to the record, in
 * `InstitutionService.addMediaImage`'s shape exactly: the per-kind cap lives
 * inside the update filter as an `$expr`/`$size` condition on the same array
 * the `$push` writes, and a filter that rejects the push triggers a
 * `storage.deletePublic` rollback.
 *
 * Both halves matter. A cap checked with a read-then-write is not enforced —
 * two concurrent uploads would both read a below-cap count and both land. And
 * because the object must be written before the filter can reject it, a
 * refused upload that skipped the rollback would leave that object in storage
 * forever, referenced by nothing.
 *
 * Validation is deliberately NOT shared: an image and a PDF prove themselves
 * differently, and each caller does that before calling here. What is shared
 * is only the part that must be identical for both — the atomic write.
 */
async function storeAsset(
  institutionId: string,
  achievementId: string,
  kind: AchievementAssetKind,
  file: { bytes: Buffer; contentType: string; extension: string },
  actor: { id: string; name: string },
): Promise<AchievementDTO> {
  const { field, max, noun, addedAction } = ASSET_KINDS[kind];

  await connectToDatabase();
  const objectId = toObjectId(achievementId);

  // An unknown or foreign id 404s before anything is stored, so a mistyped id
  // never burns a storage write this then has to take back out.
  const before = await Achievement.findOne({ _id: objectId, institutionId })
    .select("_id")
    .lean<AchievementDoc>();
  if (!before) throw notFound("Achievement not found");

  // Never derived from the client-supplied filename.
  const assetId = new Types.ObjectId();
  const key = `showcase/${institutionId}/achievements/${assetId.toHexString()}${file.extension}`;
  const stored = await storage.putPublic({
    key,
    body: file.bytes,
    contentType: file.contentType,
  });

  const updated = await Achievement.findOneAndUpdate(
    {
      _id: objectId,
      // `institutionId` here is deliberate defence in depth, NOT dead weight —
      // and no external test can pin it, so do not delete it as untested. The
      // institution-scoped pre-read above is what actually refuses a foreign id
      // (verified by mutation: dropping `institutionId` from BOTH fails this
      // method's isolation test; dropping it from this filter alone fails
      // nothing, because the pre-read short-circuits first). There is no way to
      // reach this write from outside the service without passing that read.
      // What this clause buys is that the write is atomic with respect to its
      // own tenancy, and that the guard survives if the pre-read is ever moved
      // or removed.
      institutionId,
      $expr: { $lt: [{ $size: { $ifNull: [`$${field}`, []] } }, max] },
    },
    { $push: { [field]: stored.key } } as UpdateQuery<AchievementDoc>,
    { new: true },
  ).lean<AchievementDoc>();

  if (!updated) {
    await storage.deletePublic(stored.key).catch(() => undefined);
    // Two possible causes, and the admin deserves the accurate one: the cap,
    // or a concurrent delete of the record itself between the read above and
    // this write. Same disambiguating re-read as `addMediaVideo`.
    const still = await Achievement.findOne({ _id: objectId, institutionId })
      .select("_id")
      .lean<AchievementDoc>();
    if (!still) throw notFound("Achievement not found");
    throw new AppError("CONFLICT", `An achievement can hold at most ${max} ${noun}`);
  }

  await ActivityService.record({
    institutionId,
    entityType: "ACHIEVEMENT",
    entityId: updated._id,
    entityRef: institutionId,
    action: addedAction,
    performedBy: actor.id,
    performedByName: actor.name,
  });

  return serialize(updated);
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

  /**
   * Adds one photograph. `validateImage` is the single place that knows what
   * an allowed image is — JPEG/PNG/WebP only, non-empty, size-bounded, and a
   * magic-byte sniff that must agree with the declared content type. It runs
   * before `storeAsset` touches storage, so a file refused for its size or
   * its bytes is never written at all: a multipart form's `contentType` and
   * filename are both client-supplied and prove nothing.
   */
  async addPhoto(
    institutionId: string,
    achievementId: string,
    input: { contentType: string; bytes: Buffer },
    actor: { id: string; name: string },
  ): Promise<AchievementDTO> {
    const { extension } = validateImage(input);
    return storeAsset(
      institutionId,
      achievementId,
      "PHOTO",
      { bytes: input.bytes, contentType: input.contentType, extension },
      actor,
    );
  },

  /**
   * Adds one certificate PDF. There is no shared PDF helper, so this repeats
   * `InstitutionService.addMediaDocument`'s inline check for the same reason
   * that one exists: neither the declared contentType nor the filename is
   * trustworthy, so the bytes themselves must start with the PDF magic number,
   * and the size must be checked, before anything reaches storage.
   */
  async addCertificate(
    institutionId: string,
    achievementId: string,
    input: { contentType: string; bytes: Buffer },
    actor: { id: string; name: string },
  ): Promise<AchievementDTO> {
    const MAGIC = Buffer.from("%PDF-");
    if (!input.bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw validationError("file: that file is not a PDF");
    }
    if (input.bytes.byteLength > SHOWCASE_MAX_PDF_BYTES) {
      throw validationError(
        `file: files must be ${Math.floor(SHOWCASE_MAX_PDF_BYTES / (1024 * 1024))} MB or smaller`,
      );
    }

    return storeAsset(
      institutionId,
      achievementId,
      "CERTIFICATE",
      { bytes: input.bytes, contentType: "application/pdf", extension: ".pdf" },
      actor,
    );
  },

  /**
   * Drops one stored asset from the record and deletes the object behind it.
   *
   * `[field]: input.key` in the filter is not decoration: without it, a key
   * this record does not hold would still match the document, the `$pull`
   * would be a silent no-op, and the line below would then delete a storage
   * object the record never referenced — including, given a guessed key, one
   * belonging to a different record of the same institution. With it, that
   * case fails to match and reports NOT_FOUND instead. Naming the field also
   * keeps the kinds apart: a photo key addressed as a certificate matches
   * nothing.
   */
  async removeAsset(
    institutionId: string,
    achievementId: string,
    input: { kind: AchievementAssetKind; key: string },
    actor: { id: string; name: string },
  ): Promise<AchievementDTO> {
    const { field, removedAction } = ASSET_KINDS[input.kind];

    await connectToDatabase();
    const objectId = toObjectId(achievementId);

    const updated = await Achievement.findOneAndUpdate(
      { _id: objectId, institutionId, [field]: input.key },
      { $pull: { [field]: input.key } } as UpdateQuery<AchievementDoc>,
      { new: true },
    ).lean<AchievementDoc>();
    if (!updated) throw notFound("Achievement asset not found");

    // Best-effort, and after the row is already updated: a storage failure
    // here must not resurrect the now-unreferenced object as the source of
    // truth. Same ordering as `removeMediaItem`. No `isOwnedMediaUrl` guard
    // here either, and for the same two reasons `remove` sets out below —
    // the second of which (it matches `/media/`, not `showcase/`) means
    // adding one would silently turn this line into a no-op.
    await storage.deletePublic(input.key).catch(() => undefined);

    await ActivityService.record({
      institutionId,
      entityType: "ACHIEVEMENT",
      entityId: updated._id,
      entityRef: institutionId,
      action: removedAction,
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

    // The deleted record was the only thing referencing these objects, so
    // they go with it — otherwise every deletion leaks its assets.
    //
    // There is deliberately NO `isOwnedMediaUrl`-style provenance guard on
    // this delete, and adding one would be a regression, not a hardening.
    // Two reasons, and the second is the one that bites:
    //
    // 1. Nothing to guard against. The keys come from the institution-scoped
    //    document just deleted, and `photos` / `certificates` appear in no
    //    create or patch schema and in neither service's `PATCHABLE_FIELDS`,
    //    so no parsed request body can write them. Only the upload methods
    //    above can, and they mint the key under this institution's own
    //    prefix. `addMediaImage` needs its guard because `logoUrl` IS free
    //    text on the profile PATCH; that asymmetry is the whole difference.
    // 2. `isOwnedMediaUrl` matches `/media/{institutionId}/`. Showcase keys
    //    live under `showcase/{institutionId}/`, so it returns false for
    //    every key here — dropping it in would silently disable this cleanup
    //    entirely and leak every asset of every deleted record, with no test
    //    failing to say so.
    //
    // Best-effort, as everywhere else: a storage failure must not fail a
    // deletion that has already happened.
    for (const key of [...(removed.photos ?? []), ...(removed.certificates ?? [])]) {
      await storage.deletePublic(key).catch(() => undefined);
    }

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
