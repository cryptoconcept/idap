# eduFleet Exchange — Partner API Map

**Date: 2026-08-28.** This document supersedes the 27 Aug 2026 version of
`docs/integrations/edufleet-api-map.md` in full. That version's conclusion —
*"No. In neither repo does anything resembling a two-layer partner API...
exist. There is no inbound integration surface at all in either codebase."*
(its §4) — was correct when written and is **now false**. The API has since
been built out completely: 12 route files, a self-describing contract module,
a full two-layer credential lifecycle, and a matching spec suite. This
document replaces the old recon wholesale; nothing in the 27 Aug version
should be relied on going forward.

Source of truth for everything below: `/Users/automicai/edufleet-exchange`
(read-only for this recon — nothing in that repo was modified). All paths are
relative to that repo's `web/src/` unless stated otherwise.

**Confirmed intent, not inferred:** every test fixture across
`partner-auth.spec.ts`, `partner-jobs.spec.ts`, `partner-school-jobs.spec.ts`,
`partner-connections.spec.ts`, and `partner-registry.spec.ts` registers the
test partner as `{ name: "IDAP", slug: "idap" }`. `Partner.ts`'s own doc
comment reads *"A registered external platform (IDAP is the first)."* eduFleet
built this API with IDAP as the intended (and only named) caller.

---

## 0. Answer to the operative question: what can a connector push today?

The user has confirmed the direction: **schools post teacher openings in
IDAP, and a connector pushes them out to eduFleet.** eduFleet's PRD also
describes schools selling vehicles and used assets on a marketplace, with a
strict "schools only, never dealers" rule. All three are IDAP-relevant
sellable/postable entities. Only one of them has a partner surface:

| Entity | Partner API? | Where it lives instead |
|---|---|---|
| **Teacher jobs (vacancies)** | **Yes** — 5 of the 12 route files, both credential tiers | — |
| **Vehicles (bus/van/minibus)** | **No — zero API routes of any kind** | `web/src/lib/services/listings.ts`, called only from session-authenticated Server Actions off the school's own dashboard |
| **Used assets/items (furniture, lab, computers, sports, other)** | **No — zero API routes**, and the feature itself is off | Same service, same Server Actions, gated behind `process.env.PHASE2_ASSETS === "true"` — currently unset, so asset listings 400 with *"Used-asset listings arrive in Phase 2 — vehicles only for now"* |

This is not a "session-cookie only" situation the way FeesBasket's offers
were — it is stronger than that. There is no REST endpoint for
`MarketplaceListing` at all: `grep -rn "MarketplaceListing" web/src/app/api`
returns nothing. The only way any code creates, approves, or reads a
marketplace listing is through `web/src/lib/services/listings.ts`, invoked
from Next.js Server Actions (`web/src/lib/actions.ts`) bound to the logged-in
school session. There is no `POST /api/partner/...` surface an admin could
even retrofit an API key onto without eduFleet shipping new routes.
**Vehicles and used items are not connector-reachable today, full stop.**
Section 8 below has the full model/rules detail in case eduFleet ships a
partner surface for them later.

Everything from here on, up through Section 7, is about the one entity that
**is** reachable: teacher jobs.

---

## 1. The credential model, end to end

Two independent credential tiers, both bearer tokens sent as either
`Authorization: Bearer <token>` or `x-api-key: <token>` (`readBearer()`,
`partner-auth.ts:36-44`):

| | Platform key ("Contract One") | School grant ("Contract Two") |
|---|---|---|
| Prefix | `ef_pkey_` (`PLATFORM_KEY_PREFIX`) | `ef_pgrant_` (`GRANT_TOKEN_PREFIX`) |
| Model | `Partner` + `PartnerKey` | `PartnerGrant` |
| Scope | The partner's own authority — publish sourced/claimable listings, open connection requests | One specific school, within that school's own rights |
| Issued by | An eduFleet admin (`issuePartnerKey`) | Minted only by redeeming an **approved** connection request |
| Live-credential invariant | One live `PartnerKey` per partner (partial unique index on `{partnerId}` where `revokedAt: null`) — rotation is revoke-then-create in a transaction, so the old key stays live if the new create fails | One live `PartnerGrant` per `(partnerId, schoolId)` pair (partial unique index) |
| Daily write cap | `dailyWriteCap` on `Partner`, default 500, range 1–20000 | `dailyWriteCap` on `PartnerGrant`, default 100, range 1–5000 |
| Token storage | SHA-256 hash only (`hashToken`); plaintext returned exactly once at mint time; no salt — 192 bits of entropy makes an unsalted digest a deliberate choice, not an oversight (`partner-token-logic.ts:12-16`) |

### 1.1 Token minting

`generateToken(prefix)` (`partner-token-logic.ts:18-21`): `prefix + 24 random
bytes as hex` (48 hex chars after the prefix). Verified never to repeat across
50 draws in the spec. `hasPrefix()` is a cheap shape check run before any DB
lookup, so a grant token physically cannot be accepted on a platform-key route
or vice versa — the wrong-prefix check happens before the hash lookup even
runs.

### 1.2 The grant lifecycle — four steps, one state machine

State field: `PartnerConnectionRequest.status`, enum `["pending",
"awaiting_school", "approved", "rejected", "completed"]`
(`PartnerConnectionRequest.ts:7-13`). Model comment: *"the partner initiates
with its own institution reference, an admin matches it to a real School, the
school itself consents, and only then can the partner redeem a grant — so a
credential is never issued for a school that did not agree to it."*

