import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Vacancy, type VacancyDoc } from "@/models";
import { notFound, validationError } from "@/lib/api/errors";
import { PLATFORM_LABELS, VACANCY_MAX_RECORDS } from "@/lib/constants";
import type { VacancyCreateInput, VacancyPatchInput } from "@/lib/validation/vacancy";
import { ActivityService } from "./activity.service";
import { VacancyPublishService, type VacancyPublishOutcome } from "./vacancy-publish.service";

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

const EDUFLEET_LABEL = PLATFORM_LABELS.EDUFLEET;

/**
 * Turns a reason into a complete sentence, so it reads naturally whether it
 * came from eduFleet's own wording (`blockedMessage`/`conflictMessage`,
 * which already end in a period) or from a caught error's raw `.message`
 * (`resolveTarget`'s refusal does not).
 */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Task 5: once a vacancy is published, its own `_id` IS eduFleet's
 * `externalJobId` — deleting it without closing the listing first would
 * orphan a live, publicly visible advert with no id left to close it.
 * Refusing the delete is still correct (an orphaned public advert is worse
 * than a vacancy that will not delete yet), but the refusal must never be a
 * dead end.
 *
 * A `SCHOOL_POSTED` listing is a job the school posted under its OWN
 * eduFleet account, so it stays closable there directly even when IDAP's own
 * route to it (its grant) is gone — the escape hatch that keeps this from
 * trapping a school that has since disconnected from eduFleet between a live
 * public advert and a row they cannot remove. An `AGGREGATED` listing was
 * posted under IDAP's platform key, not the school's own account, so no such
 * direct route is offered for it here; the only path is fixing whatever
 * blocked the close and trying again.
 */
function deleteRefusedAfterFailedClose(
  contract: string,
  reason: string,
): ReturnType<typeof validationError> {
  const why = asSentence(reason);
  const nextStep =
    contract === "SCHOOL_POSTED"
      ? `This listing was posted under your school's own ${EDUFLEET_LABEL} account, so you can also close it directly from your ${EDUFLEET_LABEL} dashboard — then delete this vacancy here.`
      : `Close the listing on ${EDUFLEET_LABEL}, then delete this vacancy.`;
  return validationError(
    `This vacancy could not be deleted: its ${EDUFLEET_LABEL} listing could not be closed first, and deleting it now would leave that listing live with nothing left to close it. ${why} ${nextStep}`,
  );
}

/**
 * Closes a vacancy's eduFleet listing before `remove` is allowed to delete
 * it. Resolves quietly when there is nothing to close (`NOT_LISTED`, no HTTP
 * call at all) or the close just succeeded (`CLOSED`) — both mean it is safe
 * to delete. Anything else — a `BLOCKED`/`CONFLICT` outcome, or an error
 * `pushClose` itself threw (the disconnected-`SCHOOL_POSTED` case chief among
 * them) — refuses the delete rather than risk an orphaned public advert.
 */
async function closeListingBeforeDelete(
  institutionId: string,
  vacancyId: string,
  contract: string,
  actor: { id: string; name: string },
): Promise<void> {
  let outcome: VacancyPublishOutcome;
  try {
    outcome = await VacancyPublishService.pushClose(institutionId, vacancyId, actor);
  } catch (error) {
    throw deleteRefusedAfterFailedClose(
      contract,
      error instanceof Error ? error.message : String(error),
    );
  }

  switch (outcome.status) {
    case "CLOSED":
    case "NOT_LISTED":
      return;
    case "BLOCKED":
    case "CONFLICT":
      throw deleteRefusedAfterFailedClose(contract, outcome.message);
    case "PUSHED":
      // `pushClose` never creates a listing, so this arm is unreachable in
      // practice. Guarded so the switch stays exhaustive under TypeScript
      // rather than a `default` that would silently swallow a future outcome
      // kind this function has never seen.
      throw deleteRefusedAfterFailedClose(
        contract,
        `${EDUFLEET_LABEL} did not confirm the listing was closed`,
      );
  }
}

