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
 * **`district` is sent on Contract One, and only after IDAP has resolved it
 * to one of eduFleet's own 31 keys** — see `resolveDistrict` and
 * `buildAggregatedJobBody` for the whole reason. Contract Two neither accepts
 * it nor ever gains it.
 *
 * Both builders therefore return `{ body, warnings }` rather than a bare
 * body, matching `passpercent-mapping.ts`'s `(inputs) -> { value, warnings }`
 * shape. A warning is what the module says when it sent LESS than the caller
 * handed it: the alternative — dropping a key quietly — is the
 * `sanitizeFacilities` antipattern this module exists to avoid, and the
 * function that drops the key is the only one that can be trusted to report
 * the drop.
 */

import { EDUFLEET_KARNATAKA_DISTRICTS, VACANCY_BENEFITS, VACANCY_SUBJECTS } from "@/lib/constants";
import type { VacancyListingContract } from "@/lib/constants";

type Rec = Record<string, unknown>;

/**
 * A body, plus every place it says less than the values handed in did.
 *
 * Empty on the overwhelming majority of pushes. It exists because exactly one
 * field IDAP holds — `district` — is free text on IDAP's side and a closed
 * enum on eduFleet's, so it is the one field a correct body may have to leave
 * out; see `resolveDistrict`.
 */
export type BuiltJobBody = { body: Rec; warnings: string[] };

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
   * The institution profile's district **exactly as the school typed it** —
   * raw free text, never pre-cleaned by the caller. `buildAggregatedJobBody`
   * is what resolves it against eduFleet's 31 keys and decides whether to
   * send it, and it must see the original to be able to name it in a warning.
   *
   * Contract Two has no field for this and never will: `SchoolJobInput`
   * declares no `district`, and the grant already identifies the school.
   */
  district?: string;
  /**
   * Forwarded to Contract One only, and — unlike `district` — safe to send
   * completely unchecked. eduFleet never validates `state`:
   * `createPartnerJob` reads it once, to decide whether the Karnataka
   * district/taluk checks apply (`state.toLowerCase() === "karnataka"`), and
   * otherwise stores it verbatim on `Job.state`. There is no enum, no list
   * and no rejection path for it, so no value IDAP can hold here can cost a
   * write unit on its own.
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
// District — the one free-text field eduFleet validates against a closed list
// ---------------------------------------------------------------------------

/**
 * Case, leading/trailing space and runs of internal whitespace are all things
 * a typist varies and nothing about a district actually means, so they are
 * normalised away before either lookup below. Everything else — spelling,
 * punctuation, word order — is left alone, because varying any of those is a
 * DIFFERENT value and guessing at it is what step 4 of this design refuses to
 * do.
 */