**Step 1 — Partner opens a request.** `POST /api/partner/connection-requests`
(platform key). `openConnectionRequest()` (`partner-connections.ts:77-118`).
Required: `externalRef` (the partner's own institution id) and
`payload.institutionName`. At most one **open** request per
`(partnerId, externalRef)` — enforced first by a pre-check, then for real by a
partial unique index `{partnerId, externalRef}` where `open: true`; a raced
duplicate insert is caught (Mongo error code 11000) and turned into the same
409 the sequential check would give, never a bare 500. Response: `{
requestId, status }` at 201; on collision, 409 `duplicate_open_request` with
the existing `requestId` in the body.

**Step 2 — An eduFleet admin matches it to a real school.**
`adminMatchRequest()` (`partner-connections.ts:154-195`) — **not** exposed on
any partner route; this is an eduFleet-internal admin action. Requires
`status === "pending"`; the target school must be `verificationStatus ===
"approved"` and not `suspended`. At most one open request per
`(partnerId, schoolId)` pair too (same partial-unique-index + race-safe
pattern as Step 1). On success: `schoolId` set, `status → "awaiting_school"`.

**Step 3 — The school itself confirms or declines.**
`schoolRespondToRequest()` (`partner-connections.ts:273-296`) — again not a
partner-API route; this runs off the school's own logged-in session. Accept →
`status → "approved"`, `schoolConfirmedAt` stamped. Decline → `status →
"rejected"`, `open: false`, `rejectReason: "Declined by the school"`. **No
grant exists yet at this point** — approval alone does not create a
credential.

**Step 4 — Partner redeems.** `POST
/api/partner/connection-requests/{id}/redeem` (platform key).
`redeemConnectionRequest()` (`partner-connections.ts:303-350`). Requires
`status === "approved"` and `redeemedAt` unset; the transition
`approved → completed` is an atomic conditional `findOneAndUpdate` (`status:
"approved", redeemedAt: null` in the filter), so a replayed or concurrently
racing redeem finds nothing to match and gets 409 `already_redeemed` rather
than minting a second credential. If a prior live grant exists for this
`(partner, school)` pair (e.g. the school previously disconnected and
re-authorised), it is revoked first (`revokedBy: "system:partner-redeem"`) so
exactly one grant is ever live. **Response — returned once, never again:**
```json
{ "token": "ef_pgrant_...", "schoolId": "...", "externalRef": "...", "scopes": ["jobs:write"], "prefix": "ef_pgrant_xxxx" }
```
Note what this response does **not** contain: no school name, no city, no
slug — just the id. See §9 for why that matters to a connector.

**A defensive fifth state:** if the invariant "approved implies schoolId is
set" is ever violated (verified by a dedicated spec test that force-unsets
`schoolId` on an approved doc), `redeemConnectionRequest` throws 500
`corrupt_state` **before** the atomic transition runs — the request is left
exactly as it was (still `"approved"`, still redeemable once the data is
fixed), never stranded mid-flight.

### 1.3 Disconnect / revocation

- **School-initiated ("disconnect"):** `revokeSchoolGrant()`
  (`partner-connections.ts:374-385`) — a school-session action, not a partner
  route. Sets `revokedAt`/`revokedBy: "school:<id>"`. The next partner-API call
  using that grant then gets `401 { reason: "revoked" }` from `requireGrant`.
- **Partner-key revocation/rotation:** admin-only (`revokePartnerKey`,
  `issuePartnerKey`) — revokes every live `PartnerKey` row; a revoked key
  fails with `401 { reason: "revoked" }`.
