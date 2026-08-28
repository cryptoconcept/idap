/**
 * eduFleet vacancy mapping — the pure core.
 *
 * Turns one IDAP vacancy into the body either eduFleet job contract expects,
 * and — the point of this module — decides *before any network call* whether
 * eduFleet would reject it. No HTTP, no Mongoose, no imports from
 * `src/services/`: every function here is a plain `(inputs) -> value`
 * transform, trivially testable with plain objects.
 *
 * Why this matters more than a normal validator: eduFleet's `spendWrite()`
 * runs BEFORE any field validation on all four job routes (api-map §5), so a
 * `400` or a `409` permanently burns a daily write unit without creating a
 * job. **The two budgets are not the same budget.** Contract Two spends the
 * school's own grant (`PartnerGrant.dailyWriteCap`, 100/day) and the cost
 * lands on that school alone. Contract One spends `spendWrite(auth.partner)`
 * — the **Partner** document's 500/day pool (`models/Partner.ts`), which is
 * IDAP's single platform-wide budget, shared by every school on the platform
 * that has no eduFleet connection. A body that reliably 400s under Contract
 * One therefore degrades publishing for every OTHER unconnected school too,
 * which is why the checks below are not merely a courtesy to the school that
 * owns the vacancy. `preflight` is what stands between a malformed push and
 * that cost: every reason it returns is a write unit saved, and each is
 * worded for a school admin to act on, never as an error code.
 *
 * Contract One (`POST /api/partner/jobs`, platform key) requires
 * `externalJobId`, `title`, `subject`, `description`, `institutionName`,
 * `city` (api-map §2.1). Contract Two (`POST /api/partner/school/jobs`,
 * school grant) requires only `externalJobId`, `title`, `subject`,
 * `description`, and separately — this is FIX ROUND 1, corrected against
 * `SchoolJobInput` (`partner-school-jobs.ts:12-23`) read directly rather
 * than trusted from the plan — accepts optional `city` and `branchId` too:
 * `postSchoolJob` passes `location: input.city` into the same `createJob`
 * the school's own dashboard uses, and `createJob` defaults `location` to
 * `""` with NO fallback to the school's own record before throwing "Job
 * needs a location or branch" (`jobs.ts:38,59`). A Contract Two body with
 * neither `city` nor `branchId` fails every time, and because `spendWrite`
 * runs before validation it burns a write unit doing so — exactly the class
 * of loss `preflight` exists to prevent, so its location check now applies
 * to both contracts, not just `AGGREGATED` (see `preflight` below). Contract
 * Two still explicitly does NOT accept `institutionName`, `district`,
 * `state` or `sourceUrl` — the grant already identifies exactly one school,
 * so sending those is wrong, not merely redundant (api-map §2.3).
 * `state` defaults to `"Karnataka"` on eduFleet's own side for Contract One
 * only, so it is never injected here — only forwarded when IDAP has one.
 *
 * **`district` is not sent on either contract** — see
 * `buildAggregatedJobBody` for the whole reason. In short: eduFleet
 * exact-match validates it against 31 Karnataka display strings and IDAP's
 * district is free text, so forwarding it turns an ordinary profile typo into
 * a 400 that spends from the platform-wide pool above.
 */

import { VACANCY_BENEFITS, VACANCY_SUBJECTS } from "@/lib/constants";
import type { VacancyListingContract } from "@/lib/constants";

type Rec = Record<string, unknown>;

export type VacancyPushInput = {
  vacancyId: string;
  title: string;
  subject: string;
  description: string;
  salaryMin?: number;
  salaryMax?: number;
  experienceRequired?: number;
  facilities?: string[];
};

