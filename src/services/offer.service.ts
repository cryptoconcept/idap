import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { AcademicUnit, Institution, Offer, type OfferDoc } from "@/models";
import { notFound, validationError } from "@/lib/api/errors";
import { OFFER_MAX_PER_INSTITUTION } from "@/lib/constants";
import {
  assertOfferInvariants,
  assertOfferPublishable,
  type CreateOfferInput,
  type UpdateOfferInput,
} from "@/lib/validation/offer";
import { assertOwnedAcademicUnit } from "@/lib/academic/assert-owned";
import { toPublicOffer, type PublicOffer } from "@/lib/offer/public-projection";
import { ActivityService } from "./activity.service";

export type OfferDTO = {
  id: string;
  title: string;
  description?: string;
  kind: string;
  value: number;
  code?: string;
  academicUnitId?: string;
  classOrCourse?: string;
  validFrom?: string;
  validUntil?: string;
  status: string;
  publishedAt?: string;
  updatedAt?: string;
};

/** A row with its label attached. The label is never stored — see `withLabels`. */
type OfferRow = OfferDoc & { classOrCourse?: string };

/** A malformed id must read as "no such offer", not as a 500. */
function toObjectId(offerId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(offerId)) throw notFound("Offer not found");
  return new Types.ObjectId(offerId);
}

/**
 * Offers store a unit id, not a label. Every read path passes its rows
 * through here, which fetches the referenced units in ONE query and attaches
 * each row's `classOrCourse` from the unit's current `pathLabel`.
 *
 * Rows with no `academicUnitId` are institution-wide and get no label at all.
 */
async function withLabels(institutionId: string, rows: OfferDoc[]): Promise<OfferRow[]> {
  if (rows.length === 0) return [];

  const unitIds = rows.map((row) => row.academicUnitId).filter(Boolean);
  const units = unitIds.length
    ? await AcademicUnit.find({ _id: { $in: unitIds }, institutionId })
        .select("_id pathLabel")
        .lean<{ _id: Types.ObjectId; pathLabel: string }[]>()
    : [];

  const labelById = new Map(units.map((unit) => [String(unit._id), unit.pathLabel]));

  return rows.map((row) => ({
    ...row,
    classOrCourse: row.academicUnitId ? labelById.get(String(row.academicUnitId)) : undefined,
  }));
}

function serialize(row: OfferRow): OfferDTO {
  return {
    id: String(row._id),
    title: row.title,
    description: row.description || undefined,
    kind: row.kind,
    value: row.value,
    code: row.code || undefined,
    academicUnitId: row.academicUnitId ? String(row.academicUnitId) : undefined,
    classOrCourse: row.classOrCourse || undefined,
    validFrom: row.validFrom?.toISOString(),
    validUntil: row.validUntil?.toISOString(),
    status: row.status,
    publishedAt: row.publishedAt?.toISOString(),
    updatedAt: (row as OfferDoc & { updatedAt?: Date }).updatedAt?.toISOString(),
  };
}

/** Every read is scoped by institutionId, so a foreign id is simply not found. */
async function findOwned(institutionId: string, offerId: string): Promise<OfferDoc> {
  const row = await Offer.findOne({
    _id: toObjectId(offerId),
    institutionId,
  }).lean<OfferDoc>();
  if (!row) throw notFound("Offer not found");
  return row;
}

/**
 * A key absent from a patch arrives as `undefined` and must be left alone —
 * `$set: { value: undefined }` would otherwise erase a stored value the
 * caller never mentioned.
 */
function stripUndefined<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

const ACTION_LABELS: Record<"publish" | "unpublish" | "archive", string> = {
  publish: "published",
  unpublish: "unpublished",
  archive: "archived",
};