- **Partner-wide pause:** `setPartnerActive(false)` stamps `Partner.revokedAt`
  and flips `active: false`; every route under both credential tiers then
  fails with `401 { reason: "partner_inactive" }` (checked inside
  `partnerState()`, shared by both `requirePlatformKey` and `requireGrant`
  since a grant's parent `Partner` is checked too).
- **School unavailable (not a revoke, but blocks writes identically):** if the
  linked school becomes `suspended` or its `verificationStatus` stops being
  `"approved"`, `requireGrant` returns `403 { reason: "school_unavailable" }`
  — the grant row itself is untouched, so it resumes working automatically if
  the school's status recovers.

### 1.4 Rate limiting — two independent layers

1. **Per-minute burst guard** — in-memory, per-serverless-instance sliding
   window, 60 req/min per credential id (`RATE_LIMIT_PER_MIN`,
   `partner-auth.ts:55-67`). Explicitly documented as best-effort only
   ("serverless means this is best-effort burst protection only").
2. **Daily write budget** — the enforced one, shared across all instances via
   Mongo. `nextWriteBudget()` (`partner-token-logic.ts:38-47`) computes
   against the **India-calendar day** (`dayKeyIST`), the same bucket job views
   use. `spendWrite()` (`partner-auth.ts:131-160`) applies it via a
   conditional `updateOne` keyed on the in-memory doc's own
   `{writesDay, writesToday}` values, so two racing writes can't both claim
   the last unit. **Load-bearing detail:** the CAS filter also requires the
   credential to *still be live* (`revokedAt: null` [+ `active: true` for a
   Partner]) — a revoke landing in the narrow window between
   `requireGrant`/`requirePlatformKey` resolving and `spendWrite` running
   still blocks the write, even though the in-memory doc predates the revoke.
   Verified by two dedicated spec tests that revoke out from under a
   stale in-memory doc.
   Only **write** routes call `spendWrite` (POST/PATCH); reads (GET) never
   touch the daily cap.

**429 responses never set a `Retry-After` header** — `jsonError()` is a bare
`Response.json(status)` call with no headers anywhere in the partner-auth
code. Worth knowing for the fit discussion in §10: IDAP's shared
`createConnectorHttp` retries once on 429 honoring `Retry-After` when
present, else a flat 2s — against eduFleet it will always take the flat-2s
branch.

---

## 2. Every endpoint

12 route files, 14 exported handlers, 11 distinct resource paths (the 12th
file, `openapi.json`, is the self-describing document generator, not a
resource of its own).

| Path | Verb | Credential | Notes |
|---|---|---|---|
| `/api/partner/openapi.json` | GET | **none** | Unauthenticated by design — *"an integrator must be able to read the contract before they hold a credential"* |
| `/api/partner/schema` | GET | **either** (platform key or grant) | Returns `partnerSchema()` — enums, rules, jobShape |
| `/api/partner/contract` | GET | platform key | Returns `{ version, errors: errorCatalog() }` |
| `/api/partner/whoami` | GET | **either** | Identity + live usage counters for whichever credential called |
| `/api/partner/jobs` | POST | platform key | Contract One: publish a sourced/claimable vacancy |
| `/api/partner/jobs` | GET | platform key | List this partner's own pushed vacancies (with view/held-application counts) |
| `/api/partner/jobs/{externalJobId}` | PATCH | platform key | Update/close a Contract-One vacancy |
| `/api/partner/connection-requests` | POST | platform key | Step 1 of the grant lifecycle |
| `/api/partner/connection-requests` | GET | platform key | List this partner's requests (most-recent 200) |
| `/api/partner/connection-requests/{id}` | GET | platform key | Direct `_id` lookup — reachable regardless of the 200-row cap on the list endpoint |
| `/api/partner/connection-requests/{id}/redeem` | POST | platform key | Step 4 — exchange an approved request for a grant, once |
| `/api/partner/school` | GET | grant | The linked school's snapshot + quota headroom |
| `/api/partner/school/jobs` | POST | grant | Contract Two: post a vacancy as the linked school |
| `/api/partner/school/jobs/{id}` | PATCH | grant | Update/close a Contract-Two vacancy (id is the Mongo `_id`, not `externalJobId`) |

By credential: **8 platform-key-only handlers, 3 grant-only handlers, 2
dual-credential handlers (schema, whoami), 1 unauthenticated (openapi.json)**.

### 2.1 Contract One — `POST /api/partner/jobs` (platform key)

`createPartnerJob()` (`partner-jobs.ts:100-191`). This is the endpoint for a
vacancy IDAP wants to publish **whether or not** it holds a grant for that
school yet — the result is a publicly visible, immediately-live, claimable
listing (`origin: "aggregated"`), exactly like eduFleet's own cold-start
listings sourced from print classifieds. A real school can later claim it
through eduFleet's own claim flow, independent of IDAP.

Required: `externalJobId`, `title`, `subject`, `description`,
`institutionName`, `city`. Optional: `district`, `taluk`, `state` (defaults to
`"Karnataka"`), `salaryMin`, `salaryMax`, `experienceRequired` (defaults `0`),
`facilities[]`, `sourceUrl`.

Validation order in `createPartnerJob`: externalJobId non-empty → title
non-empty → institutionName non-empty → city non-empty → description
non-empty → `isValidJobSubject(subject)` → Karnataka district/taluk (only
validated if sent — a partner may hold nothing finer than a city; confirmed by
the spec "accepts a city-only push") → `assertValidNumbers` (salary/experience
non-negative, `salaryMin ≤ salaryMax`) → **dedupe check against the shared
`(partnerId, partnerExternalJobId)` id-space** (§5).

Success (201):
```json
{
  "jobId": "...", "externalJobId": "...", "slug": "...",
  "status": "active", "claimStatus": "unclaimed",
  "publicUrl": "https://.../jobs/{slug}/{id}",
  "claimUrl": "https://.../claim/{claimToken}"
}
```
`sourceAttribution.publication` is stamped with the partner's own `name`
("IDAP"), and `sourceUrl` if sent. Also triggers the same instant
teacher-match alert fan-out a school's own posting gets (failure-isolated —
an alert error never fails the push).

### 2.2 Contract One update — `PATCH /api/partner/jobs/{externalJobId}` (platform key)

`updatePartnerJob()` (`partner-jobs.ts:196-251`). Looks the job up by
`{partnerId, partnerExternalJobId, origin: "aggregated"}` — the `origin`
discriminator is load-bearing: without it a bare platform key could reach a
Contract-Two (`school_posted`) job stamped with the same
`(partnerId, partnerExternalJobId)` pair and retitle/reactivate a school's own
posted listing. Verified directly by a spec test.

Patchable: `title`, `description`, `salaryMin`, `salaryMax`,
`experienceRequired`, `facilities[]`, `status` (`"active"|"closed"` only —
partial updates, only the fields sent are touched).

Refused with `403 claimed` if `claimStatus` is `"claimed"`,
`"claim_pending"`, or `"withdrawn"`, **or** if `hiddenPendingReview` is true
(an admin takedown request pending review) — the last case is worth noting
specifically: `claimStatus` can still read `"unclaimed"` while the listing is
untouchable, because `hiddenPendingReview` is an independent flag.

Success (200): `{ jobId, externalJobId, title, status, claimStatus }`.

### 2.3 Contract Two — `POST /api/partner/school/jobs` (grant)

`postSchoolJob()` (`partner-school-jobs.ts:58-131`). Deliberately calls the
**same** `createJob()` the school's own dashboard form calls, with the
school's own `userId` — so taxonomy validation, the free-plan active-job cap,
Pro featuring, and the teacher-alert fan-out all apply identically. *"Delegation
is a subset of the school's own rights by construction, not by a parallel
implementation that could drift."*