export type InstitutionPushInput = {
  institutionName: string;
  city?: string;
  /**
   * Forwarded to Contract One only, and — unlike `district`, which this type
   * deliberately does not have a field for at all — safe to send unchecked.
   * eduFleet never validates `state`: `createPartnerJob` reads it once, to
   * decide whether the Karnataka district/taluk checks apply
   * (`state.toLowerCase() === "karnataka"`), and otherwise stores it verbatim
   * on `Job.state`. There is no enum, no list and no rejection path for it,
   * so no value IDAP can hold here can cost a write unit on its own.
   */
  state?: string;
  // eduFleet accepts either `city` or `branchId` for Contract Two
  // (`SchoolJobInput`) — IDAP has no source for a branch id today, so this is
  // `undefined` in practice, but the type should not lie about what eduFleet
  // will take. Never invented from anything else on this type.
  branchId?: string;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const KNOWN_SUBJECTS = new Set<string>(VACANCY_SUBJECTS);
const KNOWN_BENEFITS = new Set<string>(VACANCY_BENEFITS);

/** Drops keys whose value is `undefined` so a produced body never carries a
 * key IDAP had nothing for — mirrors `passpercent-mapping.ts`'s
 * `omitUndefined`. */
function omitUndefined<T extends Rec>(obj: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Rec)[k] = v;
  }
  return out;
}

/**
 * Keeps only facilities eduFleet recognises, in `VACANCY_BENEFITS`'s
 * canonical order, de-duplicated — the same shape eduFleet's own
 * `sanitizeFacilities()` produces. eduFleet's version DISCARDS anything not
 * on its list silently, with no error and no signal back to the caller, so
 * this filter is what keeps an unrecognised label from ever leaving IDAP in
 * the first place.
 *
 * **M2: `undefined` in, `undefined` out — but `[]` in, `[]` out.** The two
 * inputs mean different things and the wire treats them differently. Absent
 * is "IDAP has nothing to say about benefits", and omitting the key leaves
 * eduFleet's copy alone. An empty array is "the school removed every
 * benefit", and eduFleet CAN apply that: both PATCH routes run
 * `sanitizeFacilities(patch.facilities)` and eduFleet's own version returns
 * `[]` for `[]` (`job-facilities.ts` — `JOB_FACILITIES.filter` over an empty
 * chosen set), so the key must be SENT as `[]` for the clear to land.
 * Returning `undefined` for both was why unticking every benefit spent a
 * write unit, changed nothing on the public advert, and warned nobody.
 *
 * An input whose every entry is unrecognised also yields `[]` rather than
 * `undefined`, which is the honest reading: IDAP holds nothing eduFleet can
 * show, so the advert should show nothing. It is unreachable through the API
 * anyway — `vacancyCreateSchema`/`vacancyPatchSchema` constrain facilities to
 * `z.enum(VACANCY_BENEFITS)`, which is byte-identical to eduFleet's list.
 */
function sanitizeFacilities(input: string[] | undefined): string[] | undefined {
  if (!input) return undefined;
  const chosen = new Set(input.filter((f) => KNOWN_BENEFITS.has(f)));
  return VACANCY_BENEFITS.filter((b) => chosen.has(b));
}

// ---------------------------------------------------------------------------
// Reasons shared by both preflights
//
// `preflight` (a create) and `preflightPatch` (an update) refuse different
// sets of things, because eduFleet's two route shapes validate different
// things — but where they refuse the SAME thing they must say it the same
// way, so the strings live here once rather than being typed twice.
// ---------------------------------------------------------------------------

const TITLE_REQUIRED = "A vacancy needs a title before it can be published to eduFleet";
const DESCRIPTION_REQUIRED = "A vacancy needs a description before it can be published to eduFleet";
const EXPERIENCE_NEGATIVE = "Experience required cannot be negative";
const SALARY_ORDER = "The salary minimum cannot exceed the maximum";

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

/**
 * Returns every human-readable reason this push **would** fail at eduFleet —
 * an empty array means send it. Never returns an error code: each string is
 * written to be read and acted on by a school admin, since that is where
 * `blockedReason` (the `listing` block Task 1 added) ultimately surfaces.
 *
 * Checks, in order: `title` non-empty, `description` non-empty, `subject` in
 * eduFleet's taxonomy (`VACANCY_SUBJECTS`), salary ordering when both bounds
 * are present, `experienceRequired` non-negative, `institutionName` present
 * for `AGGREGATED` only (Contract Two never carries one), and — for BOTH
 * contracts — a location, whose accepted shape differs by contract (FIX
 * ROUND 2): `AGGREGATED` requires `city` specifically, since Contract One's
 * `createPartnerJob` has no `branchId` field at all; `SCHOOL_POSTED` accepts
 * `city` OR `branchId` (FIX ROUND 1). Both branches share the same
 * user-facing message. FIX ROUND 1 also made this check apply to Contract Two
 * in the first place — see the module docblock's FIX ROUND 1 note for why a
 * locationless Contract Two body 400s every time and burns a write unit
 * doing it.
 *
 * Deliberately collects every applicable reason rather than stopping at the
 * first: a caller surfacing this to an admin wants the whole punch list in
 * one pass, not one round-trip per fixed field.
 */