function foldDistrict(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Folded form → the canonical key spelling eduFleet's `Object.hasOwn` wants.
 *  Derived from the transcribed list so the two can never disagree. */
const CANONICAL_DISTRICTS = new Map<string, string>(
  EDUFLEET_KARNATAKA_DISTRICTS.map((name) => [foldDistrict(name), name]),
);

/**
 * The 2014 Karnataka district renames, and nothing else.
 *
 * Every entry is an official rename of a DISTRICT whose old name refers to
 * exactly one district on eduFleet's current list, so resolving it involves no
 * guess about what the school meant — the place is the same place and only its
 * transliteration changed. These are also the spellings still printed on
 * letterheads, so they are what a school types.
 *
 * Three families of near-miss are deliberately NOT here, because each would
 * require inventing intent:
 *
 * - **`Bangalore` alone is AMBIGUOUS** between `Bengaluru Urban` and
 *   `Bengaluru Rural`, which are two different districts with two different
 *   sets of teachers. `Bangalore Urban`/`Bangalore Rural` carry the
 *   disambiguator themselves and are safe; the bare name is not, and falls
 *   through to the warning like any other unrecognised value. `Bengaluru`
 *   alone is the same case and is likewise absent.
 * - **A city typed into the district box.** `Mangalore`/`Mangaluru` is a city
 *   in `Dakshina Kannada`, and `Hospet`/`Hosapete` is a taluk of
 *   `Vijayanagara` (`karnataka-taxonomy.ts` lists it under that district's
 *   taluks) — neither was ever a district name, so mapping them would be
 *   IDAP deciding what a school meant rather than what it wrote.
 * - **Ordinary misspellings.** `Bengalore`, `Mysoore`. Correcting those is
 *   spellchecking, and a spellchecker that is wrong once sends an advert to
 *   the wrong district's teachers permanently and silently.
 *
 * Keyed by folded form so the alias itself is matched case- and
 * whitespace-insensitively, exactly like a canonical key.
 */
const DISTRICT_ALIASES = new Map<string, string>(
  (
    [
      ["Bangalore Urban", "Bengaluru Urban"],
      ["Bangalore Rural", "Bengaluru Rural"],
      ["Belgaum", "Belagavi"],
      ["Bellary", "Ballari"],
      ["Bijapur", "Vijayapura"],
      ["Chikmagalur", "Chikkamagaluru"],
      ["Gulbarga", "Kalaburagi"],
      ["Mysore", "Mysuru"],
      ["Shimoga", "Shivamogga"],
      ["Tumkur", "Tumakuru"],
    ] as const
  ).map(([legacy, canonical]) => [foldDistrict(legacy), canonical]),
);

/**
 * IDAP's free-text district → the key eduFleet will accept, or `undefined`.
 *
 * This is the whole of the district design, and it exists because the two
 * obvious options are both wrong. Sending the raw text 400s for every legacy
 * spelling, and — since `spendWrite` runs before validation — takes a unit
 * from the PLATFORM-WIDE pool each time, so one school's profile typo
 * degrades publishing for every unconnected school. Dropping the field
 * outright looks free and is not: `createPartnerJob` ends with
 * `notifyMatchingTeachers(job)` (`partner-jobs.ts:185`), and both matchers in
 * `job-match-logic.ts` read `job.district` —
 *
 *     // jobLocationMatchesTeacher
 *     if (jobDistrict && teacherDistrict) return jobDistrict === teacherDistrict;
 *     // ...otherwise the job's free-text CITY vs the teacher's cities
 *
 *     // jobMatchesSavedAlert
 *     if (jobDistrict ? jobDistrict !== target : jobCity !== target) return false;
 *
 * — so an advert with no district falls back to comparing a city string
 * against a district name. For a district-scoped saved alert that is a
 * guaranteed miss for all but the handful of districts named after their own
 * city, which means a school with a perfectly valid district loses
 * district-scoped alerts entirely. That is a permanent, silent reach
 * regression paid by every correctly-configured school to close a hazard only
 * the misconfigured ones create.
 *
 * So: resolve locally, send what resolves, omit and warn about what does not.
 * An unresolved district is never a refusal — see `preflight`, which
 * deliberately has no district check. The advert is entirely publishable
 * without one; refusing locally would block a publish over optional metadata
 * and would start blocking legitimate publishes the day Karnataka notifies a
 * new district. Under this design that same drift degrades to exactly the
 * omit-and-warn behaviour above, which is why a transcribed table is safe to
 * keep against a partner that has shipped breaking changes three times.
 *
 * Returns the CANONICAL spelling, never the input: `isValidKarnatakaDistrict`
 * is `Object.hasOwn`, so `bengaluru urban` must go over the wire as
 * `Bengaluru Urban` or it 400s exactly like an unknown name.
 */
export function resolveDistrict(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const folded = foldDistrict(value);
  if (!folded) return undefined;
  return CANONICAL_DISTRICTS.get(folded) ?? DISTRICT_ALIASES.get(folded);
}

/**
 * What the school is told when their district did not resolve.
 *
 * Written like every other string in this module — for a school admin to act
 * on, naming the value that failed and the exact consequence, never an error
 * code. The consequence is specific on purpose: "matched by city alone" is
 * what `jobLocationMatchesTeacher` actually falls back to, and naming
 * district-scoped alerts is what tells an admin why an advert that looks live
 * is reaching nobody.
 *
 * The district is user-entered text on its way to a browser toast, so it is
 * clipped on the same principle `vacancy-publish.service.ts` clips
 * `blockedReason`: `Institution.district` has no `maxlength` on the schema
 * (only `optionalText(120)` on the write path), so a legacy row can be longer
 * than any value the form would accept today.
 */
function districtOmittedWarning(district: string): string {
  return `eduFleet does not recognise "${district.trim().slice(0, 120)}" as a Karnataka district, so this advert was published without one — teachers who search or set job alerts by district will not be matched to it until the district on the institution profile is corrected.`;
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
 *
 * **There is deliberately no `district` check here, and there must not be
 * one.** `district` is the one field this module resolves rather than
 * validates (`resolveDistrict`), because an unresolved district cannot cost a
 * write unit — `buildAggregatedJobBody` omits it, so eduFleet's
 * `isKarnataka && district && …` conjunction never fires — and the advert is
 * entirely publishable without it. A reason returned here is a REFUSAL: it
 * blocks the publish outright. Refusing over optional display-and-matching
 * metadata would trade a reach limitation for a hard failure, and would start
 * blocking legitimate publishes the day Karnataka notifies a new district.
 * The city gate stays exactly as it is; a district gate would be a different
 * thing wearing its clothes.
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
 * and `district` when IDAP has them. `facilities` is filtered through
 * `sanitizeFacilities` above so nothing eduFleet would silently drop is ever
 * sent. Call only after `preflight` returns `[]` — this function does not
 * itself validate.
 *
 * **`district` is resolved before it is sent, and omitted with a warning when
 * it cannot be.** eduFleet's `createPartnerJob` does this:
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
 * text (`institution.ts`'s `optionalText(120)`, a bare `TextField` with no
 * dropdown), so the raw value must never be forwarded: the spellings schools
 * actually type would 400, at a unit each from the PLATFORM-WIDE 500/day pool
 * (see this module's docblock).
 *
 * An earlier fix removed the field entirely on the stated ground that it is
 * "purely denormalised display text — nothing filters, searches or matches on
 * it". **That is false at source, and `resolveDistrict` carries the
 * refutation**: `createPartnerJob` ends with `notifyMatchingTeachers(job)`
 * and both matchers read `job.district`, so dropping it silently removes
 * every IDAP advert from eduFleet's district matching and from
 * district-scoped saved alerts — for every school, including the majority
 * whose district was valid and whose pushes never 400'd. Resolving locally
 * keeps that reach for them and costs the rest nothing but a warning.
 *
 * Note what is still NOT done: sending the key with an invalid value quietly
 * dropped. That is the `sanitizeFacilities` antipattern — a body that says
 * less than the caller believes it says — and the returned `warnings` is what
 * keeps this out of it. The omission is reported by the same call that makes
 * it, so there is no arrangement in which one happens without the other.
 */
export function buildAggregatedJobBody(v: VacancyPushInput, i: InstitutionPushInput): BuiltJobBody {
  const district = resolveDistrict(i.district);
  return {
    body: omitUndefined({
      externalJobId: v.vacancyId,
      title: v.title,
      subject: v.subject,
      description: v.description,
      institutionName: i.institutionName,
      city: i.city,
      district,
      state: i.state,
      salaryMin: v.salaryMin,
      salaryMax: v.salaryMax,
      experienceRequired: v.experienceRequired,
      facilities: sanitizeFacilities(v.facilities),
    }),
    // Only when IDAP HELD a district and it did not resolve. A school that
    // has never filled the field in has nothing to correct and is told
    // nothing — a warning for an empty optional field is noise that teaches
    // admins to dismiss the ones that matter.
    warnings: i.district?.trim() && !district ? [districtOmittedWarning(i.district)] : [],
  };
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
 *
 * `warnings` is therefore always empty here, and that is structural rather
 * than a placeholder: `district` is the only field IDAP has to resolve before
 * sending, this route does not accept it, and nothing else on this body can
 * be dropped. The pair shape is shared with `buildAggregatedJobBody` so the
 * one call site that picks between them by contract does not have to know
 * which of the two it got.
 */
export function buildSchoolJobBody(v: VacancyPushInput, i: InstitutionPushInput): BuiltJobBody {
  return {
    body: omitUndefined({
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
    }),
    warnings: [],
  };
}