export const OfferService = {
  async list(institutionId: string): Promise<OfferDTO[]> {
    await connectToDatabase();
    const rows = await Offer.find({ institutionId })
      .sort({ createdAt: -1 })
      .lean<OfferDoc[]>();
    return (await withLabels(institutionId, rows)).map(serialize);
  },

  /**
   * Returns null when the institution is not publicly visible at all — the
   * caller turns that into a 404. An empty array means "visible, but nothing
   * published", a 200. The visibility gate matches the profile, results and
   * fees endpoints' exactly, so an offer can never be reachable on an
   * institution whose profile 404s.
   */
  async listPublic(query: {
    institutionId?: string;
    slug?: string;
  }): Promise<PublicOffer[] | null> {
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

    const rows = await Offer.find({
      institutionId: institution.institutionId,
      status: "PUBLISHED",
      // Two clauses, not three: `{ validUntil: null }` matches an ABSENT field
      // as well as an explicitly-null one, so a separate `$exists: false`
      // clause would be redundant. Verified against mongodb-memory-server.
      $or: [{ validUntil: null }, { validUntil: { $gte: new Date() } }],
    })
      .sort({ createdAt: -1 })
      .lean<OfferDoc[]>();

    // The projection is the allow-list; it also re-checks PUBLISHED, so a
    // filter mistake here cannot leak an unpublished record.
    return (await withLabels(institution.institutionId, rows))
      .map((row) => toPublicOffer(row as unknown as Record<string, unknown>))
      .filter((row): row is PublicOffer => row !== null);
  },

  async get(institutionId: string, offerId: string): Promise<OfferDTO> {
    await connectToDatabase();
    const row = await findOwned(institutionId, offerId);
    const [enriched] = await withLabels(institutionId, [row]);
    return serialize(enriched);
  },

  async create(
    institutionId: string,
    input: CreateOfferInput,
    actor: { id: string; name: string },
  ): Promise<OfferDTO> {
    await connectToDatabase();

    assertOfferInvariants({
      kind: input.kind,
      value: input.value,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
    });

    const count = await Offer.countDocuments({ institutionId });
    if (count >= OFFER_MAX_PER_INSTITUTION) {
      throw validationError(
        `You can keep up to ${OFFER_MAX_PER_INSTITUTION} offers. Delete one to add another.`,
      );
    }

    const unit = await assertOwnedAcademicUnit(institutionId, input.academicUnitId);

    const created = await Offer.create({ ...input, institutionId, status: "DRAFT" });

    await ActivityService.record({
      institutionId,
      entityType: "OFFER",
      entityId: created._id,
      entityRef: institutionId,
      action: "Offer created",
      description: `${input.title} created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize({
      ...(created.toObject() as OfferDoc),
      // Derived inline from the unit already loaded above rather than via
      // `withLabels`, which would re-query it. The two must agree: any change
      // to how `withLabels` builds a label belongs here too, or a create
      // response will disagree with the very next read.
      classOrCourse: unit?.pathLabel,
    });
  },

  async update(
    institutionId: string,
    offerId: string,
    patch: UpdateOfferInput,
    actor: { id: string; name: string },
  ): Promise<OfferDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, offerId);

    await assertOwnedAcademicUnit(institutionId, patch.academicUnitId);

    const set = stripUndefined(patch);

    // A published offer must stay publishable: a patch that blanks the title
    // or zeroes the value would otherwise leave it publicly visible broken.
    const merged = { ...before, ...set };
    if (before.status === "PUBLISHED") {
      assertOfferPublishable({
        title: merged.title,
        kind: merged.kind,
        value: merged.value,
        validFrom: merged.validFrom,
        validUntil: merged.validUntil,
      });
    } else {
      assertOfferInvariants({
        kind: merged.kind,
        value: merged.value,
        validFrom: merged.validFrom,
        validUntil: merged.validUntil,
      });
    }

    const updated = await Offer.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<OfferDoc>();
    if (!updated) throw notFound("Offer not found");
    const [enriched] = await withLabels(institutionId, [updated]);

    await ActivityService.record({
      institutionId,
      entityType: "OFFER",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Offer updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(enriched);
  },

  async setStatus(
    institutionId: string,
    offerId: string,
    action: "publish" | "unpublish" | "archive",
    actor: { id: string; name: string },
  ): Promise<OfferDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, offerId);

    const status = action === "publish" ? "PUBLISHED" : action === "archive" ? "ARCHIVED" : "DRAFT";

    if (action === "publish") {
      assertOfferPublishable({
        title: before.title,
        kind: before.kind,
        value: before.value,
        validFrom: before.validFrom,
        validUntil: before.validUntil,
      });
    }

    const set: Record<string, unknown> = { status };
    // Stamped on first publication and never moved: it records when this
    // offer was first made public, not when it was last touched.
    if (action === "publish" && !before.publishedAt) set.publishedAt = new Date();

    const updated = await Offer.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<OfferDoc>();
    if (!updated) throw notFound("Offer not found");
    const [enriched] = await withLabels(institutionId, [updated]);

    await ActivityService.record({
      institutionId,
      entityType: "OFFER",
      entityId: updated._id,
      entityRef: institutionId,
      action: `Offer ${ACTION_LABELS[action]}`,
      description: enriched.title,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(enriched);
  },

  async remove(
    institutionId: string,
    offerId: string,
    actor: { id: string; name: string },
  ): Promise<void> {
    await connectToDatabase();
    const before = await findOwned(institutionId, offerId);

    await Offer.deleteOne({ _id: before._id, institutionId });

    await ActivityService.record({
      institutionId,
      entityType: "OFFER",
      entityId: before._id,
      entityRef: institutionId,
      action: "Offer deleted",
      description: `${before.title} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },
};
