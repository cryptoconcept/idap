# eduFleet Exchange — job-push surface re-verification

**Date: 2026-08-28.** Re-verification of `docs/integrations/edufleet-api-map.md`
sections 2.1–2.4, 3, 4, 5 and 6 against eduFleet Exchange source at commit
`e580f17` (`fix: catch ValidationError on the redeem route, not just
ConnectionError`, 2026-08-28 17:35 IST) in `/Users/automicai/edufleet-exchange`.

This is a **report only**. The api-map was not modified. Nothing in the eduFleet
repo was modified, no dev server was started, and no database was touched — every
finding below is a source read, and the three claims that could only be settled by
executing a request are marked UNVERIFIABLE rather than asserted.

All paths below are relative to `/Users/automicai/edufleet-exchange/web/src/`
unless stated otherwise.

## Tally

| Verdict | Count |
|---|---|
| CONFIRMED | 66 |
| STALE | 11 |
| UNVERIFIABLE | 3 |

Counted as discrete claim-verdicts: every row of every verdict table below plus the
four prose verdicts (§6.1, §6.2's `sanitizeFacilities`, Q2, Q7). The 11 STALE
findings are S1–S11 in the summary table; four of them (S1, S4, S6, S8) also appear
as a verdict cell in the section table they belong to.

## Headline answer to the highest-risk question

**A grant minted with `jobs:write` alone still satisfies every job endpoint.**
`requireGrant` gained OR-scopes (`partner-auth.ts:114`, `scope: string | string[]`),
but both job routes still pass the bare string `"jobs:write"`:

- `app/api/partner/school/jobs/route.ts:12` — `const auth = await requireGrant(req, "jobs:write");`
- `app/api/partner/school/jobs/[id]/route.ts:9` — `const auth = await requireGrant(req, "jobs:write");`

The `listings:write` scope was added to `PARTNER_SCOPES` (`models/Partner.ts:5`)
and is demanded only by the three listings routes. The OR-array form is used in
exactly three places, and a `jobs:write` grant satisfies all three:
`app/api/partner/school/route.ts:9` (`["jobs:write", "listings:write"]`),
`app/api/partner/whoami/route.ts:15` and `app/api/partner/schema/route.ts:17`
(both `[...PARTNER_SCOPES]`). **IDAP's shipped connector, which requests
`jobs:write` and nothing else, is correctly scoped for the entire job-push
surface.** No change to `REQUESTED_SCOPES` is needed.

The reason this held is worth recording: none of the 12 commits between the map's
authorship and `e580f17` touched `lib/services/partner-jobs.ts`,
`lib/services/partner-school-jobs.ts`, `models/Job.ts`, `app/api/partner/jobs/**`
or `app/api/partner/school/jobs/**`. The job-push core is byte-identical to what
the map was written against. Everything stale below is either a claim the map got
wrong on the day, or drift in the shared layers the job routes call into
(`partner-auth.ts`, `partner-contract.ts`, `app/api/partner/school/route.ts`).

---

## Summary table — every STALE finding, most consequential first

| # | Map section | What the map says | What the source says | Where |
|---|---|---|---|---|
| S1 | §2.3, §3 | `schoolJob` "Required (per `SchoolJobInput`): `externalJobId`, `title`, `subject`, `description`" — implying all four are enforced with the documented `400 validation_failed` | Only `externalJobId` and `subject` produce a documented 400. A missing `title` or `description` reaches `Job.create()` and throws a Mongoose `ValidationError` the route has no branch for, so it escapes as an **uncataloged 500 with no `reason`** — after `spendWrite` has already consumed a daily write unit | `partner-school-jobs.ts:64`; `services/jobs.ts:33`, `:71-88`; `models/Job.ts:31`, `:35`; `app/api/partner/school/jobs/route.ts:39-52` |
| S2 | §5 | Error catalog covers the failures reachable from these routes | Two failure modes on the job routes are absent from the catalog: (a) any Mongoose validation/cast failure → bare 500; (b) a **401 for a missing, malformed or unknown token carries no `reason` field at all** | `partner-auth.ts:95`, `:96`, `:99`, `:102`, `:116`, `:117`, `:120`, `:123`; `partner-auth.ts:46-51` |
| S3 | §1.4, §2.1–2.4 | "Only **write** routes call `spendWrite` (POST/PATCH); reads (GET) never touch the daily cap" — silent on ordering | `spendWrite` runs **before any field validation and before the dedupe check** on all four job routes. Every `400 validation_failed` and every `409 duplicate_external_job` permanently consumes a unit of the daily write cap | `app/api/partner/jobs/route.ts:21`; `jobs/[externalJobId]/route.ts:22`; `school/jobs/route.ts:22`; `school/jobs/[id]/route.ts:20` |
| S4 | §2.2, §5 | `403 claimed` reads as permanent — eduFleet's own catalog says "a platform key can no longer edit it" | **Two of the four triggers are reversible.** `claim_pending` returns to `unclaimed` when an admin rejects the claim; `hiddenPendingReview` returns to `false` when an admin restores a takedown. Only `claimed` and `withdrawn` are terminal | `claim-review.ts:92`; `takedowns.ts:45-48`; vs `claim-review.ts:45`, `takedowns.ts:43` |
| S5 | §6.3 | "The full **29-district** → taluk table" | **31 districts.** Full verbatim list in §6.3 below | `karnataka-taxonomy.ts:7-39` (31 keys) |
| S6 | §6.5 | "`state` defaults to `\"Karnataka\"` when omitted (**both contracts**)" | Contract One only. `createJob()` never writes `state`, `SchoolJobInput` has no `state` field, and `models/Job.ts:57` declares no default — a Contract-Two job's `state` is `undefined` | `services/jobs.ts:71-88`; `partner-school-jobs.ts:12-23`; `models/Job.ts:57` vs `partner-jobs.ts:110` |
| S7 | §2 table, §2.5 | `/api/partner/school` GET, credential "grant" | Now OR-scoped `["jobs:write", "listings:write"]`, and the response body is assembled per-scope: `schoolId`/`schoolName`/`city` always, the §2.5 snapshot only under `jobs:write`, plus a `listings` key under `listings:write` | `app/api/partner/school/route.ts:9`, `:13-21` |
| S8 | §2.4 | Lists `status` alongside `title`, `description`, salary, experience, `facilities` as co-patchable | `status: "closed"` **short-circuits**: `updateSchoolJob` returns `closeJob(...)` immediately, so every other field in the same body is silently discarded and the 200 reports the pre-patch `title` | `partner-school-jobs.ts:147-152` |
| S9 | §5 | Catalog presented as "verbatim", with `duplicate_external_listing` and `listing_not_approved` "at the bottom" | Live order differs: `duplicate_external_listing` is the 11th entry and `listing_not_approved` the 15th. Two `meaning` strings in the map also carry parenthetical additions absent from the code | `partner-contract.ts:92`, `:96`, `:91`, `:100` |
| S10 | §1, §1.4 | Citations `partner-auth.ts:36-44` (`readBearer`), `:55-67` (`RATE_LIMIT_PER_MIN`), `:131-160` (`spendWrite`) | All drifted **+18 lines** — `mongooseValidationError()` was inserted at `:46` by commit `6645363`. Now `:53-62`, `:73-85`, `:155-185` | `partner-auth.ts:46-51` |
| S11 | §4, §6.1 | Dedupe index cited as `partner-jobs.ts:83-88`; subject enum as `taxonomy.ts:20-28` | `partner-jobs.ts:83-88` is the middle of `assertValidNumbers`. The index is `models/Job.ts:82-91`; the dedupe pre-checks are `partner-jobs.ts:126-135` and `partner-school-jobs.ts:67-76`. The subject enum is `taxonomy.ts:21-29` | as cited |

---

## §2.1 — `POST /api/partner/jobs` (Contract One, platform key)

Service: `createPartnerJob()`, `lib/services/partner-jobs.ts:100-191`. **Cite CONFIRMED.**

| Claim | Verdict | Evidence |
|---|---|---|
| Required: `externalJobId`, `title`, `subject`, `description`, `institutionName`, `city` | **CONFIRMED** | `partner-jobs.ts:102-109`; `PartnerJobInput`, `:34-49` |
| Optional: `district`, `taluk`, `state` (default `"Karnataka"`), `salaryMin`, `salaryMax`, `experienceRequired` (default `0`), `facilities[]`, `sourceUrl` | **CONFIRMED** | `partner-jobs.ts:110-112`, `:153`, `:41-48` |
| Validation order: externalJobId → title → institutionName → city → description → subject → district/taluk → numbers → dedupe | **CONFIRMED**, exactly in that order | `partner-jobs.ts:102-135` |
| District/taluk validated only if sent ("accepts a city-only push") | **CONFIRMED**, and spec-pinned | `partner-jobs.ts:117-123`; `partner-jobs.spec.ts:195-209` |
| 201 body `{jobId, externalJobId, slug, status, claimStatus, publicUrl, claimUrl}` | **CONFIRMED** | `app/api/partner/jobs/route.ts:28-39` |
| `origin: "aggregated"`, `status: "active"`, `claimStatus: "unclaimed"`, claim token minted — immediately live and claimable | **CONFIRMED** | `partner-jobs.ts:140`, `:155-157` |
| `sourceAttribution.publication` stamped with the partner's own `name`, plus `sourceUrl` if sent | **CONFIRMED** | `partner-jobs.ts:158` — `sourceAttribution: { publication: partner.name, sourceUrl: input.sourceUrl?.trim() \|\| undefined }` |
| Triggers the teacher-match fan-out, failure-isolated | **CONFIRMED** | `partner-jobs.ts:184-188` — the `notifyMatchingTeachers` call is wrapped in try/catch that only `console.error`s |
| No free-plan cap; `featured` not applicable | **CONFIRMED** | `createPartnerJob` never counts active jobs and never sets `featured` (schema default `false`, `models/Job.ts:46`) |

**Additions the map does not carry.**

- **S3 (STALE).** `spendWrite(auth.partner)` runs at `app/api/partner/jobs/route.ts:21`, before `createPartnerJob` is ever called. A malformed body or a duplicate `externalJobId` therefore costs a write unit against the partner's `dailyWriteCap` (default 500, `models/Partner.ts:21`). A connector that retries a 409 in a loop will exhaust the day's budget without ever creating a job.
- `assertValidNumbers` compares but does not type-check. `salaryMin: "abc"` passes it (`"abc" < 0` is `false`) and reaches `Job.create`, where Mongoose raises a `CastError` inside a `ValidationError` that this route has no branch for — see S2 and UNVERIFIABLE-2.

## §2.2 — `PATCH /api/partner/jobs/{externalJobId}` (platform key)

Service: `updatePartnerJob()`, `lib/services/partner-jobs.ts:196-251`. **Cite CONFIRMED.**

| Claim | Verdict | Evidence |
|---|---|---|
| Looks up by `{partnerId, partnerExternalJobId, origin: "aggregated"}`; the `origin` discriminator is load-bearing | **CONFIRMED** | `partner-jobs.ts:207-211` |
| Spec-verified that a platform key cannot reach a same-partner, same-`externalJobId` Contract-Two job | **CONFIRMED** | `partner-jobs.spec.ts:256-273`, asserting `{status: 404, reason: "not_found"}` |
| Patchable: `title`, `description`, `salaryMin`, `salaryMax`, `experienceRequired`, `facilities[]`, `status` (`"active"\|"closed"` only), partial | **CONFIRMED** | `partner-jobs.ts:233-248`; `PartnerJobPatch`, `:51-59` |
| `403 claimed` when `claimStatus` is `claimed`, `claim_pending` or `withdrawn`, **or** when `hiddenPendingReview` is true | **CONFIRMED** | `partner-jobs.ts:221-232` |
| `hiddenPendingReview` fires while `claimStatus` still reads `"unclaimed"` | **CONFIRMED**, spec-pinned | `partner-jobs.spec.ts:275-284` |
| 200 body `{jobId, externalJobId, title, status, claimStatus}` | **CONFIRMED** | `app/api/partner/jobs/[externalJobId]/route.ts:29-35` |

**S4 (STALE) — the 403 is not a one-way door.** The map (and eduFleet's own catalog
text, `partner-contract.ts:87`, *"A school has claimed this listing; a platform key
can no longer edit it"*) reads as permanent. Enumerating every write to
`claimStatus` and `hiddenPendingReview` in the repo:

| Site | Transition | Reversible? |
|---|---|---|
| `partner-jobs.ts:156` | create → `unclaimed` | n/a |
| `claims.ts:185` | `unclaimed` → `claim_pending` | **yes** |
| `claim-review.ts:45` | `claim_pending` → `claimed` | no — nothing writes `claimStatus` away from `claimed` |
| `claim-review.ts:92` | `claim_pending` → `unclaimed` | this **is** the reversal — `rejectClaim`, doc comment *"free the listing to be claimed again"* |
| `takedowns.ts:23` | `hiddenPendingReview` → `true` | **yes** |
| `takedowns.ts:43-44` | → `withdrawn`, `hiddenPendingReview: false` | no |
| `takedowns.ts:46-47` | `hiddenPendingReview` → `false` (`resolveTakedown(..., "restore")`) | this **is** the reversal |

**What it should say:** a `403 claimed` means "not editable *right now*". `claimed`
and `withdrawn` are terminal; `claim_pending` and `hiddenPendingReview` are pending
admin decisions that can resolve either way. IDAP must not permanently mark a job
un-pushable on the first 403 — it should keep the row and re-attempt, because the
403 body carries no discriminator between the four cases (the route emits only
`{error, reason: "claimed"}`, `jobs/[externalJobId]/route.ts:37`).

## §2.3 — `POST /api/partner/school/jobs` (Contract Two, grant)

Service: `postSchoolJob()`, `lib/services/partner-school-jobs.ts:58-131`. **Cite CONFIRMED.**

| Claim | Verdict | Evidence |
|---|---|---|
| Scope demanded: `jobs:write` | **CONFIRMED** | `app/api/partner/school/jobs/route.ts:12` |
| Delegates to the same `createJob()` the dashboard calls, with the school's own `userId` | **CONFIRMED** | `partner-school-jobs.ts:78` — `createJob(school.userId.toString(), {...})` |
| `SchoolJobInput`: required `externalJobId`, `title`, `subject`, `description`; optional `city`, `branchId`, `salaryMin`, `salaryMax`, `experienceRequired`, `facilities[]` | **CONFIRMED as a type**, **STALE as an enforcement claim** — see S1 | `partner-school-jobs.ts:12-23` |
| No `institutionName`, no `sourceUrl` | **CONFIRMED**, with a nuance: they are **silently ignored**, not rejected. Neither field is read anywhere in `postSchoolJob` or `createJob` | `partner-school-jobs.ts:78-88`; `services/jobs.ts:12-22` |
| `partnerSchema().rules.required.schoolJob` still lists only the four fields and never mentions `city`/`branchId` | **CONFIRMED — the documented gap is still open** | `partner-contract.ts:38` — `schoolJob: ["externalJobId", "title", "subject", "description"]` |
| `createJob()` throws `ValidationError("Job needs a location or branch")` when neither `city` nor `branchId` is supplied | **CONFIRMED, verbatim** | `services/jobs.ts:59` — `if (!location.trim()) throw new ValidationError("Job needs a location or branch");` |
| `branchId` is real, accepted, and resolves against `School.branches`; undocumented in `jobShape` | **CONFIRMED** | `services/jobs.ts:42-58`; `partner-contract.ts:50-65` has no `branchId` key. An unknown id yields `ValidationError("Selected branch not found")` (`jobs.ts:53`) → a clean 400 |
| A `branchId` overrides `city`: `location` is taken from `branch.city` | **CONFIRMED**, not in the map | `services/jobs.ts:54` |
| 201 body `{jobId, externalJobId, status, featured, publicUrl}`; no `claimStatus`/`claimToken` | **CONFIRMED** | `app/api/partner/school/jobs/route.ts:29-38` |
| `featured` true automatically on Pro | **CONFIRMED** | `services/jobs.ts:87` — `featured: school.plan === "pro"` |
| Free-plan cap: `UpgradeError` → `403 upgrade_required` at 3 active jobs | **CONFIRMED**; `FREE_ACTIVE_JOB_LIMIT = 3` | `services/jobs.ts:62-69`; `services/subscriptions.ts:7`; `app/api/partner/school/jobs/route.ts:40-42` |

**S1 (STALE) — the required-field list over-promises the 400.** Tracing every one of
the four "required" fields to the refusal it actually produces:

| Field | Enforced where | Result |
|---|---|---|
| `externalJobId` | `partner-school-jobs.ts:64` — `if (!externalJobId) throw new ValidationError("externalJobId is required")` | clean `400 validation_failed` |
| `subject` | `services/jobs.ts:33-35` — `isValidJobSubject` | clean `400 validation_failed` |
| `title` | nothing in the service layer; `models/Job.ts:31` `required: true` | Mongoose `ValidationError` → **unhandled** |
| `description` | nothing in the service layer; `models/Job.ts:35` `required: true` | Mongoose `ValidationError` → **unhandled** |

The route's catch chain (`app/api/partner/school/jobs/route.ts:39-52`) branches on
`UpgradeError`, `PartnerJobError` and `@/lib/authz`'s `ValidationError`, then
`throw e`. A `mongoose.Error.ValidationError` matches none of them. The helper that
would fix this exists — `mongooseValidationError()`, `partner-auth.ts:46-51`, added
by commit `6645363` whose own message names this exact bug class ("*a non-numeric
price*... *escaped the POST handler's catch as an unhandled 500 with no reason code
— after spendWrite had already consumed part of the daily budget*") — but it is
wired into **only** the two listings routes:

```
app/api/partner/school/listings/route.ts:42:    const invalid = mongooseValidationError(e);
app/api/partner/school/listings/[id]/route.ts:37:    const invalid = mongooseValidationError(e);
```

**What it should say:** on Contract Two, only `externalJobId` and `subject` are
validated into the documented 400. Omit `title` or `description` and eduFleet
answers 500 with no `reason`, having already spent a write unit. IDAP must validate
`title` and `description` non-empty connector-side before pushing, and must treat a
500 from this route as a permanent (non-retryable) request defect, not a transient
server fault.

**Validation order, not in the map.** Contract Two runs `externalJobId` →
`assertValidNumbers` → **dedupe** → `createJob` (subject → salary range → branch →
location → free-plan cap). The dedupe check therefore comes **before** subject and
location validation, the mirror image of Contract One where dedupe is last
(`partner-jobs.ts:126`). A body that is both a duplicate and invalid returns 409
from Contract Two and 400 from Contract One.

## §2.4 — `PATCH /api/partner/school/jobs/{id}` (grant)

Service: `updateSchoolJob()`, `lib/services/partner-school-jobs.ts:133-168`. **Cite CONFIRMED.**

| Claim | Verdict | Evidence |
|---|---|---|
| Scope demanded: `jobs:write` | **CONFIRMED** | `app/api/partner/school/jobs/[id]/route.ts:9` |
| `{id}` is the Mongo `_id`, not `externalJobId` — asymmetric with Contract One | **CONFIRMED** | `partner-school-jobs.ts:139` |
| Scoped to `{_id, schoolId, partnerId}` | **CONFIRMED**, verbatim: `Job.findOne({ _id: jobId, schoolId: school._id, partnerId: partner._id }).catch(() => null)` — the `.catch` turns a malformed id into a clean 404 | `partner-school-jobs.ts:139-140` |
| `status` accepts only `"closed"`; no reopen; `"active"` is a `ValidationError` | **CONFIRMED**, spec-pinned | `partner-school-jobs.ts:147-152`; `partner-school-jobs.spec.ts:193` |
| 200 body `{jobId, title, status}` — no `externalJobId` | **CONFIRMED** | `app/api/partner/school/jobs/[id]/route.ts:27` |
| Patchable: `title`, `description`, `salaryMin`, `salaryMax`, `experienceRequired`, `facilities[]`, `status` | **STALE — see S8** | `partner-school-jobs.ts:147-165` |

**S8 (STALE) — `status` is not co-patchable.** `partner-school-jobs.ts:147-152`:

```ts
if (patch.status !== undefined) {
  if (patch.status !== "closed") {
    throw new ValidationError('status may only be set to "closed"');
  }
  return closeJob(school.userId.toString(), job.id);
}
```

The `return` precedes every other field assignment. `PATCH {status: "closed",
title: "New title"}` closes the job and **silently discards the title**, and the
200 body reports the old title as though it had been accepted.

**What it should say:** `status` is mutually exclusive with the other patchable
fields. To close a job and change a field, send two PATCHes, field-change first.

Also note `assertValidNumbers` is called at `:163` against `patch.experienceRequired`
before `:164` assigns it, and against the already-merged `job.salaryMin`/`salaryMax`
— so a negative or inverted value is rejected on the merged document, which is the
correct behaviour and matches the map's §6.4.

## §3 — the Contract One vs Contract Two field split

Every row of the map's table was checked against source. **All CONFIRMED**, with
one correction folded in from S6.

| Field | Map's claim | Verdict |
|---|---|---|
| `externalJobId`, `title`, `subject`, `description` | required both sides | **CONFIRMED as intent**; see S1 for how Contract Two actually refuses `title`/`description` |
| `institutionName` | required C1 / not accepted C2 | **CONFIRMED** — `partner-jobs.ts:104`; absent from `SchoolJobInput`, silently ignored |
| `city` | required C1 / optional C2 but `city`-or-`branchId` or the write 400s | **CONFIRMED** — `partner-jobs.ts:105`; `services/jobs.ts:59` |
| `district`/`taluk`/`state` | optional + Karnataka-validated C1 / not in `SchoolJobInput` C2 | **CONFIRMED** — `PartnerJobInput` `partner-jobs.ts:41-43`; `SchoolJobInput` `partner-school-jobs.ts:12-23` has none. Karnataka reference data is therefore entirely irrelevant to Contract Two |
| salary / experience | optional both | **CONFIRMED** |
| `facilities[]` | optional both | **CONFIRMED**, both sanitized by the same function |
| `sourceUrl` | platform-key only | **CONFIRMED** — `partner-jobs.ts:158`; ignored by C2 |
| `branchId` | not in `PartnerJobInput` / optional + undocumented C2 | **CONFIRMED** |
| resulting `origin` | `aggregated` / `school_posted` | **CONFIRMED** — `partner-jobs.ts:140`; `models/Job.ts:49` default |
| claimable | yes C1 / no C2 | **CONFIRMED** — `partner-jobs.ts:157`; `createJob` mints no claim token |
| free-plan cap | no C1 / yes C2 | **CONFIRMED** |
| `featured` on Pro | n/a C1 / automatic C2 | **CONFIRMED** |

**S6 (STALE) — one row to add.** `state` should be a row of its own with an
asymmetry the map's §6.5 gets wrong: Contract One defaults it to `"Karnataka"`
(`partner-jobs.ts:110`); Contract Two never writes it at all, so a Contract-Two job
carries `state: undefined`. `models/Job.ts:57` is `{ type: String, trim: true }` —
no default. If IDAP round-trips a job's `state` it will read back empty for every
Contract-Two push.

## §4 — dedupe, the shared id-space, and ownership

**All CONFIRMED.** This is the best-verified section of the map.

| Claim | Verdict | Evidence |
|---|---|---|
| `externalJobId` unique per partner, id-space **shared across both contracts** | **CONFIRMED** | `models/Job.ts:82-91` — a single partial unique index on `{partnerId: 1, partnerExternalJobId: 1}`, `partialFilterExpression` on both fields being present. There is no `origin` in the index, so the two contracts genuinely share one id-space |
| Both create paths pre-check the same key | **CONFIRMED** | `partner-jobs.ts:126`; `partner-school-jobs.ts:67` — identical `Job.findOne({ partnerId: partner._id, partnerExternalJobId: externalJobId })` |
| 409 body `{error, reason: "duplicate_external_job", jobId, contract}` | **CONFIRMED** | routes spread `jobId` and `contract` through: `app/api/partner/jobs/route.ts:41-46`, `app/api/partner/school/jobs/route.ts:43-48` |
| `contract` reports the **owning** row, not the caller | **CONFIRMED**, at all four throw sites, derived identically: `existing.origin === "aggregated" ? "platform" : "school"` | `partner-jobs.ts:133`, `:175`; `partner-school-jobs.ts:74`, `:124` |
| Tested in both directions by specs of that exact title | **CONFIRMED** | `partner-jobs.spec.ts:97` (C1 hits a C2 job → `contract: "school"`, `jobId: schoolJob.id`); `partner-school-jobs.spec.ts:82` (C2 hits a C1 job → `contract: "platform"`) |
| A cross-contract collision 404s on the caller's own PATCH endpoint | **CONFIRMED** | `partner-jobs.ts:207-211` (`origin: "aggregated"` filter) and `partner-school-jobs.ts:139` (`schoolId` filter) — neither can see the other's row |
| E11000 race → the same 409, never a bare 500 | **CONFIRMED** both sides | `partner-jobs.ts:162-180`; `partner-school-jobs.ts:96-129` |
| `postSchoolJob` closes the orphaned losing-racer job before returning the 409 | **CONFIRMED**, and the compensation failure is itself isolated | `partner-school-jobs.ts:105-118` |

**One addition.** The PATCH routes do **not** pass `jobId`/`contract` through —
`jobs/[externalJobId]/route.ts:37` and `school/jobs/[id]/route.ts:29` both call
`jsonError(e.status, e.message, { reason: e.reason })` only. Harmless today, since
no PATCH path can raise `duplicate_external_job`, but a connector must not expect
those keys on a PATCH error.

## §5 — the error catalog, as it applies to the job routes

Source: `errorCatalog()`, `partner-contract.ts:80-103`. **Cite CONFIRMED.** All 20
reasons and their statuses are present exactly as the map lists them.

| Claim | Verdict | Evidence |
|---|---|---|
| 20 reasons, at the statuses listed | **CONFIRMED** | `partner-contract.ts:82-101`, 20 entries |
| `grant_race` is cataloged but never emitted | **CONFIRMED** — exhaustive grep of `reason: "..."` across `partner-auth.ts`, `services/partner-*.ts` and `app/api/partner/**` returns 18 distinct literals; `grant_race` is not among them | `partner-contract.ts:98` is its only occurrence |
| `403 forbidden` exists in code, is not cataloged, and is not partner-reachable | **CONFIRMED** — both sites are school-session actions | `partner-connections.ts:385` (`schoolRespondToRequest`), `:524` (`revokeSchoolGrant`) |
| Every reason the four job routes can emit is cataloged | **CONFIRMED** for the emitted set: `validation_failed`, `revoked`, `partner_revoked`, `partner_inactive`, `insufficient_scope`, `claimed`, `school_unavailable`, `upgrade_required`, `not_found`, `duplicate_external_job`, `rate_limited`, `write_cap_exceeded` | as cited throughout |

**S2 (STALE) — two uncataloged failure modes reachable from the job routes.**

(a) **Mongoose validation escapes as a 500 with no `reason`.** Detailed under S1.
Reachable on `POST /api/partner/school/jobs` by omitting `title` or `description`,
and on either POST by sending a non-numeric `salaryMin`/`salaryMax`/
`experienceRequired` (`assertValidNumbers`, `partner-jobs.ts:81-90`, only compares —
`"abc" < 0` is `false`, so the string reaches the schema and casts). The listings
routes were fixed for exactly this; the job routes were not.

(b) **A 401 for a missing, malformed or unknown credential carries no `reason`
field.** Enumerated from `partner-auth.ts`:

| Line | Response | Has `reason`? |
|---|---|---|
| `:95` | `jsonError(401, "Missing partner key", { hint: MISSING_HINT })` | no |
| `:96` | `jsonError(401, "Invalid partner key")` (wrong prefix) | no |
| `:99` | `jsonError(401, "Invalid partner key")` (hash not found) | no |
| `:102` | `jsonError(401, "Invalid partner key")` (orphaned key) | no |
| `:116` | `jsonError(401, "Missing grant token", { hint: MISSING_HINT })` | no |
| `:117` | `jsonError(401, "Invalid grant token")` (wrong prefix) | no |
| `:120` | `jsonError(401, "Invalid grant token")` (hash not found) | no |
| `:123` | `jsonError(401, "Invalid grant token")` (orphaned grant) | no |
| `:100` / `:121` | `{ reason: "revoked" }` | yes |
| `:88` / `:89` | `{ reason: "partner_revoked" }` / `{ reason: "partner_inactive" }` | yes |

**What it should say:** the catalog's three 401 rows cover only revocation and
pause. The far more common 401 — a bad or absent token — returns `{error}` (plus
`hint` in the missing case) and **no `reason` at all**. A connector that switches on
`reason` must handle `undefined` as "credential rejected, do not retry".

**S9 (STALE, presentational).** The map calls its table verbatim, but the live order
differs: `duplicate_external_listing` is the 11th entry (`partner-contract.ts:92`),
not the last but one, and `listing_not_approved` is the 15th (`:96`). The map's
`duplicate_external_job` meaning appends "(and `contract` — see §4)" and its
`rate_limited` meaning appends "(also used for a lost write-budget race — see §1.4)";
neither parenthetical is in the code (`:91`, `:100`). Both additions are factually
correct — `spendWrite` does return `reason: "rate_limited"` on a lost CAS race
(`partner-auth.ts:182`) — but they will not match a live diff against
`GET /api/partner/contract`.

## §6 — reference data

### §6.1 Subject enum — CONFIRMED

`taxonomy.ts:21-29` (map cites `:20-28`, off by one — S11). 16 values, verbatim:

- **academic (8):** `Mathematics`, `Physics`, `Chemistry`, `Biology`, `English`, `Kannada`, `Hindi`, `Social Science`
- **administration (4):** `Principal`, `Vice Principal`, `Coordinator`, `Administrator`
- **support (4):** `Accountant`, `Clerk`, `Driver`, `Librarian`

`isValidJobSubject` is `JOB_CATEGORIES.some((c) => c.name === name)` (`taxonomy.ts:91-93`)
— exact, case-sensitive, **and it does not trim**, so `"Physics "` fails.
`categoryGroup` is derived by `jobGroupOf` at create time on both contracts
(`partner-jobs.ts:142`; `services/jobs.ts:74`) and is never accepted from a caller.
**CONFIRMED.**

### §6.2 Facilities enum and `sanitizeFacilities()` — CONFIRMED

`job-facilities.ts:6-18` (map's cite is exact). 11 values, verbatim and in canonical
order:

`Provident Fund (PF)`, `ESI (medical insurance)`, `Gratuity`, `Health insurance`,
`Staff accommodation`, `Transport / bus facility`, `Free / subsidised meals`,
`Paid leave`, `Annual / festival bonus`, `Training & development`,
`Maternity benefits`

The map's claim that unrecognised labels are **silently discarded with no error** is
**CONFIRMED**, `job-facilities.ts:25-31`:

```ts
export function sanitizeFacilities(input: unknown[]): string[] {
  const chosen = new Set<string>();
  for (const v of input) {
    const s = typeof v === "string" ? v.trim() : "";
    if (KNOWN.has(s)) chosen.add(s);
  }
  return JOB_FACILITIES.filter((f) => chosen.has(f));
}
```

No throw on any path. Values are trimmed before matching, de-duplicated, and
re-emitted in `JOB_FACILITIES` order — so **input order is not preserved**.
Spec-pinned at `job-facilities.spec.ts:13-22` ("drops unknown, empty and non-string
values"). Applied at all four job write sites: `partner-jobs.ts:154` (C1 create),
`partner-jobs.ts:242` (C1 patch), `services/jobs.ts:85` (C2 create),
`partner-school-jobs.ts:165` (C2 patch).

**One sharper consequence than the map states.** Because a PATCH replaces rather
than merges, `PATCH {facilities: ["Astrology room"]}` sanitizes to `[]` and
**silently clears** every facility already on the job. The connector-side warning
the map recommends should therefore fire on any patch whose sanitized result is
shorter than its input, not only on creates.

### §6.3 Karnataka district/taluk — mostly CONFIRMED, one STALE

| Claim | Verdict | Evidence |
|---|---|---|
| `isValidKarnatakaDistrict` uses `Object.hasOwn`, not `in`, deliberately | **CONFIRMED**, with the comment intact | `karnataka-taxonomy.ts:52-55` |
| `district` validated only if sent | **CONFIRMED** | `partner-jobs.ts:118` |
| `taluk` validated only if sent, and only against the district sent alongside | **CONFIRMED** | `partner-jobs.ts:121` — `if (isKarnataka && taluk && (!district || !isValidKarnatakaTaluk(district, taluk)))`. Note the `!district`: sending a taluk **without** a district is itself a 400, which the map does not say |
| Both checks skipped entirely when `state` is not Karnataka | **CONFIRMED** | `partner-jobs.ts:117` — `const isKarnataka = state.toLowerCase() === "karnataka";` gates both |
| "The full **29-district** → taluk table" | **STALE — there are 31** (S5) | `karnataka-taxonomy.ts:7-39` |

The 31 district keys, verbatim (`districtsForState("Karnataka")` returns them
sorted, `karnataka-taxonomy.ts:42-45`):

`Bagalkot`, `Ballari`, `Belagavi`, `Bengaluru Rural`, `Bengaluru Urban`, `Bidar`,
`Chamarajanagar`, `Chikkaballapur`, `Chikkamagaluru`, `Chitradurga`,
`Dakshina Kannada`, `Davanagere`, `Dharwad`, `Gadag`, `Hassan`, `Haveri`,
`Kalaburagi`, `Kodagu`, `Kolar`, `Koppal`, `Mandya`, `Mysuru`, `Raichur`,
`Ramanagara`, `Shivamogga`, `Tumakuru`, `Udupi`, `Uttara Kannada`, `Vijayapura`,
`Vijayanagara`, `Yadgir`

Two traps for a mapping layer, neither in the map: there is no district named
`"Bengaluru"` (only `Bengaluru Urban` / `Bengaluru Rural`), and `Mangaluru` is a
*taluk* of `Dakshina Kannada`, not a district. Matching is exact and
case-sensitive — `KARNATAKA_DISTRICTS` is keyed by the display string.

### §6.4 Salary and experience — CONFIRMED

`assertValidNumbers()`, `partner-jobs.ts:81-90` (map's cite is exact), imported and
shared by both contracts (`partner-school-jobs.ts:8`). Rules exactly as the map
states: `salaryMin >= 0`, `salaryMax >= 0`, `experienceRequired >= 0`,
`salaryMin <= salaryMax` when both present; all four raise `@/lib/authz`'s
`ValidationError` → `400 validation_failed`. Spec-pinned at
`partner-jobs.spec.ts:183-193` and `partner-school-jobs.spec.ts:102-115`. "Monthly
rupee amounts" is published in the contract (`partner-contract.ts:46`, `:60-61`).
`experienceRequired` defaults to `0` on both contracts (`partner-jobs.ts:153`;
`services/jobs.ts:84`, both `?? 0`) with a schema default to match
(`models/Job.ts:42`).

Caveat repeated from S2(a): these are numeric comparisons only, not type guards.

### §6.5 Defaults — one CONFIRMED, one STALE

| Claim | Verdict | Evidence |
|---|---|---|
| `state` defaults to `"Karnataka"` when omitted, **both contracts** | **STALE (S6)** — Contract One only | `partner-jobs.ts:110` vs `services/jobs.ts:71-88` |
| `status` defaults to `"active"` on create | **CONFIRMED** — set explicitly on both paths, plus a schema default | `partner-jobs.ts:155`; `services/jobs.ts:86`; `models/Job.ts:45` |
| Only `"active"`/`"closed"` are ever legal | **CONFIRMED** | `models/Job.ts:45` enum; `partner-contract.ts:29` publishes `jobStatus: ["active", "closed"]` |
| Contract Two's PATCH accepts only `"closed"` | **CONFIRMED** | `partner-school-jobs.ts:148` |

---

## The other flagged questions

**Q2 — `spendWrite` / write caps on the job routes.** Applies to all four, and only
to writes. Grep of every call site (7 total, all POST/PATCH; no GET handler calls
it) confirms the map's §1.4. Contract One spends against `Partner`
(`dailyWriteCap` default 500, range 1–20000, `models/Partner.ts:21`); Contract Two
spends against `PartnerGrant` (default 100, range 1–5000, `models/PartnerGrant.ts:19`).
The CAS filter still requires the credential to be live —
`liveFilter = Model === Partner ? { revokedAt: null, active: true } : { revokedAt: null }`,
`partner-auth.ts:169` — as the map says. A lost CAS race returns
`429 { reason: "rate_limited" }` (`:182`), a spent cap returns
`429 { reason: "write_cap_exceeded", dailyWriteCap }` (`:162`) — note the cap value
is echoed in the body, which the map does not mention. Neither response sets
`Retry-After`; `jsonError` (`:26-28`) is a bare `Response.json` with no headers —
**CONFIRMED**. The one stale piece is ordering, S3.

**Q3 — `sanitizeFacilities()`.** Confirmed and refuted nothing; see §6.2 for the
verbatim 11-value list and the PATCH-clears-silently consequence.

**Q5 — the shared `externalJobId` id-space and the 409's `contract` field.**
Fully CONFIRMED; see §4. Worth adding: the id-space is shared between the two *job*
contracts only. `MarketplaceListing` keys its own partial unique index on
`partnerExternalListingId` (`models/MarketplaceListing.ts:55`), a different field
name, so a job id and a listing id can never collide with each other.

**Q6 — the claim transition.** STALE, S4. `claimed` and `withdrawn` are terminal;
`claim_pending` and `hiddenPendingReview` are not.

**Q7 — `MarketplaceListing`'s partner attribution fields vs the job model.**
**CONFIRMED: a direct analogue already exists on `Job`, and it predates the listing
fields.** Commit `4887262` added to `MarketplaceListing`:

```
models/MarketplaceListing.ts:44:    partnerId: { type: Schema.Types.ObjectId, ref: "Partner", index: true },
models/MarketplaceListing.ts:45:    partnerExternalListingId: { type: String, trim: true },
```

plus a partial unique index on `{partnerId, partnerExternalListingId}` (`:55-62`).
That is a field-for-field copy of `Job`'s `partnerId` + `partnerExternalJobId`
(`models/Job.ts:72-73`) and its partial unique index (`:82-91`), which shipped with
the original 2026-08-27 partner spec — the Job comment even carries that date. **No
new field was added to `Job` by any of the 12 post-map commits; `models/Job.ts` was
not touched at all.** So there is nothing for IDAP's job payloads to start sending,
and no new attribution surface to read back.

---

## UNVERIFIABLE

1. **The exact HTTP status of the unhandled Mongoose `ValidationError` (S1/S2a).**
   The catch chain provably has no branch for `mongoose.Error.ValidationError`
   (`app/api/partner/school/jobs/route.ts:39-52`) and therefore re-throws, but the
   status Next.js emits for an unhandled throw in a route handler was not observed:
   the eduFleet repo is read-only for this task, so no dev server was started and no
   request was issued. 500 is the expected and documented Next.js behaviour, and
   commit `6645363`'s own message describes the identical path on the listings route
   as "*an unhandled 500 with no reason code*" — treat the 500 as near-certain but
   not executed here.

2. **The non-numeric-salary cast path (S2a, second half).** `assertValidNumbers`
   demonstrably lets a non-numeric string through (`"abc" < 0 === false`), and
   `models/Job.ts:40-41` types `salaryMin`/`salaryMax` as `Number`, so Mongoose must
   cast. Whether the resulting error surfaces as a `CastError` wrapped in a
   `ValidationError` (mapped by `mongooseValidationError` on the listings routes) or
   as a bare `CastError` (which that helper's `instanceof` check would **not** catch,
   `partner-auth.ts:47`) depends on Mongoose's document-validation internals and was
   not exercised. Either way the job routes handle neither.

3. **IDAP's live `allowedScopes` on the eduFleet deployment.** `openConnectionRequest`
   rejects any requested scope not in `partner.allowedScopes`
   (`partner-connections.ts:111-116`), and `redeemConnectionRequest` re-applies that
   ceiling at mint time (`:462-468`, refusing with a `ValidationError` if the partner
   is "*no longer registered for any of the scopes this request would grant*"). The
   schema default is `["jobs:write"]` (`models/Partner.ts:20`) and an admin can
   change it (`services/partner-registry.ts`, commit `906e942`). Whether IDAP's
   actual row still carries `jobs:write` is database state, not source, and the task
   forbids reading any database. If a connection request starts failing with
   `400 "This partner is not registered for: jobs:write"`, this is why — ask an
   eduFleet admin, not the code.

---

## Scope-resolution reference (for the connector)

Every partner route, and what a `jobs:write`-only grant gets:

| Route | Credential | Scope demanded | `jobs:write`-only grant |
|---|---|---|---|
| `POST`/`GET /api/partner/jobs` | platform key | **none** — `requirePlatformKey` takes no scope argument and never reads `allowedScopes` (`partner-auth.ts:93-112`) | n/a |
| `PATCH /api/partner/jobs/{externalJobId}` | platform key | **none**, same | n/a |
| `POST /api/partner/school/jobs` | grant | `"jobs:write"` | **works** |
| `PATCH /api/partner/school/jobs/{id}` | grant | `"jobs:write"` | **works** |
| `GET /api/partner/school` | grant | `["jobs:write", "listings:write"]` (OR) | **works**, returns the job snapshot and no `listings` key |
| `GET /api/partner/whoami` | either | `[...PARTNER_SCOPES]` (OR) for a grant | **works** |
| `GET /api/partner/schema` | either | `[...PARTNER_SCOPES]` (OR) for a grant | **works** |
| `GET /api/partner/contract` | platform key | none | n/a |
| `POST`/`GET /api/partner/school/listings`, `PATCH .../{id}` | grant | `"listings:write"` | **403 `insufficient_scope`** |

Note that `allowedScopes` gates only what a **connection request** may ask for and
what a **redeem** may mint. It does not gate the platform key: a partner whose
`allowedScopes` were narrowed to `["listings:write"]` could still POST Contract-One
jobs with its platform key.

The `insufficient_scope` message string changed with the OR-scopes work and is now
`This grant does not hold any of: <comma-joined list>` (`partner-auth.ts:136`),
previously `This grant does not hold the "<scope>" scope`. The `reason` code is
unchanged. Do not string-match on it.
