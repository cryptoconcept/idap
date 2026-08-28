import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Vacancy, type VacancyDoc } from "@/models";
import { notFound } from "@/lib/api/errors";
import type { VacancyCreateInput, VacancyPatchInput } from "@/lib/validation/vacancy";
import { ActivityService } from "./activity.service";

export type VacancyDTO = {
  id: string;
  title: string;
  subject: string;
  description: string;
  salaryMin?: number;
  salaryMax?: number;
  experienceRequired?: number;
  facilities?: string[];
  status: string;
  createdAt?: string;
  updatedAt?: string;
};

/** A malformed id must read as "no such vacancy", not as a cast error. */
function toObjectId(vacancyId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(vacancyId)) throw notFound("Vacancy not found");
  return new Types.ObjectId(vacancyId);
}

/**
 * `??`, not `||` and not a truthiness check: `salaryMin`/`salaryMax`/
 * `experienceRequired` are legitimate at `0`, and `0 ?? undefined` is `0` —
 * only a stored `null`/`undefined` falls through to `undefined` here.
 */
function serialize(row: VacancyDoc): VacancyDTO {
  return {
    id: String(row._id),
    title: row.title,
    subject: row.subject,
    description: row.description,
    salaryMin: row.salaryMin ?? undefined,
    salaryMax: row.salaryMax ?? undefined,
    experienceRequired: row.experienceRequired ?? undefined,
    facilities: row.facilities?.length ? row.facilities : undefined,
    status: row.status ?? "DRAFT",
    createdAt: (row as VacancyDoc & { createdAt?: Date }).createdAt?.toISOString(),
    updatedAt: (row as VacancyDoc & { updatedAt?: Date }).updatedAt?.toISOString(),
  };
}

/**
 * The exact key set `vacancyPatchSchema` can produce. `institutionId` is
 * itself a schema path on `Vacancy` (`Vacancy.ts:6`), so Mongoose's update
 * path does not strip it from `$set` the way `strict` blocks an unknown
 * field — only Zod stripping unrecognised keys at the route layer stands
 * between an unparsed patch and a cross-tenant `$set`. This allow-list makes
 * that guarantee hold here too, in the service, rather than depending on
 * every future caller remembering to `.parse()` first. Defence in depth: the
 * route still parses, and still must.
 *
 * `status` is deliberately included: it is legitimately patchable (the whole
 * point of a vacancy's lifecycle is `DRAFT → OPEN → FILLED/CLOSED`), and
 * leaving it out of this set would make every status transition a silent
 * no-op — the vacancy would appear to move in the UI while the stored
 * document never changed.
 */
const PATCHABLE_FIELDS = new Set<keyof VacancyPatchInput>([
  "title",
  "subject",
  "description",
  "salaryMin",
  "salaryMax",
  "experienceRequired",
  "facilities",
  "status",
]);

/**
 * Three states, not two — same convention as `buildProfileUpdate`
 * (`institution.service.ts`). A key absent from the patch arrives as
 * `undefined` and is left alone: `$set: { salaryMin: undefined }` would
 * otherwise erase a stored value the caller never mentioned. A key carrying
 * a value is `$set`. A key explicitly `null` — which on `vacancyPatchSchema`
 * only `salaryMin`, `salaryMax` and `experienceRequired` accept — is
 * `$unset`, the documented way to clear a field, so it goes away entirely
 * rather than being stored as a literal null the DTO would have to keep
 * translating back. `facilities` is not clearable this way: `[]` already
 * expresses "none", so the three states never arise for it — a present
 * `facilities` is always `$set` to the given array, empty or not.
 */
function buildVacancyUpdate(patch: VacancyPatchInput): {
  set: Record<string, unknown>;
  unset: Record<string, "">;
} {
  const set: Record<string, unknown> = {};
  const unset: Record<string, ""> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE_FIELDS.has(key as keyof VacancyPatchInput)) continue;
    if (value === undefined) continue;
    if (value === null) unset[key] = "";
    else set[key] = value;
  }

  return { set, unset };
}

export const VacancyService = {
  async list(institutionId: string): Promise<VacancyDTO[]> {
    await connectToDatabase();
    const rows = await Vacancy.find({ institutionId })
      .sort({ createdAt: -1 })
      .lean<VacancyDoc[]>();
    return rows.map(serialize);
  },

  async create(
    institutionId: string,
    input: VacancyCreateInput,
    actor: { id: string; name: string },
  ): Promise<VacancyDTO> {
    await connectToDatabase();

    // `subject` is not re-validated here: the model's own enum constraint
    // (VACANCY_SUBJECTS) rejects an unrecognised value during
    // `Vacancy.create`'s validation pass, before anything is written — the
    // same defense-in-depth the schema already provides, not duplicated in
    // application code. Matches `ResultService.create`'s convention of
    // trusting an already-typed `CreateInput` rather than re-parsing it.
    //
    // `status` is not part of `VacancyCreateInput` (`vacancyCreateSchema` has
    // no `status` field) and is not reassigned here either — a fresh vacancy
    // gets the model's own default (`"DRAFT"`) rather than one asserted in
    // application code.
    const created = await Vacancy.create({ ...input, institutionId });

    await ActivityService.record({
      institutionId,
      entityType: "VACANCY",
      entityId: created._id,
      entityRef: institutionId,
      action: "Vacancy created",
      description: `${input.title} created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(created.toObject() as VacancyDoc);
  },

  async update(
    institutionId: string,
    vacancyId: string,
    patch: VacancyPatchInput,
    actor: { id: string; name: string },
  ): Promise<VacancyDTO> {
    await connectToDatabase();
    const objectId = toObjectId(vacancyId);

    const { set, unset } = buildVacancyUpdate(patch);

    // An empty patch has nothing for Mongo's `$set`/`$unset` to do (an empty
    // operator object is rejected server-side), so it is read-only — but
    // still institution-scoped, so a foreign or bad id still 404s. This is a
    // SEPARATE filter from the write below, and needs its own coverage: a
    // reachable path, since an all-optional patch schema means `{}` parses.
    if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
      const row = await Vacancy.findOne({ _id: objectId, institutionId }).lean<VacancyDoc>();
      if (!row) throw notFound("Vacancy not found");
      return serialize(row);
    }

    const update: Record<string, unknown> = {};
    if (Object.keys(set).length > 0) update.$set = set;
    if (Object.keys(unset).length > 0) update.$unset = unset;

    const updated = await Vacancy.findOneAndUpdate(
      { _id: objectId, institutionId },
      update,
      { new: true },
    ).lean<VacancyDoc>();
    if (!updated) throw notFound("Vacancy not found");

    await ActivityService.record({
      institutionId,
      entityType: "VACANCY",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Vacancy updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },

  async remove(
    institutionId: string,
    vacancyId: string,
    actor: { id: string; name: string },
  ): Promise<void> {
    await connectToDatabase();
    const objectId = toObjectId(vacancyId);

    const removed = await Vacancy.findOneAndDelete({
      _id: objectId,
      institutionId,
    }).lean<VacancyDoc>();
    if (!removed) throw notFound("Vacancy not found");

    await ActivityService.record({
      institutionId,
      entityType: "VACANCY",
      entityId: removed._id,
      entityRef: institutionId,
      action: "Vacancy deleted",
      description: `${removed.title} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },
};