Required (per `SchoolJobInput`): `externalJobId`, `title`, `subject`,
`description`. Optional: `city`, `branchId`, `salaryMin`, `salaryMax`,
`experienceRequired`, `facilities[]`. **No `institutionName`, no
`sourceUrl`** — the grant already identifies exactly one school, so there is
nothing to attribute.

**Discrepancy worth flagging:** `partnerSchema().rules.required.schoolJob`
(`partner-contract.ts:30`) lists only `["externalJobId", "title", "subject",
"description"]` and never mentions `city` or `branchId` anywhere in the
self-described contract. But the underlying `createJob()` throws
`ValidationError("Job needs a location or branch")` if **neither** `city` nor
`branchId` is supplied. An integrator that follows the documented "required"
list literally — sending only the four listed fields with no city and no
branch — will get a runtime 400 the schema never predicted. `branchId` itself
is not documented anywhere in `partnerSchema()`'s `jobShape` either, though it
is a real, accepted `SchoolJobInput` field (it resolves to a sub-document in
`School.branches`, which is also how the school's own dashboard lets a
multi-branch school choose a location).

Success (201): `{ jobId, externalJobId, status, featured, publicUrl }`. No
`claimStatus`/`claimToken` — a Contract-Two job is never "aggregated", so
claim semantics never apply to it. `featured` is `true` automatically for a
Pro-plan school.

Free-plan cap: `UpgradeError` → `403 { reason: "upgrade_required" }` at 3
active jobs (`FREE_ACTIVE_JOB_LIMIT`), the same cap the school's own dashboard
enforces.

### 2.4 Contract Two update — `PATCH /api/partner/school/jobs/{id}` (grant)

`updateSchoolJob()` (`partner-school-jobs.ts:133-168`). `{id}` here is the
Mongo `_id`, **not** `externalJobId` — asymmetric with the Contract-One PATCH
route, which addresses by `externalJobId`. Scoped to
`{_id, schoolId, partnerId}` so a grant can only touch what it posted for
that specific school.

Patchable: `title`, `description`, `salaryMin`, `salaryMax`,
`experienceRequired`, `facilities[]`, `status` — **and `status` accepts only
`"closed"`.** There is no reopen capability at all, by design: *"the school's
own dashboard has no reopen action either (only closeJobAction → closeJob),
so a delegated grant may only ever be a subset of the school's own rights,
never a superset."* Sending `"active"` (or any other string) is a
`ValidationError`, verified directly by spec.

Success (200): `{ jobId, title, status }`. **Note: no `externalJobId` in the
response**, unlike the Contract-One PATCH response — a minor asymmetry a
connector implementer should not assume away.

### 2.5 `GET /api/partner/school` (grant)

`schoolSnapshot()` (`partner-school-jobs.ts:170-190`).
```json
{
  "schoolId": "...", "schoolName": "...", "city": "...", "plan": "free|pro",
  "activeJobs": 0, "freeSlotsRemaining": 3,
  "partnerJobs": [{ "jobId": "...", "externalJobId": "...", "title": "...", "status": "...", "publicUrl": "..." }]
}
```
`freeSlotsRemaining` is `null` on Pro (unlimited). This is the only partner
route that returns the school's name and city — the redeem response (§1.2)
does not.

### 2.6 `GET /api/partner/whoami`, `GET /api/partner/schema`, `GET /api/partner/contract`

- **whoami** branches on token prefix (`GRANT_TOKEN_PREFIX` vs not). Grant
  branch returns `{ credential: "grant", partner: {name, slug}, schoolId,
  schoolName, externalRef, scopes, dailyWriteCap, writesToday, requestCount
  }`. Platform-key branch returns `{ credential: "platform_key", partner,
  scopes, dailyWriteCap, writesToday, requestCount, keyPrefix }`. This is the
  only place an integrator learns its own daily cap and today's usage — the
  schema/contract endpoints don't carry those numbers at all.
- **schema** returns `partnerSchema()` verbatim (see §7) — readable with
  either credential, since a grant-only integrator still needs the field
  contract.
- **contract** returns `{ version, errors: errorCatalog() }` — **platform key
  only**, unlike schema/whoami which accept either. A grant-only holder has no
  route to fetch the error catalog directly (it could still be read from the
  unauthenticated `/openapi.json`'s error descriptions, but those are generic
  per-status blurbs, not the reason-code table in §6).

---

## 3. Contract One vs Contract Two — the field split IDAP needs

Since IDAP will call **both** contracts (Contract One for schools it has not
yet connected — sourced/claimable listings; Contract Two for schools it has a
live grant for), the exact field delta matters:

| Field | Contract One (platform key) | Contract Two (grant) |
|---|---|---|
| `externalJobId` | required | required |
| `title` | required | required |
| `subject` | required | required |
| `description` | required | required |
| `institutionName` | **required** | not accepted — the grant already names the school |
| `city` | **required** | optional, but a location is still needed: **either `city` or `branchId`, or the write 400s** (undocumented in the schema — see §2.3) |
| `district` / `taluk` / `state` | optional, Karnataka-validated | not in `SchoolJobInput` at all |
| `salaryMin` / `salaryMax` / `experienceRequired` | optional | optional |
| `facilities[]` | optional | optional |
| `sourceUrl` | **platform-key only** — where the vacancy was advertised | not accepted |
| `branchId` | not in `PartnerJobInput` at all | optional, undocumented in `partnerSchema()` |
| Resulting `origin` | `"aggregated"` | `"school_posted"` |
| Claimable? | Yes — `claimToken`/`claimUrl` issued | No — already owned |
| Free-plan cap applies? | No (not tied to a school's own quota) | **Yes** — same 3-active-job cap the school's dashboard enforces |
| `featured` on Pro plan | Not applicable (no `schoolId` yet) | Yes, automatic |

---

## 4. The dedupe and ownership rule — read this twice

`externalJobId` is unique **per partner**, and — this is the single easiest
thing to implement wrongly — **that id-space is shared across both
contracts.** The uniqueness index is on `(partnerId, partnerExternalJobId)`
regardless of which route created the row (`Job.ts` compound partial unique
index, `partner-jobs.ts:83-88` referenced from both `createPartnerJob` and
`postSchoolJob`).

A re-post of an existing `externalJobId` — from **either** contract — always
returns `409 duplicate_external_job` carrying:
```json
{ "error": "...", "reason": "duplicate_external_job", "jobId": "<existing id>", "contract": "platform" | "school" }
```
`contract` tells you which side **actually owns** the existing row — not
which side you called from. This matters because a same-partner collision
across contracts is real and tested explicitly in both directions:

- Contract One collides with an existing Contract-Two job → `contract:
  "school"`. The platform key's own PATCH endpoint (`origin: "aggregated"`
  scoped) will **404** on that id — the caller must PATCH via
  `/api/partner/school/jobs/{id}` (grant) instead, and that route needs the
  Mongo `_id`, not the `externalJobId`, to do it (§2.4).
- Contract Two collides with an existing Contract-One job → `contract:
  "platform"`. Symmetric problem in the other direction.

Both directions are covered by dedicated spec tests titled *"reports the
OWNING contract, not the caller's, on a cross-contract externalJobId
collision"* in both `partner-jobs.spec.ts` and `partner-school-jobs.spec.ts` —
this is clearly a deliberately-designed and deliberately-tested rule, not an
incidental side effect.

**Practical implication for a connector:** never assume "I posted this
`externalJobId` through Contract Two, so a 409 on it always means PATCH my
own school/jobs endpoint." Always branch on the `contract` field in the 409
body. A connector that ignores `contract` and blindly retries its own PATCH
endpoint will get a 404 exactly in the cross-contract collision case.

Two further wrinkles, both verified by spec:
- **Race safety, not just a pre-check.** Every create path (`createPartnerJob`,
  `postSchoolJob`) does a `findOne` pre-check, then relies on the real partial
  unique index to catch a concurrent double-post; on an E11000 it re-queries
  and returns the identical 409 shape a sequential caller would have gotten —
  never a raw 500.
- **`postSchoolJob`'s race case is even sharper.** If two racers both pass the
  pre-check, the *losing* racer's own `createJob()` call has already fully
  succeeded (free-plan slot consumed, document persisted, teacher-alert
  fan-out fired) by the time its own attribution save collides. That orphaned,
  un-attributed `school_posted` job would otherwise sit invisibly occupying a
  free-plan slot forever — the code detects this and explicitly closes the
  orphan before returning the 409 for the winning job. Confirmed by spec.

---

## 5. Error catalog, verbatim

From `errorCatalog()` (`partner-contract.ts:59-80`), also reachable live at
`GET /api/partner/contract` (platform key):

| Status | Reason | Meaning |
|---|---|---|
| 400 | `validation_failed` | One or more fields are invalid; see `details[]`. |
| 401 | `revoked` | This credential was revoked — for a grant, the school disconnected. |
| 401 | `partner_revoked` | The partner registration was revoked. |
| 401 | `partner_inactive` | The partner is paused by an eduFleet admin. |
| 403 | `insufficient_scope` | This credential does not hold the scope the route requires. |
| 403 | `claimed` | A school has claimed this listing; a platform key can no longer edit it. |
| 403 | `school_unavailable` | The linked school is suspended or not approved. |
| 403 | `upgrade_required` | The school's plan has no active-job slots left. |
| 404 | `not_found` | No such job or request for this partner. |
| 409 | `duplicate_external_job` | That `externalJobId` already exists; the response carries `jobId` (and `contract` — see §4). |
| 409 | `duplicate_open_request` | An open connection request already exists for that `externalRef` or school. |
| 409 | `not_approved` | The connection request has not been approved yet. |
| 409 | `not_pending` | The request is no longer in a state that allows this transition. |
| 409 | `already_redeemed` | This connection request was already exchanged for a grant. |
| 409 | `grant_race` | **Reserved for a future concurrent-redeem scenario; not currently emitted** — a concurrent redeem loss surfaces as `already_redeemed` instead. Verified live in the codebase and pinned by its own spec test. A connector should not build a code path expecting to see this. |
| 500 | `corrupt_state` | A connection request's linked school reference is missing or invalid — contact support with the request id. |
| 429 | `rate_limited` | Too many requests in the current minute (also used for a lost write-budget race — see §1.4). |
| 429 | `write_cap_exceeded` | The daily write cap for this credential is spent. |

