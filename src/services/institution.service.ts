import "server-only";
import type { FilterQuery } from "mongoose";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution, User, type InstitutionDoc } from "@/models";
import { generateInstitutionId, reserveInstitutionId } from "./sequence.service";
import { ActivityService } from "./activity.service";
import { allocateSlug } from "./slug.service";
import { hashPassword } from "@/lib/security/password";
import { AppError, notFound, validationError } from "@/lib/api/errors";
import { escapeRegex, requiredIso, toIso } from "@/lib/utils/serialize";
import { toDirectoryCard, type DirectoryCard } from "@/lib/profile/directory-projection";
import type { InstitutionDTO, Paginated, ProfileDTO } from "@/lib/types";
import {
  DIRECTORY_MAX_PAGE_SIZE,
  MEDIA_MAX_ITEMS,
  MEDIA_MAX_PDF_BYTES,
  type InstitutionType,
  type MediaKind,
  type MediaProvider,
  type MediaStatus,
  type ProfileStatus,
} from "@/lib/constants";
import { storage } from "@/lib/storage";
import { calculateCompletion, type ProfileCompletion } from "@/lib/profile/completion";
import { toPublicProfile, type PublicProfile } from "@/lib/profile/public-projection";
import type { DerivedOfferings } from "@/lib/academic/offerings";
import { AcademicStructureService } from "./academic-structure.service";
import { AchievementService } from "./achievement.service";
import { AlumniService } from "./alumni.service";
import type { z } from "zod";
import {
  mediaDocumentKindSchema,
  mediaUploadSchema,
  videoLinkSchema,
} from "@/lib/validation/institution";
import type {
  createInstitutionSchema,
  mediaItemPatchSchema,
  platformInstitutionPatchSchema,
  updateInstitutionSchema,
  updateProfileSchema,
} from "@/lib/validation/institution";
import { validateImage } from "@/lib/media/image";
import { isOwnedMediaUrl } from "@/lib/media/ownership";
import { normalizeVideoUrl } from "@/lib/media/video-url";

type InstitutionRow = InstitutionDoc;

/** Blocks whose fields are merged one level deep, by dotted `$set` path. */
const PROFILE_BLOCK_KEYS = ["contact", "geo", "academic", "management", "social"] as const;

export { isOwnedMediaUrl };

/**
 * Builds the dotted-path update from a parsed profile patch. Block fields
 * (`contact`, `geo`, `academic`, `management`, `social`) are walked one level
 * deep so a patch touching one field of a block never erases its siblings.
 * Everything else — top-level scalars and arrays (`facilities`), and arrays
 * nested one level inside a block (`academic.medium`, `social.other`) — is
 * `$set` as a whole value: arrays always replace wholesale, never merge
 * element-by-element.
 *
 * Three states, not two. A key absent from the patch arrives as `undefined`
 * and is left alone — that is the guarantee that patching `academic.board`
 * does not erase `academic.classesOffered`. A key carrying a value is `$set`.
 * A key explicitly `null` — which only `logoUrl` and `coverImageUrl` accept —
 * is `$unset`, the documented way to clear an image, so the field goes away
 * entirely rather than being stored as a literal null the DTO would have to
 * keep translating back.
 */
function buildProfileUpdate(patch: z.infer<typeof updateProfileSchema>): {
  set: Record<string, unknown>;
  unset: Record<string, "">;
} {
  const set: Record<string, unknown> = {};
  const unset: Record<string, ""> = {};

  const assign = (path: string, value: unknown) => {
    if (value === null) unset[path] = "";
    else set[path] = value;
  };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // A null block would clear the whole block; it never has entries to walk.
    if (value !== null && (PROFILE_BLOCK_KEYS as readonly string[]).includes(key)) {
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subValue === undefined) continue;
        assign(`${key}.${subKey}`, subValue);
      }
    } else {
      assign(key, value);
    }
  }
  return { set, unset };
}