export function preflight(
  v: VacancyPushInput,
  i: InstitutionPushInput,
  contract: VacancyListingContract,
): string[] {
  const reasons: string[] = [];

  if (v.title.trim().length === 0) {
    reasons.push(TITLE_REQUIRED);
  }
  if (v.description.trim().length === 0) {
    reasons.push(DESCRIPTION_REQUIRED);
  }
  if (!KNOWN_SUBJECTS.has(v.subject)) {
    reasons.push(`"${v.subject}" is not one of eduFleet's job subjects — pick one from the subject list`);
  }
  if (v.salaryMin !== undefined && v.salaryMax !== undefined && v.salaryMin > v.salaryMax) {
    reasons.push(SALARY_ORDER);
  }
  if (v.experienceRequired !== undefined && v.experienceRequired < 0) {
    reasons.push(EXPERIENCE_NEGATIVE);
  }

  if (contract === "AGGREGATED" && i.institutionName.trim().length === 0) {
    reasons.push("eduFleet needs an institution name before a job can be published");
  }

  // Location is required for BOTH contracts, but the accepted shape differs
  // by contract (FIX ROUND 2 — found reading fix round 1, not by a review;
  // not reachable today since IDAP has no source for `branchId`, but worth
  // closing anyway rather than leaving a known hole in a quota shield). A
  // `branchId`-only push under `AGGREGATED` must still be refused here: Contract
  // One's `createPartnerJob` requires `city` specifically (api-map §2.1) and
  // has no `branchId` field at all, so `buildAggregatedJobBody` never sends
  // one — a push that cleared a shared city-or-branchId check would 400 at
  // eduFleet with no location field present. Contract Two genuinely accepts
  // either (FIX ROUND 1). The message is shared across both branches and
  // deliberately never names a contract a school admin has never heard of.
  const hasCity = !!i.city && i.city.trim().length > 0;
  const hasBranchId = !!i.branchId && i.branchId.trim().length > 0;
  const hasLocation = contract === "AGGREGATED" ? hasCity : hasCity || hasBranchId;
  if (!hasLocation) {
    reasons.push("eduFleet needs a city on the institution profile before a job can be published");
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// preflightPatch
// ---------------------------------------------------------------------------

/** The salary pair eduFleet already holds for a listing, as far as IDAP
 *  knows — i.e. what it will merge an update against. */
export type RemoteJobSalary = { salaryMin?: number; salaryMax?: number };

/**
 * Explains the one refusal a school cannot work out from its own form: the
 * pair IS valid in IDAP, and would still be rejected, because eduFleet keeps
 * a bound this update does not mention and cannot clear.
 */
function mergedSalaryReason(v: VacancyPushInput, remote: RemoteJobSalary): string {
  return v.salaryMax === undefined
    ? `eduFleet still has a salary maximum of ${remote.salaryMax} on this listing and an update cannot clear it, so a minimum of ${v.salaryMin} would be rejected. Set a maximum of at least ${v.salaryMin}, or close this listing and publish it again.`
    : `eduFleet still has a salary minimum of ${remote.salaryMin} on this listing and an update cannot clear it, so a maximum of ${v.salaryMax} would be rejected. Set a minimum of at most ${v.salaryMax}, or close this listing and publish it again.`;
}

/**
 * `preflight` for an UPDATE rather than a create. Two things make it a
 * different function rather than a flag on the first one.
 *
 * **It checks fewer fields, because a PATCH carries fewer.** Neither update
 * route reads `subject`, `institutionName` or `city`
 * (`PartnerJobPatch`/`SchoolJobPatch` declare none of them, and
 * `updatePartnerJob`/`updateSchoolJob` never look), so refusing an update
 * over any of those would refuse a legitimate title or salary edit for a
 * field the request does not contain — a refusal that saves no write unit
 * because there was no rejection to prevent. What both routes DO check is
 * the title (`if (!patch.title.trim()) throw`) and the numbers; the
 * description is checked here too because neither route validates it and an
 * empty one would fail eduFleet's own `required` schema path
 * (`models/Job.ts:35`) as an uncataloged 500 — after taking the write unit.
 *
 * **It checks the salary against the MERGED record, not the sent one.**
 * eduFleet applies the patch and then validates what it holds
 * (`assertValidNumbers(job.salaryMin, job.salaryMax, ...)`,
 * `partner-jobs.ts:241` and `partner-school-jobs.ts:163`), so a lone
 * `salaryMin: 40000` sent against a stored maximum of 30000 is a 400 that
 * comparing only the sent values cannot see. `remote` is what eduFleet holds;
 * a bound absent from `v` is one this update will not mention, so eduFleet
 * keeps its own.
 *
 * A note that belongs with the mechanism rather than in a report: **there is
 * no way to clear a bound once it is published.** Both patch types declare
 * `salaryMin?: number` — never `null` — and both routes gate on
 * `!== undefined`, so an omitted bound means "unchanged" and there is no
 * value that means "remove". (A literal `null` would slip through today
 * only because the routes cast `await req.json()` with no runtime validation;
 * it is undeclared, untested on their side, and would break the moment they
 * add one, at the cost of a write unit each time. IDAP does not send it.)
 * A salary cleared in IDAP therefore stays on eduFleet's copy permanently,
 * and the two disagree until the listing is closed and republished.
 */
export function preflightPatch(v: VacancyPushInput, remote: RemoteJobSalary = {}): string[] {
  const reasons: string[] = [];

  if (v.title.trim().length === 0) {
    reasons.push(TITLE_REQUIRED);
  }
  if (v.description.trim().length === 0) {
    reasons.push(DESCRIPTION_REQUIRED);
  }
  if (v.experienceRequired !== undefined && v.experienceRequired < 0) {
    reasons.push(EXPERIENCE_NEGATIVE);
  }

  const effectiveMin = v.salaryMin ?? remote.salaryMin;
  const effectiveMax = v.salaryMax ?? remote.salaryMax;
  if (effectiveMin !== undefined && effectiveMax !== undefined && effectiveMin > effectiveMax) {
    // When both bounds are being sent, the pair the school can see is the
    // one at fault and the plain wording is right. Otherwise the inversion
    // exists only after the merge, and saying "minimum cannot exceed the
    // maximum" to someone whose form shows no maximum is unactionable.
    const bothSent = v.salaryMin !== undefined && v.salaryMax !== undefined;
    reasons.push(bothSent ? SALARY_ORDER : mergedSalaryReason(v, remote));
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// buildAggregatedJobBody — Contract One (POST /api/partner/jobs, platform key)
// ---------------------------------------------------------------------------

/**
 * Contract One's body: `externalJobId` (IDAP's own `vacancyId`), `title`,
 * `subject`, `description`, `institutionName`, `city`, plus optional `state`
 * when IDAP has one. `facilities` is filtered through `sanitizeFacilities`
 * above so nothing eduFleet would silently drop is ever sent. Call only after
 * `preflight` returns `[]` — this function does not itself validate.
 *
 * **`district` is deliberately absent, and this is the whole of the H2 fix.**
 * It used to be forwarded unconditionally and checked by nothing. eduFleet's
 * `createPartnerJob` does this:
 *
 *     const state = input.state?.trim() || "Karnataka";
 *     const isKarnataka = state.toLowerCase() === "karnataka";
 *     if (isKarnataka && district && !isValidKarnatakaDistrict(district))
 *       throw new ValidationError("Select a valid Karnataka district");
 *
 * `isValidKarnatakaDistrict` is an exact, case-sensitive `Object.hasOwn`
 * against 31 display strings in the current Kannada spellings
 * (`karnataka-taxonomy.ts`), and a BLANK state defaults to Karnataka — so
 * omitting the state opts in rather than out. IDAP's own district is free
 * text (`Institution.ts`, `optionalText(120)`, a bare `TextField` with no
 * dropdown), and the spellings schools actually type — `Bangalore`,
 * `Bangalore Urban`, `Bengaluru`, `Mysore`, `Belgaum`, `Mangalore`, `Tumkur`
 * — are every one of them a 400. Because `spendWrite` runs before validation,
 * each is a unit gone from the PLATFORM-WIDE 500/day pool (see this module's
 * docblock), so one school with a legacy district spelling in its profile
 * degrades publishing for every unconnected school on IDAP.
 *
 * Two ways to close that; this is the one taken and why.
 *
 * - **Drop the key.** `district` is optional to eduFleet and purely
 *   denormalised display text on `Job` — nothing filters, searches or matches
 *   on it. The cost is one line of address on the advert; `city` still
 *   carries the location a teacher actually reads, and `city` is required
 *   and already gated. The hazard disappears entirely: with no `district` in
 *   the body, `isKarnataka && district` is false and the check never runs
 *   whatever the state says. IDAP also never sends `taluk`, which is guarded
 *   by the same conditional, so nothing on this path can reach either check.
 * - **Transcribe the 31 keys and check them in `preflight`,** the way
 *   `VACANCY_SUBJECTS` and `VACANCY_BENEFITS` already are. Rejected. Those
 *   two are transcribed because the values are ones IDAP itself CHOOSES from
 *   a fixed list it controls, so a mismatch is a bug. A district is typed by
 *   a school into a free-text box, so the check would not save a doomed push
 *   — it would convert it into a hard local refusal that blocks publishing
 *   until an admin discovers eduFleet's exact preferred spelling, for a field
 *   that changes nothing about the advert. It would also add a 31-entry table
 *   to keep synchronised with a partner that has shipped breaking changes
 *   three times during this integration, and district/taluk boundaries change
 *   by government notification.
 *
 * Note what is NOT done: sending the key with an invalid value silently
 * dropped. That is the `sanitizeFacilities` antipattern — a body that says
 * less than the caller believes it says — and the key being absent from this
 * object entirely, rather than conditionally omitted, is what keeps it out.
 */
export function buildAggregatedJobBody(v: VacancyPushInput, i: InstitutionPushInput): Rec {
  return omitUndefined({
    externalJobId: v.vacancyId,
    title: v.title,
    subject: v.subject,
    description: v.description,
    institutionName: i.institutionName,
    city: i.city,
    state: i.state,
    salaryMin: v.salaryMin,
    salaryMax: v.salaryMax,
    experienceRequired: v.experienceRequired,
    facilities: sanitizeFacilities(v.facilities),
  });
}

// ---------------------------------------------------------------------------
// buildSchoolJobBody — Contract Two (POST /api/partner/school/jobs, grant)
// ---------------------------------------------------------------------------

/**
 * Contract Two's body: `externalJobId`, `title`, `subject`, `description`,
 * `city`/`branchId` when present, plus optional
 * `salaryMin`/`salaryMax`/`experienceRequired`/`facilities`.
 *
 * FIX ROUND 1: `city` (via `SchoolJobInput.city` -> `location`) was wrongly
 * excluded here on the earlier belief that Contract Two accepted no location
 * at all — verified false against `SchoolJobInput`
 * (`partner-school-jobs.ts:12-23`), which declares `city?: string` and
 * `branchId?: string`. Both are now sent when present. Still deliberately
 * never includes `institutionName`, `district`, `state` or `sourceUrl` — the
 * grant already identifies exactly one school, so eduFleet does not accept
 * any of those four on this route (api-map §2.3, and confirmed directly
 * against `SchoolJobInput`, which declares none of them).
 */
export function buildSchoolJobBody(v: VacancyPushInput, i: InstitutionPushInput): Rec {
  return omitUndefined({
    externalJobId: v.vacancyId,
    title: v.title,
    subject: v.subject,
    description: v.description,
    city: i.city,
    branchId: i.branchId,
    salaryMin: v.salaryMin,
    salaryMax: v.salaryMax,
    experienceRequired: v.experienceRequired,
    facilities: sanitizeFacilities(v.facilities),
  });
}