export const VacancyService = {
  async list(institutionId: string): Promise<VacancyDTO[]> {
    await connectToDatabase();
    const rows = await Vacancy.find({ institutionId })
      .sort({ createdAt: -1 })
      // `create` already refuses the record past `VACANCY_MAX_RECORDS`, so
      // this is never what truncates a list built through the UI. It is
      // here for a collection that somehow holds more anyway — a direct
      // write, a future import, a cap lowered later — to bound the response
      // size and keep the sort a top-K sort rather than an unbounded one.
      .limit(VACANCY_MAX_RECORDS)
      .lean<VacancyDoc[]>();
    return rows.map(serialize);
  },

  async create(
    institutionId: string,
    input: VacancyCreateInput,
    actor: { id: string; name: string },
  ): Promise<VacancyDTO> {
    await connectToDatabase();

    // A cap on records per institution. Same `countDocuments` + 400 shape as
    // `AchievementService.create` / `AlumniService.create` /
    // `OfferService.create` / `ScholarshipService.create` — this repo's
    // existing answer for a per-institution whole-collection cap. The
    // count-then-create window is non-atomic: two simultaneous creates at
    // the boundary can both pass and land on `VACANCY_MAX_RECORDS + 1`
    // records, matching those precedents. The cap exists to bound the
    // dashboard list and the eduFleet sync payload to an order of
    // magnitude, not to guarantee an exact ceiling.
    const count = await Vacancy.countDocuments({ institutionId });
    if (count >= VACANCY_MAX_RECORDS) {
      throw validationError(
        `You can keep up to ${VACANCY_MAX_RECORDS} vacancies. Delete one to add another.`,
      );
    }

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

    // `vacancyPatchSchema`'s `salaryOrder` refine only ever sees ONE patch
    // payload — it cannot see a bound already stored from an earlier write.
    // A patch that touches only one bound (raising `salaryMin` on a record
    // whose `salaryMax` is already low, say) would otherwise write an
    // inverted pair unchecked here, and eduFleet's own `assertValidNumbers`
    // would then reject it at push time — a mysterious sync failure long
    // after the edit that caused it. So this merges the patch over the
    // STORED values (an explicit `null` clears a bound, same as the write
    // below) and re-checks the effective pair. Only fetched when the patch
    // can actually change either bound: every other patch (title, status,
    // ...) pays nothing for this.
    if (patch.salaryMin !== undefined || patch.salaryMax !== undefined) {
      const stored = await Vacancy.findOne({ _id: objectId, institutionId })
        .select("salaryMin salaryMax")
        .lean<Pick<VacancyDoc, "salaryMin" | "salaryMax">>();
      // A foreign or bad id: say nothing here, the write below 404s.
      if (stored) {
        const effectiveMin =
          patch.salaryMin !== undefined ? (patch.salaryMin ?? undefined) : stored.salaryMin;
        const effectiveMax =
          patch.salaryMax !== undefined ? (patch.salaryMax ?? undefined) : stored.salaryMax;
        if (effectiveMin != null && effectiveMax != null && effectiveMin > effectiveMax) {
          throw validationError("salary: the minimum may not exceed the maximum");
        }
      }
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

    // Task 5: once published, this vacancy's own id IS eduFleet's
    // `externalJobId` — deleting it out from under a live listing would
    // orphan a public advert with no id left to close it. Read before the
    // delete, tenant-scoped the same as the delete below, purely to learn
    // whether a listing exists and (if it does) which contract it is under —
    // `pushClose` itself is a no-op with no HTTP call when there is nothing
    // published, so this only ever reaches eduFleet when a listing is real.
    const existing = await Vacancy.findOne({ _id: objectId, institutionId })
      .select("listing")
      .lean<Pick<VacancyDoc, "listing">>();
    if (!existing) throw notFound("Vacancy not found");

    if (existing.listing) {
      await closeListingBeforeDelete(institutionId, vacancyId, existing.listing.contract, actor);
    }

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