Two reasons exist in the code but are **not** in this catalog and are **not
reachable from any partner route** — surfaced only by school-session/admin
actions (`schoolRespondToRequest`, `revokeSchoolGrant`), not worth building
connector handling for: `403 forbidden` ("this request/grant belongs to a
different school/school"). Listed here only so their absence from the table
above isn't mistaken for an omission.

---

## 6. Reference-data constraints

### 6.1 Subject enum (`JOB_CATEGORIES`, `taxonomy.ts:20-28`)

16 fixed subjects, each with a `group`:
- **academic:** Mathematics, Physics, Chemistry, Biology, English, Kannada,
  Hindi, Social Science
- **administration:** Principal, Vice Principal, Coordinator, Administrator
- **support:** Accountant, Clerk, Driver, Librarian

Enforced by `isValidJobSubject()` — exact string match against `.name`, not
fuzzy. `categoryGroup` on the created `Job` is derived automatically
(`jobGroupOf`), never sent by the caller.

### 6.2 Facilities enum (`JOB_FACILITIES`, `job-facilities.ts:6-18`)

11 fixed values, sent/received as the literal label string (not a code):
Provident Fund (PF), ESI (medical insurance), Gratuity, Health insurance,
Staff accommodation, Transport / bus facility, Free / subsidised meals, Paid
leave, Annual / festival bonus, Training & development, Maternity benefits.

`sanitizeFacilities()` silently drops anything not on this list and
de-duplicates — an unrecognized facility string is **not** a validation
error, it is silently discarded. Worth building a connector-side warning for,
since eduFleet will never tell you it dropped something.

### 6.3 Karnataka district/taluk (`karnataka-taxonomy.ts`)

`district` is validated only if sent (`isValidKarnatakaDistrict` —
`Object.hasOwn`, not `in`, deliberately avoiding a prototype-chain match on
keys like `"constructor"`). `taluk` is validated only if sent, and only
against the specific `district` sent alongside it
(`isValidKarnatakaTaluk(district, taluk)`) — a taluk is meaningless without
its district. Both checks are **skipped entirely** if `state` (defaulting to
`"Karnataka"`) resolves to anything else — no reference data exists for other
states, so anything outside Karnataka passes through unvalidated. The full
29-district → taluk table is hand-maintained in `karnataka-taxonomy.ts` and
is out of scope to reproduce here; use `districtsForState("Karnataka")` /
`taluksForDistrict()` live, or read the file directly.

### 6.4 Salary and experience rules

`assertValidNumbers()` (`partner-jobs.ts:81-90`), shared by both contracts:
`salaryMin ≥ 0`, `salaryMax ≥ 0`, `experienceRequired ≥ 0`, and
`salaryMin ≤ salaryMax` when both are present. Both salary fields are
**monthly rupee amounts**; both fully optional on both contracts.
`experienceRequired` defaults to `0` (years) when omitted.

### 6.5 Defaults

`state` defaults to `"Karnataka"` when omitted (both contracts). `status`
defaults to `"active"` on create; only `"active"`/`"closed"` are ever legal
values, and Contract Two's PATCH accepts only `"closed"` (§2.4).

---

## 7. The self-describing surfaces, and where they under-describe reality

`GET /api/partner/schema` (`partnerSchema()`, `partner-contract.ts:13-57`)
publishes `version`, `credentials` (prefixes + header format), `enums`
(subjects, facilities, districts, jobStatus, scopes), `rules` (required-field
lists, dedupe prose, moderation prose, quota prose, location prose, salary
prose, consent prose), and `jobShape` (a plain-English field-by-field
description). `GET /api/partner/openapi.json` (`openApiDocument()`,
`partner-contract.ts:84-131`) publishes a real OpenAPI 3.1 document covering
all 14 handlers with generic per-status-code response descriptions (no
per-field schemas — every response is typed `{type: "object"}`).

Gaps between what's published and what's real, beyond the schoolJob
required-list gap already covered in §2.3:
- Neither document mentions the daily write cap's numeric value or today's
  usage — only `whoami` carries those (§2.6).
- Neither document mentions that 429s carry no `Retry-After` header (§1.4).
- `openApiDocument()` does not list itself (`/api/partner/openapi.json`) as a
  path — trivial, but means the document is not fully self-describing of the
  full route surface.
- The redeem response's exact shape (`token, schoolId, externalRef, scopes,
  prefix` — no school name/city) is not written down anywhere in
  `partnerSchema()` or the OpenAPI doc's generic `{type: object}` responses;
  it's only knowable by reading `redeem/route.ts` directly, which is what this
  document did.

---

## 8. Vehicles and used items — full detail

Model: `web/src/models/MarketplaceListing.ts`. Service:
`web/src/lib/services/listings.ts`. **No route under `web/src/app/api`
references `MarketplaceListing` at all** — confirmed by a repo-wide grep
returning zero files. Every mutation runs through
`requireApprovedSchool(userId)`, i.e. the school's own logged-in session, and
is invoked exclusively from Server Actions (`web/src/lib/actions.ts`) behind
the dashboard UI. There is no partner-key path, no grant path, not even an
unauthenticated read path — nothing analogous to §2 exists for this model.

### 8.1 Schema

```
listingType    enum ["vehicle", "asset"], required
category       enum, required — vehicle: "bus"|"van"|"minibus"; asset: "furniture"|"lab"|"computers"|"sports"|"other"
title          String, required
description    String, required
price          Number, required, min 0
condition      enum ["excellent", "good", "fair"], required
photos         [String], default []
vehicle        { registrationNumber (uppercased), modelYear (min 1980), seatingCapacity (min 1) }
               — required as a whole IF listingType === "vehicle"; absent for "asset"
status         enum ["pending", "approved", "rejected", "sold"], default "pending"
rejectionReason String
schoolId       ObjectId ref School, required
```

No `partnerId`, no `externalJobId`-equivalent, no source-attribution field of
any kind — the schema was never built with an external pusher in mind. There
is nothing to dedupe against and nothing that would let a partner claim
authorship the way `Job.partnerId`/`partnerExternalJobId` does.

### 8.2 Ownership and moderation

`createListing()` (`listings.ts:43-73`): school-session only, one owner per
listing (`schoolId`), status always starts `"pending"`. **Used-asset listings
are feature-flagged off** — `assetsEnabled()` checks
`process.env.PHASE2_ASSETS === "true"`; when unset (the current state), any
`listingType: "asset"` create throws `ValidationError("Used-asset listings
arrive in Phase 2 — vehicles only for now")`. Vehicles are live; assets are
not, independent of any API question.

Moderation is a flat admin approve/reject (`approveListing`/`rejectListing`,
admin-session only) — no multi-party consent state machine like the
job-connection flow, because there is no concept of a listing not already
belonging to the posting school. There is correspondingly **no claim
mechanism** — nothing like `claimStatus`/`claimToken` exists on this model,
because nothing is ever "sourced" from outside; every listing is created by
the school that owns the thing being sold.

`markSold()` (owner-only) is the only other write path, flipping `status →
"sold"` and removing it from the public marketplace immediately.
`listPublicListings`/`getPublicListing` are public reads, `status: "approved"`
only, with suspended schools' listings excluded.

### 8.3 Verdict

If IDAP wants to push vehicle or used-item listings to eduFleet the way it
will push jobs, **eduFleet has to build that surface first** — there is
nothing to connect to today, not even a session-cookie route to reverse-
engineer. This is the FeesBasket-offers situation again, but one level more
absolute: FeesBasket's offers were reachable, just not partner-writable.
eduFleet's marketplace listings aren't reachable by any HTTP contract at all.

---

## 9. What IDAP does not have

eduFleet's partner API is entirely **job/vacancy-centric** — `sync()` in
IDAP's own adapter framework pushes exam **results**; eduFleet's contract
wants a teacher **vacancy**. IDAP's 22 models (`AcademicUnit`, `Achievement`,
`Activity`, `Alumnus`, `ApiClient`, `Application`, `Counter`, `Device`,
`Document`, `FeeStructure`, `Institution`, `Lead`, `Note`, `Offer`,
`PlatformConnection`, `PlatformCredential`, `RateLimit`, `RefreshToken`,
`Result`, `Scholarship`, `SyncRun`, `User`) have **no job or vacancy domain of
any kind** — confirmed by a repo-wide grep for `job|vacancy|teacher.?post|
recruit` across every model file: the only hits are `Result.ts`'s campus
**placement recruiter** fields (companies hiring *students* after
graduation — an entirely different concept from a *school hiring a teacher*)
and an unrelated cron-job code comment in `Lead.ts`.

Field-by-field, against `PartnerJobInput`/`SchoolJobInput`:

| eduFleet job field | Source in IDAP today? |
|---|---|
| `externalJobId` | No — nothing to key off; IDAP has no vacancy record to assign a stable id to |
| `title` | No |
| `subject` | Loosely — `Institution.academic.segments`/`classesOffered` describe what a school teaches, not an open teaching position with a specific subject |
| `description` | No |
| `institutionName` | **Yes** — `Institution.institutionName` |
| `city` | **Yes** — `Institution.city` |
| `district` / `taluk` / `state` | **Yes** — `Institution.district`, `Institution.taluk`, `Institution.state` all exist and are separately indexed/validated fields already |
| `salaryMin` / `salaryMax` | No — nothing resembling staff compensation exists anywhere in IDAP; `FeeStructure`/`Offer`/`Scholarship` are all about what a *student* pays or receives, never what a school pays a hire |
| `experienceRequired` | No |
| `facilities[]` | **Vocabulary mismatch, not a match** — `Institution.facilities` (`FacilitySchema: {code, label, available, note}`) is a free-form list of campus/student-facing infrastructure (labs, library, etc. — the schema is deliberately open-ended, "any code with any label is storable"); eduFleet's `JOB_FACILITIES` enum is a closed list of **employee benefits** (PF, ESI, gratuity, staff accommodation, maternity benefits...). Nothing on `Institution` maps onto that list without inventing new data. |
| `sourceUrl` | No |

**Bottom line:** `institutionName`, `city`, `district`, `taluk`, `state` have
a direct, ready-to-map source on IDAP's `Institution` model today. Everything
else that defines an actual vacancy — id, title, subject-as-a-hiring-need,
description, salary, experience, employee-facing facilities — has **no
source anywhere in IDAP**. A connector cannot synthesize these from existing
IDAP data; they require a **new domain** (something like a `JobPosting`
model, school-authored) that does not exist yet. This is not a mapping
exercise to get right — it's a green-field feature IDAP would need to build
first, matching what the spec `docs/superpowers/specs/2026-08-27-platform-
connections-design.md` (§12.2) already anticipated: *"a new IDAP domain
(recruitment posts do not exist in IDAP today)."*

Vehicles and used items fare the same way structurally (no `Vehicle`/`Asset`-
for-sale model exists in IDAP either), but per §8 the point is moot — there's
nowhere on eduFleet's side to push them to yet regardless.

---

## 10. Fit against IDAP's existing adapter interface

Compared against `src/lib/connectors/types.ts`, `http.ts`, `index.ts`, and the
working PassPercent implementation (`passpercent.ts`,
`passpercent-mapping.ts`) as the only precedent. `PLATFORMS` in
`src/lib/constants.ts` is currently `["PASSPERCENT", "FEESBASKET"]` —
eduFleet is not registered yet.

### 10.1 Where it fits cleanly

- **`AdapterContext = { baseUrl, platformKey, http }`** — fits directly.
  eduFleet accepts `Authorization: Bearer <token>`, exactly what
  `createConnectorHttp` always sends.
- **`connectMode: "REQUEST_APPROVE_REDEEM"`** — eduFleet's four-step
  connection lifecycle (§1.2) is precisely this mode; `initiate`/`refresh`
  map almost mechanically onto it:
  - `initiate()` → `POST /api/partner/connection-requests` →
    `InitiateResult { remoteRequestId, remoteStatus }` maps directly onto
    `{ requestId, status }`. The 409-with-existing-`requestId` "adopt and
    continue" pattern PassPercent's `initiate()` already implements
    (`passpercent.ts:107-117`) is exactly eduFleet's
    `duplicate_open_request` shape too — same code, no new logic needed.
  - `refresh()`'s status switch (`PENDING`/`AWAITING_APPROVAL`/`REJECTED`/
    redeem-on-approved) maps one-to-one onto eduFleet's five states
    (`pending`/`awaiting_school`/`rejected`/`approved`→redeem/`completed`)
    — the `"completed"`-without-IDAP-having-redeemed defensive branch
    PassPercent already has (someone/something else redeemed first) is the
    same shape as eduFleet's `already_redeemed`/`not_approved` 409s.