function serialize(row: InstitutionRow): ProfileDTO {
  return {
    id: String(row._id),
    institutionId: row.institutionId,
    institutionName: row.institutionName,
    institutionType: row.institutionType as InstitutionType,
    address: row.address ?? undefined,
    city: row.city ?? undefined,
    state: row.state ?? undefined,
    pincode: row.pincode ?? undefined,
    contactPerson: row.contactPerson ?? undefined,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    website: row.website ?? undefined,
    logoUrl: row.logoUrl ?? undefined,
    active: row.active ?? true,
    createdAt: requiredIso(row.createdAt),
    updatedAt: requiredIso(row.updatedAt),

    slug: row.slug ?? undefined,
    regionCode: row.regionCode ?? undefined,
    legalName: row.legalName ?? undefined,
    shortName: row.shortName ?? undefined,
    coverImageUrl: row.coverImageUrl ?? undefined,
    establishedYear: row.establishedYear ?? undefined,
    tagline: row.tagline ?? undefined,
    description: row.description ?? undefined,
    profileStatus: (row.profileStatus ?? "DRAFT") as ProfileStatus,
    publishedAt: row.publishedAt ? toIso(row.publishedAt) : undefined,

    addressLine2: row.addressLine2 ?? undefined,
    locality: row.locality ?? undefined,
    area: row.area ?? undefined,
    taluk: row.taluk ?? undefined,
    district: row.district ?? undefined,
    country: row.country ?? undefined,

    contact: row.contact
      ? {
          secondaryPhone: row.contact.secondaryPhone ?? undefined,
          alternateEmail: row.contact.alternateEmail ?? undefined,
          whatsapp: row.contact.whatsapp ?? undefined,
        }
      : undefined,
    geo: row.geo
      ? {
          latitude: row.geo.latitude ?? undefined,
          longitude: row.geo.longitude ?? undefined,
          mapUrl: row.geo.mapUrl ?? undefined,
        }
      : undefined,
    academic: row.academic
      ? {
          board: row.academic.board ?? undefined,
          affiliation: row.academic.affiliation ?? undefined,
          recognition: row.academic.recognition ?? undefined,
          affiliationNumber: row.academic.affiliationNumber ?? undefined,
          udiseCode: row.academic.udiseCode ?? undefined,
          medium: row.academic.medium ?? undefined,
          genderType: row.academic.genderType ?? undefined,
          currentAcademicYear: row.academic.currentAcademicYear ?? undefined,
          classesOffered: row.academic.classesOffered ?? undefined,
          coursesOffered: row.academic.coursesOffered ?? undefined,
        }
      : undefined,
    management: row.management
      ? {
          managementType: row.management.managementType ?? undefined,
          trustName: row.management.trustName ?? undefined,
          societyName: row.management.societyName ?? undefined,
          managementName: row.management.managementName ?? undefined,
          principalName: row.management.principalName ?? undefined,
          headDesignation: row.management.headDesignation ?? undefined,
          headEmail: row.management.headEmail ?? undefined,
          headPhone: row.management.headPhone ?? undefined,
        }
      : undefined,
    facilities: row.facilities?.map((facility) => ({
      code: facility.code,
      label: facility.label,
      available: facility.available ?? undefined,
      note: facility.note ?? undefined,
    })),
    social: row.social
      ? {
          facebook: row.social.facebook ?? undefined,
          instagram: row.social.instagram ?? undefined,
          youtube: row.social.youtube ?? undefined,
          linkedin: row.social.linkedin ?? undefined,
          x: row.social.x ?? undefined,
          other: row.social.other?.map((entry) => ({
            label: entry.label ?? "",
            url: entry.url ?? undefined,
          })),
        }
      : undefined,
    media: row.media?.map((item) => ({
      id: String(item._id),
      kind: item.kind as MediaKind,
      url: item.url,
      title: item.title ?? undefined,
      caption: item.caption ?? undefined,
      sortOrder: item.sortOrder ?? 0,
      status: (item.status ?? "ACTIVE") as MediaStatus,
      provider: (item.provider ?? undefined) as MediaProvider | undefined,
      videoId: item.videoId ?? undefined,
      uploadedAt: requiredIso(item.uploadedAt),
    })),
  };
}

