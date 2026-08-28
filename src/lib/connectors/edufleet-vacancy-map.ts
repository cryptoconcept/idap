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
 * `400` or a `409` permanently burns one of the school's daily write units —
 * 100/day on a school grant, 500/day on the platform key — without creating a
 * job. `preflight` is what stands between a malformed push and that cost:
 * every reason it returns is a write unit saved, and each is worded for a
 * school admin to act on, never as an error code.
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
  district?: string;
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
 * the first place. Returns `undefined` (rather than `[]`) when nothing
 * survives, so the caller can omit the key entirely.
 */
function sanitizeFacilities(input: string[] | undefined): string[] | undefined {
  if (!input || input.length === 0) return undefined;
  const chosen = new Set(input.filter((f) => KNOWN_BENEFITS.has(f)));
  const ordered = VACANCY_BENEFITS.filter((b) => chosen.has(b));
  return ordered.length > 0 ? ordered : undefined;
}

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
 * contracts — a location: `city` or `branchId`. FIX ROUND 1: the location
 * check used to be gated to `AGGREGATED`, on the mistaken belief Contract Two
 * needed neither. It does — see the module docblock's FIX ROUND 1 note for
 * why a locationless Contract Two body 400s every time and burns a write unit
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
    reasons.push("A vacancy needs a title before it can be published to eduFleet");
  }
  if (v.description.trim().length === 0) {
    reasons.push("A vacancy needs a description before it can be published to eduFleet");
  }
  if (!KNOWN_SUBJECTS.has(v.subject)) {
    reasons.push(`"${v.subject}" is not one of eduFleet's job subjects — pick one from the subject list`);
  }
  if (v.salaryMin !== undefined && v.salaryMax !== undefined && v.salaryMin > v.salaryMax) {
    reasons.push("The salary minimum cannot exceed the maximum");
  }
  if (v.experienceRequired !== undefined && v.experienceRequired < 0) {
    reasons.push("Experience required cannot be negative");
  }

  if (contract === "AGGREGATED" && i.institutionName.trim().length === 0) {
    reasons.push("eduFleet needs an institution name before a job can be published");
  }

  // Location is required for BOTH contracts (FIX ROUND 1 — see module
  // docblock): Contract One needs `city` directly; Contract Two needs
  // `city` OR `branchId`, and its own `createJob` throws with no fallback to
  // the school's own record when it gets neither. The message deliberately
  // never names a contract a school admin has never heard of.
  const hasCity = !!i.city && i.city.trim().length > 0;
  const hasBranchId = !!i.branchId && i.branchId.trim().length > 0;
  if (!hasCity && !hasBranchId) {
    reasons.push("eduFleet needs a city on the institution profile before a job can be published");
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// buildAggregatedJobBody — Contract One (POST /api/partner/jobs, platform key)
// ---------------------------------------------------------------------------

/**
 * Contract One's body: `externalJobId` (IDAP's own `vacancyId`), `title`,
 * `subject`, `description`, `institutionName`, `city`, plus optional
 * `district`/`state` when IDAP has them. `facilities` is filtered through
 * `sanitizeFacilities` above so nothing eduFleet would silently drop is ever
 * sent. Call only after `preflight` returns `[]` — this function does not
 * itself validate.
 */
export function buildAggregatedJobBody(v: VacancyPushInput, i: InstitutionPushInput): Rec {
  return omitUndefined({
    externalJobId: v.vacancyId,
    title: v.title,
    subject: v.subject,
    description: v.description,
    institutionName: i.institutionName,
    city: i.city,
    district: i.district,
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