- **`RefreshResult.kind: "CONNECTED"`**'s `grantToken`/`scopes` fields map
  directly onto eduFleet's redeem response `token`/`scopes`.
- **`PlatformCredential`** (one row per platform, globally unique) matches
  eduFleet's single-platform-key-per-partner model exactly.
- **`PlatformConnection`** (`institutionId`+`platform` unique,
  `remoteRequestId`, `externalRef`, `grantTokenEncrypted`, `scopes`,
  `remoteInstitution` snapshot) structurally fits the per-school grant
  relationship well.

### 10.2 Where it strains

- **`remoteInstitution: {name?, city?, slug?}` has a thin, roundabout
  source.** eduFleet's redeem response carries none of these three fields
  (§1.2) — only `schoolId`/`externalRef`/`scopes`/`prefix`. `name`/`city` are
  only obtainable via a **follow-up call** to `GET /api/partner/school` using
  the just-minted grant. `slug` has **no source anywhere in eduFleet's
  partner surface** — `School.ts` itself has no `slug` field at all
  (confirmed by direct grep), so that part of `RefreshResult`/`ConnectResult`
  can never be populated for an eduFleet adapter, only left `undefined`
  forever. Not fatal, but a real extra round-trip and a permanently-null
  field the generic type implies might be available.