export const InstitutionService = {
  serialize,

  async create(
    input: z.infer<typeof createInstitutionSchema>,
    actor: { id: string; name: string },
  ): Promise<{ institution: InstitutionDTO; adminCreated: boolean }> {
    await connectToDatabase();

    const institutionId = input.institutionId ?? (await generateInstitutionId());
    const existing = await Institution.findOne({ institutionId }).select("_id").lean();
    if (existing) {
      throw new AppError("CONFLICT", `Institution ${institutionId} already exists`);
    }
    if (input.institutionId) await reserveInstitutionId(institutionId);

    const created = await Institution.create({
      institutionId,
      institutionName: input.institutionName,
      institutionType: input.institutionType,
      address: input.address,
      city: input.city,
      state: input.state,
      pincode: input.pincode,
      contactPerson: input.contactPerson,
      phone: input.phone,
      email: input.email,
      website: input.website,
      logoUrl: input.logoUrl,
      active: true,
    });

    let adminCreated = false;
    if (input.adminEmail && input.adminPassword) {
      const duplicate = await User.findOne({ email: input.adminEmail }).select("_id").lean();
      if (duplicate) {
        throw new AppError("CONFLICT", "A user with that email address already exists");
      }
      await User.create({
        institutionId,
        name: input.adminName ?? input.institutionName,
        email: input.adminEmail,
        passwordHash: await hashPassword(input.adminPassword),
        role: "INSTITUTION_ADMIN",
        active: true,
      });
      adminCreated = true;
    }

    // Every institution gets a public-facing slug from day one; allocated here
    // so the row on disk always has one, not only institutions that later
    // publish a profile.
    const slug = await allocateSlug({
      institutionId,
      institutionName: input.institutionName,
      locality: input.city,
    });

    await ActivityService.record({
      institutionId,
      entityType: "INSTITUTION",
      entityId: created._id,
      entityRef: institutionId,
      action: "Institution created",
      description: `${input.institutionName} (${institutionId}) created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return {
      institution: serialize({ ...(created.toObject() as InstitutionRow), slug }),
      adminCreated,
    };
  },

  async update(
    institutionId: string,
    patch: z.infer<typeof updateInstitutionSchema>,
    actor: { id: string; name: string },
  ): Promise<InstitutionDTO> {
    await connectToDatabase();
    const before = await Institution.findOne({ institutionId }).lean();
    if (!before) throw notFound("Institution not found");

    const update = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );

    const updated = await Institution.findOneAndUpdate(
      { institutionId },
      { $set: update },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Institution not found");

    if (patch.active !== undefined && patch.active !== (before.active ?? true)) {
      await ActivityService.record({
        institutionId,
        entityType: "INSTITUTION",
        entityId: updated._id,
        entityRef: institutionId,
        action: patch.active ? "Institution activated" : "Institution deactivated",
        performedBy: actor.id,
        performedByName: actor.name,
      });
    } else {
      await ActivityService.record({
        institutionId,
        entityType: "INSTITUTION",
        entityId: updated._id,
        entityRef: institutionId,
        action: "Institution updated",
        performedBy: actor.id,
        performedByName: actor.name,
      });
    }

    return serialize(updated as InstitutionRow);
  },

  /** The institution admin's own view: the full profile plus how complete it is. */
  async getProfile(
    institutionId: string,
  ): Promise<{ profile: ProfileDTO; completion: ProfileCompletion; offerings: DerivedOfferings | null }> {
    await connectToDatabase();
    const row = await Institution.findOne({ institutionId }).lean();
    if (!row) throw notFound("Institution not found");

    // Completion is scored against what the profile actually publishes. An
    // institution that built a tree instead of typing the two lists has real
    // offerings, and the same derivation the public projection uses is what
    // says so — otherwise removing those inputs would permanently dock the
    // academic section.
    const offerings = await AcademicStructureService.offeringsFor(institutionId);
    const scored = offerings
      ? { ...row, academic: { ...(row.academic ?? {}), ...offerings } }
      : row;

    return {
      profile: serialize(row as InstitutionRow),
      completion: calculateCompletion(scored),
      offerings,
    };
  },

  /**
   * Section-scoped save. Merges by dotted path so a patch touching only one
   * field of a block (e.g. `academic.board`) never erases its siblings
   * (`academic.classesOffered`). Arrays always replace wholesale — that is the
   * editing model the UI presents, never an element-by-element merge. An
   * explicit `null` on `logoUrl` / `coverImageUrl` clears that image.
   */
  async updateProfile(
    institutionId: string,
    patch: z.infer<typeof updateProfileSchema>,
    actor: { id: string; name: string },
  ): Promise<ProfileDTO> {
    await connectToDatabase();
    const before = await Institution.findOne({ institutionId }).select("_id").lean();
    if (!before) throw notFound("Institution not found");

    const { set, unset } = buildProfileUpdate(patch);

    // Only the operators that actually have work in them: an empty `$set` is
    // rejected by the server, and a patch may legitimately be clear-only.
    const update: Record<string, unknown> = {};
    if (Object.keys(set).length > 0) update.$set = set;
    if (Object.keys(unset).length > 0) update.$unset = unset;

    const updated = await Institution.findOneAndUpdate({ institutionId }, update, {
      new: true,
    }).lean();
    if (!updated) throw notFound("Institution not found");

    await ActivityService.record({
      institutionId,
      entityType: "INSTITUTION",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Institution profile updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated as InstitutionRow);
  },

  /**
   * Publishing sets `publishedAt` once, on the first transition to PUBLISHED.
   * Unpublishing (PUBLISHED -> DRAFT) never clears it — it is history, not
   * current state.
   */
  async setProfileStatus(
    institutionId: string,
    status: "PUBLISHED" | "DRAFT",
    actor: { id: string; name: string },
  ): Promise<ProfileDTO> {
    await connectToDatabase();
    const before = await Institution.findOne({ institutionId }).select("_id publishedAt").lean();
    if (!before) throw notFound("Institution not found");

    const set: Record<string, unknown> = { profileStatus: status };
    if (status === "PUBLISHED" && !before.publishedAt) {
      set.publishedAt = new Date();
    }

    const updated = await Institution.findOneAndUpdate(
      { institutionId },
      { $set: set },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Institution not found");

    await ActivityService.record({
      institutionId,
      entityType: "INSTITUTION",
      entityId: updated._id,
      entityRef: institutionId,
      action:
        status === "PUBLISHED" ? "Institution profile published" : "Institution profile unpublished",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated as InstitutionRow);
  },

  /**
   * Uploads a LOGO, COVER, or MEDIA image. LOGO/COVER store the new object,
   * `$set` the URL field, then best-effort `deletePublic` the previous object.
   * MEDIA pushes onto the array through a filtered atomic update — the
   * `$expr` cap check and the `$push` happen in the same operation, so two
   * concurrent uploads can never both slip past a nearly-full media array. If
   * the update matches nothing, the cap was already reached: the
   * just-uploaded object is best-effort deleted so nothing orphans, and a
   * CONFLICT is thrown.
   */
  async addMediaImage(
    institutionId: string,
    input: {
      target: "LOGO" | "COVER" | "MEDIA";
      fileName: string;
      contentType: string;
      bytes: Buffer;
      title?: string;
      caption?: string;
    },
    actor: { id: string; name: string },
  ): Promise<ProfileDTO> {
    const parsed = mediaUploadSchema.parse({
      target: input.target,
      title: input.title,
      caption: input.caption,
    });
    const { extension } = validateImage({ contentType: input.contentType, bytes: input.bytes });

    await connectToDatabase();
    const before = await Institution.findOne({ institutionId })
      .select("_id logoUrl coverImageUrl media")
      .lean();
    if (!before) throw notFound("Institution not found");

    // Never derived from the client-supplied filename.
    const objectId = new Types.ObjectId();
    const key = `media/${institutionId}/${objectId.toHexString()}${extension}`;
    const stored = await storage.putPublic({
      key,
      body: input.bytes,
      contentType: input.contentType,
    });

    if (parsed.target === "MEDIA") {
      const updated = await Institution.findOneAndUpdate(
        {
          institutionId,
          $expr: {
            $lt: [
              {
                $size: {
                  $filter: {
                    input: { $ifNull: ["$media", []] },
                    cond: { $eq: ["$$this.kind", "IMAGE"] },
                  },
                },
              },
              MEDIA_MAX_ITEMS.IMAGE,
            ],
          },
        },
        {
          $push: {
            media: {
              _id: objectId,
              kind: "IMAGE",
              url: stored.key,
              title: parsed.title,
              caption: parsed.caption,
              sortOrder: before.media?.length ?? 0,
              status: "ACTIVE",
              uploadedAt: new Date(),
            },
          },
        },
        { new: true },
      ).lean();

      if (!updated) {
        await storage.deletePublic(stored.key).catch(() => undefined);
        throw new AppError("CONFLICT", `A profile can hold at most ${MEDIA_MAX_ITEMS.IMAGE} images`);
      }

      await ActivityService.record({
        institutionId,
        entityType: "INSTITUTION",
        entityId: updated._id,
        entityRef: institutionId,
        action: "Media image added",
        performedBy: actor.id,
        performedByName: actor.name,
      });

      return serialize(updated as InstitutionRow);
    }

    // LOGO / COVER: replace-in-place.
    const field = parsed.target === "LOGO" ? "logoUrl" : "coverImageUrl";
    const previousUrl = parsed.target === "LOGO" ? before.logoUrl : before.coverImageUrl;

    const updated = await Institution.findOneAndUpdate(
      { institutionId },
      { $set: { [field]: stored.key } },
      { new: true },
    ).lean();

    if (!updated) {
      await storage.deletePublic(stored.key).catch(() => undefined);
      throw notFound("Institution not found");
    }

    // Only ever delete an object this service minted for THIS institution.
    // `logoUrl` is free text on the profile PATCH, so `previousUrl` is not
    // necessarily anything this institution owns. Best-effort as before: a
    // foreign or failing URL is skipped silently rather than failing the
    // request that has already stored the new object.
    if (previousUrl && isOwnedMediaUrl(previousUrl, institutionId)) {
      await storage.deletePublic(previousUrl).catch(() => undefined);
    }

    await ActivityService.record({
      institutionId,
      entityType: "INSTITUTION",
      entityId: updated._id,
      entityRef: institutionId,
      action: parsed.target === "LOGO" ? "Logo updated" : "Cover image updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated as InstitutionRow);
  },

  /**
   * Uploads a brochure or prospectus PDF. Follows `addMediaImage`'s shape
   * exactly — the same atomic per-kind `$expr` cap filter, the same
   * `storage.deletePublic` rollback when the cap rejects the push, the same
   * `ActivityService.record` call — differing only in what it validates:
   * a multipart form's declared `contentType` and filename are both
   * client-supplied and prove nothing, so the bytes themselves must start
   * with the PDF magic number before anything touches storage.
   */
  async addMediaDocument(
    institutionId: string,
    input: {
      kind: "BROCHURE" | "PROSPECTUS";
      fileName: string;
      contentType: string;
      bytes: Buffer;
      title?: string;
      caption?: string;
    },
    actor: { id: string; name: string },
  ): Promise<ProfileDTO> {
    // Re-validated against the document-only enum, not `mediaUploadSchema`'s
    // wider one (which also allows `IMAGE`) — this is the runtime check that
    // holds this method to its declared `"BROCHURE" | "PROSPECTUS"` contract
    // for every caller, not only the ones TypeScript happens to check.
    const kind = mediaDocumentKindSchema.parse(input.kind);
    const parsed = mediaUploadSchema.parse({
      target: "MEDIA",
      title: input.title,
      caption: input.caption,
    });

    // Neither the declared contentType nor the filename is trustworthy —
    // both are supplied by the client. Only the bytes prove anything.
    const MAGIC = Buffer.from("%PDF-");
    if (!input.bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw validationError("file: that file is not a PDF");
    }
    if (input.bytes.byteLength > MEDIA_MAX_PDF_BYTES) {
      throw validationError(
        `file: files must be ${Math.floor(MEDIA_MAX_PDF_BYTES / (1024 * 1024))} MB or smaller`,
      );
    }

    await connectToDatabase();
    const before = await Institution.findOne({ institutionId }).select("_id media").lean();
    if (!before) throw notFound("Institution not found");

    // Never derived from the client-supplied filename.
    const objectId = new Types.ObjectId();
    const key = `media/${institutionId}/documents/${objectId.toHexString()}.pdf`;
    const stored = await storage.putPublic({
      key,
      body: input.bytes,
      contentType: "application/pdf",
    });

    const updated = await Institution.findOneAndUpdate(
      {
        institutionId,
        $expr: {
          $lt: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ["$media", []] },
                  cond: { $eq: ["$$this.kind", kind] },
                },
              },
            },
            MEDIA_MAX_ITEMS[kind],
          ],
        },
      },
      {
        $push: {
          media: {
            _id: objectId,
            kind,
            url: stored.key,
            title: parsed.title,
            caption: parsed.caption,
            sortOrder: before.media?.length ?? 0,
            status: "ACTIVE",
            uploadedAt: new Date(),
          },
        },
      },
      { new: true },
    ).lean();

    if (!updated) {
      await storage.deletePublic(stored.key).catch(() => undefined);
      throw new AppError("CONFLICT", `A profile can hold at most ${MEDIA_MAX_ITEMS[kind]} ${kind === "BROCHURE" ? "brochures" : "prospectuses"}`);
    }

    await ActivityService.record({
      institutionId,
      entityType: "INSTITUTION",
      entityId: updated._id,
      entityRef: institutionId,
      action: kind === "BROCHURE" ? "Brochure added" : "Prospectus added",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated as InstitutionRow);
  },

  /**
   * Adds a YouTube or Vimeo link. No bytes are ever stored — `normalizeVideoUrl`
   * is the single place that knows what a video URL looks like. The duplicate
   * check (on the normalized `(provider, videoId)` pair) and the per-kind cap
   * both live inside the same atomic update filter as the `$push`, so two
   * concurrent submissions can never both land. A `null` result means either
   * the duplicate or the cap matched; the row is re-read so the admin gets the
   * accurate reason rather than a generic refusal.
   */
  async addMediaVideo(
    institutionId: string,
    input: { url: string; title?: string; caption?: string },
    actor: { id: string; name: string },
  ): Promise<ProfileDTO> {
    const parsed = videoLinkSchema.parse(input);
    const normalized = normalizeVideoUrl(parsed.url);
    if (!normalized) {
      throw validationError("url: only YouTube and Vimeo links are supported");
    }

    await connectToDatabase();
    const before = await Institution.findOne({ institutionId }).select("_id media").lean();
    if (!before) throw notFound("Institution not found");

    const objectId = new Types.ObjectId();
    const updated = await Institution.findOneAndUpdate(
      {
        institutionId,
        media: {
          $not: {
            $elemMatch: { provider: normalized.provider, videoId: normalized.videoId },
          },
        },
        $expr: {
          $lt: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ["$media", []] },
                  cond: { $eq: ["$$this.kind", "VIDEO"] },
                },
              },
            },
            MEDIA_MAX_ITEMS.VIDEO,
          ],
        },
      },
      {
        $push: {
          media: {
            _id: objectId,
            kind: "VIDEO",
            url: normalized.url,
            title: parsed.title,
            caption: parsed.caption,
            sortOrder: before.media?.length ?? 0,
            status: "ACTIVE",
            provider: normalized.provider,
            videoId: normalized.videoId,
            uploadedAt: new Date(),
          },
        },
      },
      { new: true },
    ).lean();

    if (!updated) {
      const row = await Institution.findOne({ institutionId }).select("media").lean();
      if (!row) throw notFound("Institution not found");
      const isDuplicate = row.media?.some(
        (item) => item.provider === normalized.provider && item.videoId === normalized.videoId,
      );
      if (isDuplicate) {
        throw new AppError("CONFLICT", "This video has already been added");
      }
      throw new AppError("CONFLICT", `A profile can hold at most ${MEDIA_MAX_ITEMS.VIDEO} videos`);
    }

    await ActivityService.record({
      institutionId,
      entityType: "INSTITUTION",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Video added",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated as InstitutionRow);
  },

  /**
   * Edits one media item in place — the only way to hide an image without
   * deleting it. Addressed by `_id` through an array filter, so a concurrent
   * upload or delete cannot shift the write onto a different item the way a
   * positional index would.
   *
   * Same three-state rule as `buildProfileUpdate` above: a key absent from
   * the patch is `undefined` and is left alone; a key carrying a value is
   * `$set`; `caption` explicitly `null` (the only field `mediaItemPatchSchema`
   * allows that on) is `$unset`, so a cleared caption is actually gone rather
   * than stored as a literal null the DTO would have to keep translating back.
   */
  async updateMediaItem(
    institutionId: string,
    mediaId: string,
    patch: z.infer<typeof mediaItemPatchSchema>,
    actor: { id: string; name: string },
  ): Promise<ProfileDTO> {
    if (!Types.ObjectId.isValid(mediaId)) throw notFound("Media item not found");

    await connectToDatabase();

    const set: Record<string, unknown> = {};
    const unset: Record<string, ""> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) unset[`media.$[item].${key}`] = "";
      else set[`media.$[item].${key}`] = value;
    }

    const objectId = new Types.ObjectId(mediaId);

    if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
      const row = await Institution.findOne({ institutionId, "media._id": objectId }).lean();
      if (!row) throw notFound("Media item not found");
      return serialize(row as InstitutionRow);
    }

    // Only the operators that actually have work in them: an empty `$set` (or
    // `$unset`) is rejected by the server, and a patch may legitimately be
    // clear-only (`{ caption: null }` with nothing else to `$set`).
    const update: Record<string, unknown> = {};
    if (Object.keys(set).length > 0) update.$set = set;
    if (Object.keys(unset).length > 0) update.$unset = unset;

    const updated = await Institution.findOneAndUpdate(
      { institutionId, "media._id": objectId },
      update,
      { new: true, arrayFilters: [{ "item._id": objectId }] },
    ).lean();
    if (!updated) throw notFound("Media item not found");

    await ActivityService.record({
      institutionId,
      entityType: "INSTITUTION",
      entityId: updated._id,
      entityRef: institutionId,
      action: patch.status === "HIDDEN" ? "Media image hidden" : "Media image updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated as InstitutionRow);
  },

  async removeMediaItem(
    institutionId: string,
    mediaId: string,
    actor: { id: string; name: string },
  ): Promise<ProfileDTO> {
    if (!Types.ObjectId.isValid(mediaId)) throw notFound("Media item not found");

    await connectToDatabase();
    const before = await Institution.findOne({ institutionId }).select("media").lean();
    if (!before) throw notFound("Institution not found");

    const item = before.media?.find((entry) => String(entry._id) === mediaId);
    if (!item) throw notFound("Media item not found");

    const updated = await Institution.findOneAndUpdate(
      { institutionId },
      { $pull: { media: { _id: new Types.ObjectId(mediaId) } } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Institution not found");

    // Best-effort: the row is already updated: a storage cleanup failure here
    // must not resurrect the (now unreferenced) object as the source of truth.
    // Guarded by the same provenance check as the logo/cover replace path, so
    // this can only ever reach one of this institution's own objects.
    if (isOwnedMediaUrl(item.url, institutionId)) {
      await storage.deletePublic(item.url).catch(() => undefined);
    }

    await ActivityService.record({
      institutionId,
      entityType: "INSTITUTION",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Media image removed",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated as InstitutionRow);
  },

  /**
   * The platform admin's narrow write path: identity/region/activation only,
   * never profile content. The schema — not this method — is the security
   * boundary, so its parameter type is exactly `platformInstitutionPatchSchema`'s
   * inferred type and must never be widened.
   */
  async patchPlatform(
    institutionId: string,
    patch: z.infer<typeof platformInstitutionPatchSchema>,
    actor: { id: string; name: string },
  ): Promise<InstitutionDTO> {
    await connectToDatabase();
    const before = await Institution.findOne({ institutionId }).lean();
    if (!before) throw notFound("Institution not found");

    const update = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );

    const updated = await Institution.findOneAndUpdate(
      { institutionId },
      { $set: update },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Institution not found");

    if (patch.active !== undefined && patch.active !== (before.active ?? true)) {
      await ActivityService.record({
        institutionId,
        entityType: "INSTITUTION",
        entityId: updated._id,
        entityRef: institutionId,
        action: patch.active ? "Institution activated" : "Institution deactivated",
        performedBy: actor.id,
        performedByName: actor.name,
      });
    } else {
      await ActivityService.record({
        institutionId,
        entityType: "INSTITUTION",
        entityId: updated._id,
        entityRef: institutionId,
        action: "Institution updated",
        performedBy: actor.id,
        performedByName: actor.name,
      });
    }

    return serialize(updated as InstitutionRow);
  },

  async getById(institutionId: string): Promise<InstitutionDTO> {
    await connectToDatabase();
    const row = await Institution.findOne({ institutionId }).lean();
    if (!row) throw notFound("Institution not found");
    return serialize(row as InstitutionRow);
  },

  /** Public branding lookup for the hosted application pages. Inactive tenants 404. */
  async getPublicBranding(institutionId: string) {
    await connectToDatabase();
    const row = await Institution.findOne({ institutionId: institutionId.toUpperCase(), active: true })
      .select("institutionId institutionName institutionType address city state pincode phone email website logoUrl slug")
      .lean();
    if (!row) return null;
    return {
      institutionId: row.institutionId,
      institutionName: row.institutionName,
      institutionType: row.institutionType,
      address: row.address ?? undefined,
      city: row.city ?? undefined,
      state: row.state ?? undefined,
      pincode: row.pincode ?? undefined,
      phone: row.phone ?? undefined,
      email: row.email ?? undefined,
      website: row.website ?? undefined,
      logoUrl: row.logoUrl ?? undefined,
      slug: row.slug ?? undefined,
    };
  },

  /**
   * Credential-free full profile lookup for the public institution page, by id
   * or by slug. A single query gates on `active` and `profileStatus` together —
   * anything not published-and-active (missing, draft, suspended, archived, or
   * deactivated) comes back `null`, indistinguishable from a nonexistent record.
   */
  /**
   * The directory read: which institutions exist publicly.
   *
   * Gated on exactly the same pair as `getPublicProfile` — `active: true` and
   * `profileStatus: "PUBLISHED"` — so an institution appears here if and only
   * if its profile is fetchable. The two must never drift: a school listed in
   * the directory whose profile 404s is a broken link on someone's website,
   * and a school that is silently absent from the directory has no way to
   * discover it is.
   *
   * Offset paging (`page`/`pageSize`) rather than a cursor, matching
   * `LeadService.list`. A cursor would page more stably over a moving set, but
   * this set moves when an institution publishes — rare — and matching the
   * convention already in the codebase is worth more here than the stability.
   *
   * `pageSize` is capped by the caller's schema. It is capped again below,
   * because this is a credential-free endpoint and the cap is what stops one
   * request from reading the whole table.
   */
  async listPublicDirectory(query: {
    page?: number;
    pageSize?: number;
    city?: string;
    board?: string;
    type?: string;
    q?: string;
  }): Promise<{
    institutions: DirectoryCard[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    await connectToDatabase();

    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(Math.max(1, query.pageSize ?? 20), DIRECTORY_MAX_PAGE_SIZE);

    const filter: Record<string, unknown> = { active: true, profileStatus: "PUBLISHED" };
    // `city` is a flat column with its own index (`InstitutionSchema.index({ city: 1 })`).
    // It is NOT `address.city`: the nested address object exists only in the
    // public projection's output, never in the stored document.
    if (query.city) filter.city = new RegExp(`^${escapeRegex(query.city)}$`, "i");
    if (query.board) filter["academic.board"] = query.board;
    if (query.type) filter.institutionType = query.type;
    if (query.q) {
      // Anchored to the start of a word, not a bare substring: "school" should
      // not match every institution whose name contains it mid-word, and an
      // unanchored regex over a growing collection cannot use an index at all.
      const term = escapeRegex(query.q);
      filter.$or = [
        { institutionName: new RegExp(`\\b${term}`, "i") },
        { shortName: new RegExp(`\\b${term}`, "i") },
      ];
    }

    const [rows, total] = await Promise.all([
      Institution.find(filter)
        .sort({ institutionName: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Institution.countDocuments(filter),
    ]);

    return {
      institutions: rows.map((row) => toDirectoryCard(row as unknown as Record<string, unknown>)),
      total,
      page,
      pageSize,
    };
  },

  async getPublicProfile(query: {
    institutionId?: string;
    slug?: string;
  }): Promise<PublicProfile | null> {
    await connectToDatabase();
    const key = query.institutionId
      ? { institutionId: query.institutionId.toUpperCase() }
      : { slug: (query.slug ?? "").toLowerCase() };
    const row = await Institution.findOne({
      ...key,
      active: true,
      profileStatus: "PUBLISHED",
    }).lean();
    if (!row) return null;
    // Derived offerings replace the stored arrays only when a tree exists, so
    // nothing disappears from a live public profile on release day.
    //
    // Achievements and alumni are separate collections rather than embedded
    // fields, so they cannot be projected off `row` — they are fetched here
    // and handed to the projection alongside `offerings`. `listPublic` (not
    // `list`) on both: it is the one that filters to ACTIVE and applies the
    // public sort, at the database, so a HIDDEN record is never fetched and
    // the projection downstream has no opportunity to leak one. All three
    // reads are independent, so they go together.
    const [offerings, achievements, alumni] = await Promise.all([
      AcademicStructureService.offeringsFor(row.institutionId),
      AchievementService.listPublic(row.institutionId),
      AlumniService.listPublic(row.institutionId),
    ]);
    return toPublicProfile(row as Record<string, unknown>, offerings ?? undefined, {
      achievements,
      alumni,
    });
  },

  async list(query: {
    q?: string;
    active?: boolean;
    page?: number;
    pageSize?: number;
  }): Promise<Paginated<InstitutionDTO>> {
    await connectToDatabase();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const filter: FilterQuery<InstitutionDoc> = {};
    if (query.active !== undefined) filter.active = query.active;
    if (query.q) {
      const pattern = new RegExp(escapeRegex(query.q), "i");
      filter.$or = [{ institutionId: pattern }, { institutionName: pattern }, { city: pattern }];
    }

    const [rows, total] = await Promise.all([
      Institution.find(filter)
        .sort({ institutionId: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Institution.countDocuments(filter),
    ]);

    return {
      items: rows.map((row) => serialize(row as InstitutionRow)),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  },

};
