import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Vacancy, type VacancyDoc } from "@/models";
import { notFound, validationError } from "@/lib/api/errors";
import { PLATFORM_LABELS, VACANCY_MAX_RECORDS, isTerminalClaim } from "@/lib/constants";
import type { VacancyCreateInput, VacancyPatchInput } from "@/lib/validation/vacancy";
import { ActivityService } from "./activity.service";
import { ConnectorAuthError } from "@/lib/connectors/types";
import {
  EDUFLEET_PATCHABLE_KEYS,
  GRANT_REVOKED_MESSAGE,
  VacancyPublishService,
  toListingDTO,
  type VacancyListingDTO,
  type VacancyPublishOutcome,
} from "./vacancy-publish.service";

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
  /**
   * What eduFleet knows about this vacancy, absent until it is published.
   * The dashboard cannot show a school whether its advert is live, where to
   * read it, why the last push was refused, or that a cleared salary will not
   * propagate without this — every one of those is a fact about the LISTING,
   * not about the vacancy record, and the section that renders the card has no
   * other source for any of them.
   */
  listing?: VacancyListingDTO;
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
    // Built by `vacancy-publish.service.ts`'s own `toListingDTO` rather than
    // re-mapped here, so the listing a school reads on its dashboard and the
    // one a push hands back are the same shape by construction.
    listing: row.listing ? toListingDTO(row.listing) : undefined,
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
 * Whether this edit is worth a `PATCH` to eduFleet — spec §7's "**Edit** after
 * publish issues a `PATCH`", with the "after publish" doing real work.
 *
 * Three conditions, and each one exists to stop a specific wrong push:
 *
 * 1. **A live listing.** Nothing published means nothing to update, and an
 *    edit must never be what first puts a vacancy on a public jobs board
 *    (spec §10 — that takes an explicit school action). A CLOSED listing is
 *    excluded for the same reason: eduFleet cannot reopen an advert, so
 *    putting one back is a new publication, not an edit.
 * 2. **`OPEN`.** `repush` routes a `FILLED`/`CLOSED` vacancy to a CLOSE, so
 *    without this a school editing the title of a filled vacancy would take
 *    their advert down as a side effect of saving a typo fix. Whether a
 *    no-longer-open vacancy should come down is a real question, and the
 *    answer is the explicit "Close on eduFleet Exchange" button — not a
 *    surprise buried in a save.
 * 3. **The patch touches something eduFleet's PATCH would actually carry.**
 *    `spendWrite` runs before eduFleet validates, so every push costs a daily
 *    write unit whatever it contains — the school's own 100/day grant budget
 *    under Contract Two, or the platform-wide 500/day pool every unconnected
 *    school shares under Contract One. A status-only patch
 *    (which is exactly what the dashboard's status dropdown sends) and a
 *    subject-only patch (neither PATCH route accepts a subject) would both
 *    spend a unit to send eduFleet nothing it does not already have.
 *
 * The third condition reads the NEW VALUE, not just the key, and that is the
 * one subtlety worth stating. `salaryMin`/`salaryMax`/`experienceRequired` are
 * the three fields a patch may set to `null` to clear them — and a cleared
 * field is precisely the one thing a partner update cannot express: both patch
 * types declare `number`, never `null`, and both routes gate on
 * `!== undefined`, so IDAP's mapping module omits the key and eduFleet keeps
 * what it has. A patch whose ONLY eduFleet-carried change is such a clear
 * therefore cannot alter the advert by a single character, and pushing it
 * would spend a write unit to send eduFleet the values it already holds. The
 * school is told this at the moment they clear the field, in the edit dialog.
 */
function shouldPushEdit(patch: VacancyPatchInput, updated: VacancyDoc): boolean {
  if (!updated.listing || updated.listing.remoteStatus === "closed") return false;
  if (updated.status !== "OPEN") return false;
  return EDUFLEET_PATCHABLE_KEYS.some((key) => {
    const value = patch[key];
    // `undefined` is "not mentioned"; `null` is "clear it", which no partner
    // update can express. Everything else — including a genuine `0` — is a
    // change eduFleet will apply, so this must never be a truthiness check.
    return value !== undefined && value !== null;
  });
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
 *
 * Returns `true` when the advert was left LIVE because the close can never be
 * made — a terminal claim discovered by this very push. `remove` needs that
 * to say so in the audit trail, and the school needs it because otherwise the
 * first delete after a claim always fails: the close 403s, the claim state is
 * recorded, and only the SECOND attempt sees it. One refusal that has to be
 * repeated to clear is a trap with an extra step, not an exit.
 */
async function closeListingBeforeDelete(
  institutionId: string,
  vacancyId: string,
  contract: string,
  actor: { id: string; name: string },
): Promise<boolean> {
  let outcome: VacancyPublishOutcome;
  try {
    outcome = await VacancyPublishService.pushClose(institutionId, vacancyId, actor);
  } catch (error) {
    throw deleteRefusedAfterFailedClose(
      contract,
      // H3. The connection has already been dropped to DISCONNECTED by the
      // time this runs; the refusal still stands (a live advert with no id
      // left to close it is worse than a row that will not delete yet), but
      // the reason has to name the fix — reconnect — rather than repeating
      // the adapter's description of the fault.
      error instanceof ConnectorAuthError
        ? GRANT_REVOKED_MESSAGE
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }

  switch (outcome.status) {
    case "CLOSED":
    case "NOT_LISTED":
      return false;
    case "BLOCKED":
    case "CONFLICT":
      // A `403 claimed` whose real state the adapter just established as
      // terminal is not a close that FAILED — it is a close that can never be
      // made, on an advert that is no longer IDAP's to take down. The same
      // reasoning as the pre-read exception below, reached from the other
      // side: refusing here would protect nothing and would make the row
      // undeletable until a second attempt.
      if (isTerminalClaim(outcome.listing?.claimState)) return true;
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

    // Spec §7: an edit to a published vacancy issues a `PATCH`. Without this
    // the two sides drift silently and permanently — a school fixes a typo in
    // a title, sees the fix in IDAP, and their public advert keeps the old
    // one with nothing anywhere reporting the disagreement.
    //
    // Awaited, not fired and forgotten: the response this call returns is what
    // the dashboard renders, and the school has to see whether the push landed
    // (the fresh `lastPushedAt`) or did not (a `blockedReason` on the card).
    //
    // L1: the latency this buys is bounded at roughly 90 SECONDS, not the
    // connector's 15 s request timeout — `createConnectorHttp` retries a 429
    // once after an honoured `Retry-After` of up to 60 s, so the worst case is
    // 15 + 60 + 15. See `http.ts` for the arithmetic and for how that compares
    // with the platform's own function timeout. The edit itself is already
    // committed above, so a request cut off short loses the REPORT of the
    // push, never the edit.
    // `pushEdit` cannot throw, so a failed push never turns a saved edit into
    // a failed request — but it does write to the listing, which is why the
    // record is re-read below rather than the pre-push copy being returned.
    if (shouldPushEdit(patch, updated)) {
      await VacancyPublishService.pushEdit(institutionId, vacancyId, actor);
      const repushed = await Vacancy.findOne({ _id: objectId, institutionId }).lean<VacancyDoc>();
      // A vacancy deleted underneath this push is not this call's problem to
      // report: the edit really was applied, and the pre-push copy is an
      // accurate account of it.
      if (repushed) return serialize(repushed);
    }

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

    // Fix round 1: the delete below must not simply trust that what was just
    // observed still holds by the time it runs. Between this read and the
    // delete, a concurrent publish — a second tab, a double-click, a slow
    // publish request landing late — can attach a brand-new listing this
    // call never saw and therefore never tried to close: the exact
    // orphaned-public-advert failure this task exists to prevent, reached
    // through the one path the earlier version left open. The delete filter
    // re-states whatever was just observed as a CONDITION of the write, so
    // Mongo itself refuses the delete if that state no longer holds, rather
    // than this function merely hoping it still does.
    const deleteFilter: Record<string, unknown> = { _id: objectId, institutionId };

    // Fix round 1: a TERMINALLY CLAIMED listing is deleted without closing
    // it, and this is the one exception to Task 5's close-first rule.
    //
    // The rule exists because deleting IDAP's row destroys the only id that
    // could ever close the advert — an orphan nobody can take down. A claim
    // inverts that. Claiming moves the advert onto the school's OWN eduFleet
    // account: they can see it, edit it and close it from their own dashboard,
    // and IDAP cannot touch it at all — `pushClose` answers `403` and will
    // answer `403` forever. Refusing the delete therefore protects nothing
    // (the advert is already outside IDAP's reach and inside theirs) and costs
    // everything: the IDAP row becomes permanently undeletable, a trap with no
    // exit, which is exactly what Task 5 set out not to build.
    //
    // `isTerminalClaim` (`constants.ts`), not `=== "claimed"`, and it is the
    // fix wave's correction rather than a widening for its own sake.
    // `withdrawn` — an admin-approved takedown — is refused by
    // `updatePartnerJob` under the same one `403 claimed` reason, is equally
    // permanent, and has even less to protect: the advert is already down.
    // `claim_pending` stays OUT, because a rejected claim returns the job to
    // `unclaimed` and the advert becomes IDAP's problem again — deleting the
    // row over a claim that might not stand is how a live advert is orphaned.
    //
    // This is genuinely narrower than the disconnected-`SCHOOL_POSTED` case,
    // which still refuses. There, IDAP's inability is TEMPORARY — reconnecting
    // restores the grant and the close — so refusing has an exit and taking it
    // costs the school one reconnect. Here there is no reconnect that helps.
    //
    // What must not happen is a silent delete that reads as "nothing left
    // behind". The advert stays live until the school closes it on eduFleet,
    // so the confirmation dialog says so before they press Delete, and the
    // activity entry below records it after.
    let terminalClaim = isTerminalClaim(existing.listing?.claimState);

    if (existing.listing) {
      if (!terminalClaim) {
        // The close may itself be what DISCOVERS the claim: until a push
        // 403s, IDAP has no way to learn a school claimed its advert, so the
        // very first delete after a claim always arrives here with
        // `claimState` still reading `unclaimed`. `closeListingBeforeDelete`
        // reports back when that happened, so this attempt succeeds instead
        // of refusing and telling the school to try the same thing again.
        terminalClaim = await closeListingBeforeDelete(
          institutionId,
          vacancyId,
          existing.listing.contract,
          actor,
        );
      }
      // Conditioned on the SAME listing this call just closed still being
      // present — not "any listing" — because a fresh publish landing in
      // this exact window replaces the whole `listing` sub-document
      // (`recordSuccess`'s create branch) under a NEW `jobId`, and that new,
      // live listing must not be deleted out from under itself, unclosed.
      deleteFilter["listing.jobId"] = existing.listing.jobId;
    } else {
      // Conditioned on there still being nothing published, so a publish
      // landing in this exact window cannot slip a live, un-closed listing
      // through underneath a delete that observed none.
      deleteFilter.listing = { $exists: false };
    }

    const removed = await Vacancy.findOneAndDelete(deleteFilter).lean<VacancyDoc>();
    if (!removed) {
      // The conditional delete matched nothing even though `existing` proved
      // the vacancy was there moments ago — the state changed underneath
      // this call, not "no such vacancy". Re-reading and silently looping the
      // close-then-delete sequence here would risk looping indefinitely
      // against a vacancy under concurrent edits, and would hide from the
      // caller that anything happened at all. Refusing instead is bounded
      // and honest: the caller's retry re-enters `remove` from a fresh read —
      // exactly the check this function starts with — so it converges in one
      // more attempt once the race stops recurring.
      const stillThere = await Vacancy.exists({ _id: objectId, institutionId });
      if (!stillThere) throw notFound("Vacancy not found");
      throw validationError(
        "This vacancy changed while it was being removed — try deleting it again.",
      );
    }

    await ActivityService.record({
      institutionId,
      entityType: "VACANCY",
      entityId: removed._id,
      entityRef: institutionId,
      action: "Vacancy deleted",
      // A terminal claim leaves something behind, so the audit trail says
      // what and where — a bare "deleted" would read as "and the advert went
      // too". The two terminal states leave DIFFERENT things behind, so they
      // do not share a sentence: a claimed advert is live on the school's own
      // eduFleet account and only they can take it down, while a withdrawn
      // one is already off the public site by an admin takedown and there is
      // nothing for anyone to do. Saying "left live" about a withdrawn
      // listing would send someone looking for an advert that is not there.
      //
      // M-1: `removed`, not `existing`, and the two are not interchangeable
      // here. `existing` is a snapshot taken BEFORE the close, and the close
      // is frequently what discovers the terminal state — that is the whole
      // point of the discovery path above. By the time it returns,
      // `recordBlockedReason` has already written the true `claimState`, and
      // `findOneAndDelete` returns the document as it stood immediately
      // before deletion, so `removed` holds it. Reading the stale snapshot
      // described a withdrawn advert with the claimed sentence and sent the
      // next reader after a live listing that eduFleet had taken down.
      //
      // `existing` remains the right source for the `terminalClaim` DECISION
      // above: that one must not be led by the close, or a listing the close
      // merely failed on would start deleting itself.
      description: terminalClaim
        ? removed.listing?.claimState === "withdrawn"
          ? `${removed.title} deleted — its ${EDUFLEET_LABEL} advert had already been taken down there, so nothing was left behind`
          : `${removed.title} deleted — its claimed ${EDUFLEET_LABEL} advert was left live under the school's own ${EDUFLEET_LABEL} account`
        : `${removed.title} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },
};