- **`sync(ctx, connection, data: SyncSourceData)` is built for the wrong
  shape of data.** `SyncSourceData = { institution, results: PUBLISHED-only
  DTOs, readPublicMedia }` — this is Result-centric by construction (built
  for PassPercent's exam-results push). eduFleet's job endpoints want a
  vacancy payload with no analog anywhere in `SyncSourceData` today. There is
  no `jobs`/`vacancies` field on that type, and — per §9 — no IDAP source
  data to populate one from even if the type were extended. This is the
  central mismatch: it's not a mapping-function problem the way
  PassPercent's `passpercent-mapping.ts` was: it's that the type itself and
  the underlying domain data both need to be built.
- **The one-shot-batch `sync()` model doesn't match per-vacancy CRUD
  semantics anyway.** PassPercent's `sync` pushes one profile PATCH plus a
  handful of per-year result PUTs in a single run — a periodic
  "re-synchronize everything" operation. eduFleet's job contract is
  per-entity create/update against a stable `externalJobId`
  (§4's dedupe rule, 409-with-`contract` semantics) — closer to ordinary
  REST CRUD on individual vacancy rows than to a batched profile sync. The
  `PlatformAdapter` interface has no method shaped like "push/update one
  entity with its own external key and interpret a 409" today; `sync()`
  alone doesn't give a natural home for that. A jobs adapter most likely
  needs a new method on `PlatformAdapter` (something like `pushJob`/
  `updateJob`), not a `SyncSourceData` extension plus reuse of the existing
  `sync()` signature.
- **`ConnectorHttp`'s 429 retry-after handling is dead weight against
  eduFleet** — eduFleet never sends `Retry-After` (§1.4), so the shared
  client's `Retry-After`-aware branch never fires; every 429 retry against
  eduFleet takes the flat 2-second fallback. Not a functional problem, just
  worth knowing when reading retry behavior in logs.
- **`connectWithKey` (`PASTE_KEY` mode) has no eduFleet counterpart** —
  eduFleet has exactly one connect mode (`REQUEST_APPROVE_REDEEM`); nothing
  to build there, just noting the interface's other mode is unused for this
  platform, same as it already is for PassPercent.

### 10.3 Overall verdict

The **credential/connection half** of the adapter interface — `initiate`,
`refresh`, the state-machine shape, the credential storage models — fits
eduFleet closely enough to reuse almost mechanically from the PassPercent
precedent, module-for-module. The **`sync`/payload half** does not fit at
all, because it was built for a fundamentally different kind of data
(periodic profile+results push) against a domain eduFleet doesn't share
(academic results). Building an eduFleet connector is really two separable
efforts: (1) a straightforward connection-lifecycle adapter, largely copy-
adapt from `passpercent.ts`'s `initiate`/`refresh`, and (2) a new IDAP
job/vacancy domain plus new adapter-interface surface for per-entity pushes —
and (2) is the one with no existing scaffolding to build from.

---

## 11. Ambiguities flagged, not resolved

- **`grant_race` (409)** is documented in the error catalog and pinned by its
  own spec test as *"reserved for a future concurrent-redeem scenario; not
  currently emitted"* (`partner-contract.ts:75`,
  `partner-contract.spec.ts:36-41`). Left exactly as documented here — do not
  build connector logic that expects to see it; do not assume it will never
  appear either, since it is explicitly reserved for a scenario the code
  doesn't yet implement.
- **`SchoolJobInput.city` is typed optional but is not effectively
  optional** whenever `branchId` is also omitted — see §2.3/§3. Reported as a
  contract/implementation discrepancy above; not resolved in either
  direction here (i.e., this document does not guess whether eduFleet
  intends `city` to become formally required, or the "needs a location or
  branch" check to relax).
