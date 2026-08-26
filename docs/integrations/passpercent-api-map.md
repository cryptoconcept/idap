# PassPercent inbound integration API — reference map for IDAP

Repo: `/Users/automicai/Documents/GitHub/passpercent` (read-only recon; nothing modified).
HEAD at time of writing: `ae412fe` ("fix: two deferred Minors that were mis-filed — a vacuous
assertion and a lying quota"). All line numbers below are against that commit's working tree.

**Ground truth order used throughout:** live route handlers > models/middleware >
`docs/PARTNER_INTEGRATION_SPEC.md` (v2.0.0, exceptionally well-maintained but not
code) > design docs under `docs/superpowers/` (aspirational/historical) > any older
doc. Every disagreement found is called out explicitly in §7.

The previous brief's premise (`POST /connection-requests`, a poll, a redeem step,
platform-initiated consent) is **correct as of the current code** — that is exactly
what shipped. What's new since that investigation is a full **two-tier** credential
model (platform key + per-institution grant) and a mature, largely-accurate written
spec (`docs/PARTNER_INTEGRATION_SPEC.md`) that IDAP should be pointed at directly.
This file exists to (a) confirm that spec against the actual code and (b) flag the
handful of places it has already drifted.

---

## 0. Two separate machine APIs — don't conflate them

| | Onboarding (`/api/agent`) | Partner (`/api/partner`) |
|---|---|---|
| Who | An untrusted AI agent drafting *new* listings for human review | A registered external platform (IDAP) maintaining *existing, live* schools it's connected to |
| Creates listings? | Yes, always `pending`+unclaimed | No — never creates directly; can trigger an admin to draft one via a connection request |
| Edits a live/claimed listing? | **Never** — `writeGuard()` refuses once approved or claimed | Yes — that's the entire point |
| Credential | `ApiKey` (`pp_agent_…`) | `PartnerKey` (`pp_pkey_…`) + `PartnerGrant` (`pp_pgrant_…`) |
| File | `backend/src/routes/agent.js` | `backend/src/routes/partner.js` + `backend/src/routes/partnerPlatform.js` |

**IDAP wants the Partner API.** The design doc (`docs/superpowers/specs/2026-08-25-idap-integration-design.md`)
explicitly rejected bolting onto `/api/agent` for this reason (lines 19-24 of that
file). Do not design IDAP's push flow against `/api/agent` — it structurally cannot
update a claimed/approved school.

---

## 1. Authentication — three (not two, not four) credential types in practice

Swagger's own comments (`backend/src/docs/swagger.js:41-75`) number these as
credential families 3 and 4 in the file's running numbering (JWT bearer + agent key
are 1/2), but functionally there are three kinds of secret an integrator will ever
hold:

| Credential | Prefix | Model | Middleware | Identifies |
|---|---|---|---|---|
| Institution JWT | n/a (session bearer) | n/a | `middleware/auth.js` | A school's own dashboard login — **never held by IDAP** |
| Platform key | `pp_pkey_…` | `models/PartnerKey.js` | `requirePlatformKey()` — `backend/src/middleware/platformAuth.js:61-121` | **IDAP itself** — one per registered platform |
| Grant token | `pp_pgrant_…` | `models/PartnerGrant.js` | `requireGrant(scope)` — `backend/src/middleware/partnerAuth.js:115-513` | One (IDAP, institution) pair |

Sent as `Authorization: Bearer <token>` or `x-api-key: <token>` — both middlewares'
`extractToken()` accept either (`platformAuth.js:41-45`, `partnerAuth.js:90-94`).

**Two-layer model confirmed, and it is structural, not just documented:**
- A platform key (`requirePlatformKey()`) **never resolves an `Institution` at all** —
  grep-confirmed, `platformAuth.js` imports only `PartnerKey`/`Partner`. It can only
  manage connection requests.
- A grant token (`requireGrant()`) resolves exactly one `Institution` (`grant.instId`)
  and every downstream route in `partner.js` reads/writes `req.institution` only —
  never an id from the request body/params. This is what makes cross-tenant writes
  **structurally** impossible, not merely policy (`partnerAuth.js:102-114`).
- `requirePlatformOrGrant()` (`platformAuth.js:144-156`) is dual-auth used on exactly
  one route — `GET /partner/schema` — dispatching on token prefix (`pp_pkey_` vs
  anything else) so IDAP can read the contract before it holds a single grant.

**Minting:**
- Platform key: admin-only, `POST /admin/partners` (`backend/src/routes/admin.js:2368`,
  `super_admin`) — created once per platform, shown in plaintext exactly once.
  Rotation: `POST /admin/partners/:id/rotate-key` (`admin.js:2558`) = revoke + mint,
  old key dies immediately.
- Grant token: **only** minted by `POST /partner/connection-requests/:id/redeem`
  (`backend/src/routes/partnerPlatform.js:420-623`) — see lifecycle below. There is
  no other path to a grant token; `POST /partner/link`, the old connect-code
  exchange, is fully retired (routes/model deleted — confirmed no `PartnerConnectCode`
  references remain in `routes/partner.js`).

**Scopes:** Grant scopes are `['profile:write', 'results:write']`
(`models/PartnerGrant.js:22-25`), clamped at mint to `Partner.allowedScopes`
(`partnerPlatform.js:509-516`). Platform keys are **not scoped** — "the credential
family itself is the boundary" (spec §2). `PATCH /partner/institution` requires
`profile:write`; `PUT /partner/institution/results/:year` requires `results:write`;
`GET /partner/whoami`, `GET /partner/schema`, `GET /partner/institution` need no
scope at all.

**Hashing:** Both `PartnerKey.keyHash` and `PartnerGrant.tokenHash` are SHA-256 of a
32-byte CSPRNG token (`models/PartnerKey.js:28-33`, `models/PartnerGrant.js:289-297`)
— not bcrypt, deliberately (see `ApiKey.js`'s header, referenced by both). Plaintext
is returned exactly once, at mint/redeem, and never again.

**Rate limits:**
- `POST /partner/connection-requests`: 20 requests / 15 min, IP-keyed, **production
  only** (`partnerPlatform.js:94-101`).
- Every grant-tier call: 60/min in-process sliding window (`partnerAuth.js:40,70-87`)
  — explicitly documented as not a real bound on serverless (per-instance counter).
- No per-minute limiter on platform-key connection-management calls at all
  (`platformAuth.js:20-31` — deliberate, "comparatively rare, admin/ops-triggered").

---

## 2. The connection/consent lifecycle

**Confirmed exactly as the prior brief's newer finding described: platform-initiated,
no connect codes.** Full state machine, `PartnerConnectionRequest.js:12-21` +
`GET /partner/contract`'s live `lifecycle.transitions` (`partnerPlatform.js:770-781`):

```
pending → awaiting_school → approved → completed   (terminal)
   ↓            ↓               ↓
rejected    rejected        rejected                (terminal, from any open state)
   ↑
awaiting_school → rejected  (actor: "system" — see below, a genuinely new wrinkle)
```

Statuses: `pending`, `awaiting_school`, `approved`, `rejected`, `completed`
(`models/PartnerConnectionRequest.js:95-99`).

### Step-by-step

1. **IDAP submits.** `POST /api/partner/connection-requests` (platform key).
   `backend/src/routes/partnerPlatform.js:246-344`.
   Required: `externalRef` (≤120 chars), `name` (2-200), `city` (≤100).
   Optional context (not enum-checked — free text for the admin's eyes):
   `board`, `type`, `phone`, `addressLine`, `area`, `district`, `state`, `pincode`,
   `website`, `contactName`, `contactEmail` (exact maxlengths at
   `partnerPlatform.js:129-133`).
   → `201 { requestId, status: "pending" }`.
   → `409 { error, requestId, status }` if an **open** request for the same
   `(partnerId, externalRef)` already exists (partial unique index,
   `PartnerConnectionRequest.js:158-161`) — **except** it can also swallow an orphan
   and return a fresh `201` instead (see "system" transition below).

2. **PassPercent admin reviews and matches.** `GET /admin/partner-requests`
   (`admin.js`, queue with fuzzy name+city match candidates), then
   `POST /admin/partner-requests/:id/approve` (`admin.js:2716`) with either
   `{instId}` (link to an existing listing) or `{createNew:true}`.
   - **Target is unclaimed or nonexistent** (admin drafts new, or links to an
     unclaimed listing) → straight to `approved`. No one to ask consent of.
     A newly-drafted listing is `status:'pending', isUnclaimed:true, source:'partner'`
     — same population as agent-created drafts. **The connection can be `approved`
     while the listing itself is still `pending` moderation** — this is the "not
     always immediately usable" gap, see §4.
   - **Target is claimed** (`isUnclaimed:false`) → `awaiting_school`. Server-enforced:
     the approve route re-reads the target's *current* claimed state; nothing in the
     request body can skip this (invariant 9, `docs/superpowers/specs/2026-08-26-platform-integration-design.md:157`).
   - `POST /admin/partner-requests/:id/reject` (`admin.js:2964`) with `{reason}` →
     `rejected` from any open state.

3. **School consents (only for the claimed-target branch).** From its own dashboard
   session (JWT, `authenticate` + `requireRole('institution')` — **never** a partner
   credential): `GET /institutions/me/integrations/requests` lists pending asks
   (`institutionsIntegrations.js`, includes `payload` the platform submitted),
   `POST /institutions/me/integrations/requests/:id/accept` → `approved`
   (`schoolConfirmedAt` stamped) or `/decline` → `rejected`
   (`rejectReason: "Declined by the institution"`). Both are atomic
   `findOneAndUpdate` filters on `{_id, instId, status:'awaiting_school'}` — a
   replay or wrong-school attempt is indistinguishable 404.

4. **IDAP polls.** `GET /partner/connection-requests/:id` (platform key). Docs say
   hourly is plenty — no webhooks exist anywhere in this system.

5. **IDAP redeems.** `POST /partner/connection-requests/:id/redeem`
   (`partnerPlatform.js:420-623`) — single-use, atomic
   (`findOneAndUpdate({status:'approved', redeemedAt:null} → {redeemedAt, status:'completed'})`).
   → `200 { token: "pp_pgrant_…", instId, externalRef, scopes, partner:{id,name,slug}, institution:{name,city,slug}, warning }`.
   Token shown **exactly once**; only its hash is stored.
   `authorizedBy` is stamped on the grant at this moment: `'school'` if
   `consumed.schoolConfirmedAt` is set, else `'admin-unclaimed'`
   (`partnerPlatform.js:546`) — this provenance is later re-checked on **every**
   grant-tier request (see §7's `needs_school_consent` finding).

6. **School disconnects, any time.** `DELETE /institutions/me/integrations/:partnerSlug`
   (dashboard JWT) — scoped to `{instId, partnerId}`, never `instId` alone. Takes
   effect on the partner's very next request.

### Who initiates what

| Step | Actor |
|---|---|
| Submit | IDAP (platform key) |
| Match / draft / reject | PassPercent admin (`super_admin`) |
| Accept / decline | The institution itself, dashboard session — **only** for a claimed target |
| Redeem | IDAP (platform key) |
| Disconnect | The institution itself, any time |

**"Platform-initiated consent"** = IDAP always starts the lifecycle (there's no
school-minted code anymore); PassPercent admin gates every request through a match;
and the *institution's own login* — not the admin — is what authorizes a write
against a listing someone already owns. Admin approval is necessary but, for a
claimed school, never sufficient.

### The one genuinely novel wrinkle: `actor: "system"`

If the institution a request is `awaiting_school` against **deletes its account**
while waiting, nothing can ever move that row out of `awaiting_school` again (accept/
decline both require a school JWT that a soft-delete kills). Two routes lazily sweep
this on the caller's own next touch (`partnerPlatform.js:220-237,310-317,403`):
`GET /connection-requests/:id` and a re-submission of the same `externalRef` (which
can return `201` with a **new** `requestId` instead of the usual `409`). Verified in
code, not just asserted in the doc.

---

## 3. Data-push endpoints (grant-token tier, base path `/api/partner`)

All four resolve `req.institution` from the token — **no institution id ever appears
in the URL or body of these four routes.**

### `GET /partner/whoami` — no scope
`partner.js:107-131`. Confirms the grant works; returns `{grantId, prefix, label,
scopes, partner:{id,name,slug}, instId, externalRef, institution:{name,city,slug},
lastUsedAt, requestCount}`.
**Gotcha:** the `externalRef` in this response is `Institution.externalRef` — the
**agent-tier** join key, not IDAP's own submitted ref. IDAP's own ref lives on the
grant and is only returned by `GET /partner/institutions` (platform tier) or the
redeem response. Do not correlate off this field.

### `GET /partner/schema` — no scope, dual-auth (platform key OR grant)
`partner.js:522-641`. Self-describing contract: `fields` (array of `{name, type,
maxLength/enum/min/max, requiredForCompleteness, description}` — see full
`PROFILE_FIELDS` at `partner.js:249-292`), `enums`, `rules` (partial-patch semantics,
`type` read/write asymmetry, `neverWritable` list), `example`, and a `results` block
documenting the results endpoint. **Build the integration's field-mapping layer from
this endpoint at runtime, not from this document** — it is generated from the same
constants the routes validate against.

### `GET /partner/institution` — no scope
`partner.js:649-664`. `{institution: <partnerView>, checklist: {profileSetup,
streamsConfigured, dataEntry, toppersAdded}, missing: [...]}`. `checklist` is the
literal shared function `deriveSelfChecklist` also used by the school's own onboarding
wizard (`utils/completeness.js`) — not a parallel definition.

### `PATCH /partner/institution` — scope `profile:write`
`partner.js:672-782`. Partial patch — omit to leave untouched, send empty to clear,
**except** `name`/`city`/`board`/`type` which 400 on empty (must be omitted instead).

**Writable fields** (`ALLOWED_FIELDS`, `partner.js:217-223`):
```
name, city, board, type, streams, phone, website, about,
addressLine, area, district, taluk, state, pincode, country,
university, feesMin, feesMax, fees, facilities, branches,
admissions, classFrom, classTo, managementType, genderType,
principalName, affiliationNo, studentStrength, facultyStrength
```
Field types/enums/limits — the authoritative table is `PROFILE_FIELDS`
(`partner.js:249-292`); highlights:
- `board`: enum = `VALID_BOARDS` (imported from `utils/schoolImport.js`).
- `type`: **write-restricted to `['School','College']`** even though `GET` can
  return any of 8 values (`School (10th only)`, `Degree College`, etc. — see
  `VALID_TYPES`). Sending `type` when the stored value is one of the other 6 →
  `409 {error, current, writableValues}`. **Omit `type` on round-trip patches.**
- `streams`: enum = `SCHOOL_STREAMS + HIGHER_ED_STREAMS` (`utils/entitlements.js`)
  = `sslc, puc` / `degree, engineering, medical, management`. Clamped server-side to
  the institution's segment after save.
- `facilities`: enum = `FACILITY_KEYS` (`utils/facilities.js`); unknown keys are
  silently dropped, not rejected.
- `managementType` enum `['', 'Government', 'Private', 'Aided']`,
  `genderType` enum `['', 'Co-ed', 'Boys', 'Girls']` — `''` is a real "not specified"
  value here, not a clear-request.
- `fees`: array of `{label(req, ≤60), annual?(₹,≤1e7), oneTime?(₹,≤1e7)}`, ≤30 rows.
- `admissions`: array of `{label(req,≤80), level?(≤20), opensOn?/closesOn(req,
  YYYY-MM-DD), applyUrl?(≤300), notes?(≤300)}`, ≤20 rows.
- `branches`: free-form strings, ≤60 items, ≤40 chars each, deduped.

Response: `{updated:true, institution: <partnerView>, checklist, missing,
quotaRemaining}`.

`results` and `toppers` are **not** writable here — published only via the results
route below (`neverWritable` in schema also blocks `status, verified, plan, mrr,
assignedTo, contact, passwordHash, tokenVersion, isUnclaimed, source, agentKeyId`
structurally, at the allowlist, not by a denylist check — `partner.js:571`).

### `PUT /partner/institution/results/:year` — scope `results:write`
`partner.js:822-1023`. `year` is a **URL param** (`/^\d{4}(-\d{2,4})?$/`, e.g.
`2025` or `2025-26`) — not a body field. Body: `{ streams: { <streamKey>: {...} } }`.
**Replaces that year wholesale** — a stream key omitted from the payload but present
on file is deleted from that year; every other year is untouched.

Validation order (each a distinct error): (1) unknown stream key → `400 {error:
"Unknown stream(s)", unknown, allowed}`; (2) stream not in the institution's own
declared `streams` → `400 {error:"Stream not offered by this institution", notOffered,
offered, hint}`; (3) new-year-count vs plan cap (`inst_extendedHistory`: starter=1,
standard=10, pro=unlimited) → `403 {error, limit, current, hint}` (re-publishing an
*existing* year is never capped); (4) oversized inline base64 image (topper photo /
recruiter logo, ~200KB raw / ~280KB base64) → `400 {error}` before quota is touched.

Response: `{updated:true, year, replaced: <bool>, institution, checklist, missing,
quotaRemaining}`.

---

## 4. Idempotency, batching, limits, quotas

- **No idempotency key** on any write route. `PUT .../results/:year` is naturally
  idempotent (wholesale replace, keyed by year) — re-sending the same payload is
  safe and reported via `replaced`. `PATCH /institution` has no such guarantee
  beyond ordinary field-level idempotence.
- **No batch endpoints anywhere.** One institution per request, confirmed both by
  design doc (out-of-scope, `2026-08-25-idap-integration-design.md:129`) and by
  code — every grant is bound to exactly one `instId`.
- **Payload caps:** inline base64 images >~200KB raw are refused (see above); text
  fields have per-field maxlengths (§3); arrays are capped (`facilities`≤60,
  `branches`≤60, `fees`≤30, `admissions`≤20).
- **Rate limiting:** see §1.
- **Quota — two tiers, checked in order, confirmed by reading `consumePartnerWriteQuota`
  (`partnerAuth.js:552-657`) directly:**
  1. Grant's own `dailyWriteCap` (default 500/day, `PartnerGrant.js:203`) — atomic
     `findOneAndUpdate` with UTC-day rollover, no cron.
  2. Partner's aggregate `dailyWriteCap` (default 5000/day, `Partner.js:74`) across
     **every** grant that partner holds — checked *after* the grant already passed,
     so one partner's runaway grant can't exhaust its own tighter cap before also
     dragging others down; if the platform check fails, **the grant's counter is
     refunded** so a refused write costs nothing.
  Two distinct `429` bodies (`{error:"Daily write cap reached", dailyWriteCap,
  quotaRemaining}` vs `{error:"Platform daily write cap reached",
  platformDailyWriteCap, quotaRemaining:0}`).

### "A dishonest quota" — now fixed, and the doc has NOT caught up (see §7)

Commit `ae412fe` (the newest at HEAD) fixed exactly this: `GET /partner/institutions`
used to report only the **grant's** headroom, so a partner sitting at its platform
aggregate cap saw a comfortable `quotaRemainingToday: 500` on every mapping whose
very next write would 429. As of `ae412fe`, the field is
`Math.min(grantRemaining, platformRemaining)` and a new field `platformRemainingToday`
is published alongside it (`partnerPlatform.js:701-734`). **`docs/PARTNER_INTEGRATION_SPEC.md`
was written one commit earlier and still shows the pre-fix response shape — see §7.**

A second, related fix in the same commit: `writable` (whether the *listing*, not
just the grant, can absorb a write) was already correct before `ae412fe`; that commit
only touched the quota-number honesty, not `writable` itself.

---

## 5. Data model IDAP must map onto

PassPercent's results model is a `Map<streamKey, StreamData>` per year
(`models/Institution.js:136-185`), with three independent outcome axes a stream can
carry simultaneously — board pass %, placement, and entrance-exam selections — plus
optional branch-level and gender-level breakdowns:

- **Stream keys** (closed enum, must also be in the institution's own `streams`
  field first): `sslc, puc, degree, engineering, medical, management`.
- **Board/school outcome** (`StreamDataSchema`, `Institution.js:136-173`):
  `passPct` (required unless `placement` is present), `appeared`, `passed`,
  `grades` (`{'90+','80-90','70-80','60-70','50-60','below50'}` counts),
  `subjects` (map of `{passPct, appeared}`), `boys`/`girls` (`{appeared, passed}`).
- **Toppers** (`TopperSchema`, `Institution.js:5-15`): `rank`(req), `name`(req),
  `pct`(req), optional `marks, total, subject, stateRank, airRank, photo`.
- **Combinations** (branch/course-level breakdown, `CombinationDataSchema`,
  `Institution.js:73-102`) — keyed by combination code (e.g. `PCMB`, `CSE`):
  `passPct, appeared, passed, distinction, firstClass, highestScore, avgScore,
  grades, boys, girls, toppers[]`, plus branch-wise placement
  (`eligible, placed, placementPct, highestPackage, avgPackage, medianPackage,
  lowestPackage, recruiters[string] (legacy), companies[RecruiterSchema]`),
  `accreditation`.
- **Stream-level placement** (`StreamPlacementSchema`, `Institution.js:107-134`) —
  for engineering/medical/management/degree: `eligible, placed, placementPct,
  companiesVisited, industryTieUps, highestPackage, avgPackage, medianPackage,
  lowestPackage, recruiters[RecruiterSchema], partnerships[], internshipPartners[],
  researchCollaborations[], innovationLabs[], incubationCenters[]`, and
  `higherEd: {iitIiscNit, foreignUniversities, masters, entrepreneurship}`.
- **Recruiter** (`RecruiterSchema`, `Institution.js:49-66`): `name`(req), `logo`,
  `category` (`it|product|core|consulting|startup|other`), `selected`, `avgPackage`,
  `tieUp`(bool), `roles[]`.
- **Entrance-exam selections** (`ExamSelectionSchema`, `Institution.js:28-36`) — a
  **third axis distinct from board pass % and placement**, keyed by exam code
  (`neet, jeeMain, jeeAdvanced, kcet, comedk` — codes live in frontend
  `src/data/exams.js`, not enforced server-side as an enum on this schema):
  `appeared, qualified, bestRank, toppers[ExamTopperSchema]` where
  `ExamTopperSchema = {name(req), rank(req), score?, photo?}` (rank-centric, unlike
  board toppers which are pct-centric).

**What `GET /partner/schema`'s worked example actually documents** (i.e. what IDAP
should treat as its primary target shape, since this is the self-describing,
route-validated version — `partner.js:630-638`):
```json
{
  "streams": {
    "sslc": { "passPct": 96.4, "appeared": 210, "passed": 202,
              "toppers": [{ "rank": 1, "name": "A. Rao", "pct": 99.2 }] },
    "engineering": { "placement": { "eligible": 480, "placed": 456,
              "highestPackage": 52, "avgPackage": 8.4,
              "recruiters": [{ "name": "Infosys", "selected": 40, "tieUp": true }] } }
  }
}
```
The schema route's own comment (`partner.js:618-624`) is explicit that this is
**representative, not exhaustive** — combinations/selections/grades/boys-girls exist
and are accepted but not itemized in the worked example. IDAP should treat
`GET /partner/schema`'s `allowedStreams` + the model fields above as the authority,
not just the example payload.

**"Topper lists"** = yes, `toppers[]` per stream (and per combination). **"Placement
data"** = yes, both stream-level and branch-level. **"Entrance-exam selections"** =
yes, a genuinely separate `selections` map. **"Combinations/streams"** = yes,
`combinations` map keyed by branch/course code nested inside a stream. All of this
round-trips through the single `PUT /partner/institution/results/:year` call — there
is no separate endpoint per data type.

---

## 6. Versioning and stability

- **Partner contract is explicitly, independently versioned**: `PARTNER_CONTRACT_VERSION
  = '2.0.0'` (`backend/src/utils/partnerContractVersion.js`) — deliberately **not**
  the internal API's `swagger.js` version (which is `1.0.0` and versions PassPercent's
  whole private surface for unrelated reasons). Three artifacts are supposed to carry
  this same number: `GET /partner/contract`, `GET /partner/openapi.json`'s
  `info.version`, and the spec doc's masthead — and per the util's own comment, two
  of these were *previously found disagreeing* (openapi.json shipped the internal
  1.0.0 by mistake) — fixed in commit `3814b60`.
- **OpenAPI spec is hand-written, not route-generated** — confirmed:
  `backend/src/docs/swagger.js` is a single ~2900-line hand-authored object literal;
  `swagger-jsdoc` is invoked with `apis: []` (no JSDoc scanning) both in `server.js`
  and in `validate-openapi-spec.js`. **It can drift from the routes** — nothing
  mechanically ties a route handler to its swagger entry except a same-PR discipline
  and the verify script's live-server checks. `validate-openapi-spec.js`
  (`backend/src/scripts/validate-openapi-spec.js`) only checks the definition is
  **structurally valid OpenAPI 3.0** (via `@apidevtools/swagger-parser`) — it does
  **not** check the spec matches route behavior. That semantic check is done instead
  by `backend/src/scripts/verify-partner.js`, which hits a live dev server and
  compares real responses against both the swagger doc and `docs/PARTNER_INTEGRATION_SPEC.md`
  (per its own header, 373 assertions as of `ae412fe`).
- **`GET /api/partner/openapi.json`** (`routes/partner.js:1025-1210`) is a
  **filtered, auto-derived** view of the same hand-written `swagger.js` — it takes
  every path/schema tagged `'Partner'`, does a transitive `$ref` closure, and rebuilds
  a standalone doc. So this one artifact *is* mechanically tied to the internal spec
  (can't drift from it independently) but the internal spec itself can still drift
  from the routes. Public, unauthenticated, served in **every** environment
  (unlike `/api/docs`, which is dev-only per `if (!isProd)` in `server.js`).
- **No deprecation-notice mechanism observed** beyond the changelog table in
  `docs/PARTNER_INTEGRATION_SPEC.md` §9 and the retired-endpoints section there
  (`POST /partner/link` now `404`s explicitly rather than 410 or a deprecation
  header).
- **v1 → v2.0.0 migration notes** (spec §9, verified against code): the four
  grant-tier routes kept their v1 request/response shapes, but gained: `/schema`
  now accepts a platform key too; both write routes gained a second `429` shape
  (platform cap); every grant-tier route can now return
  `403 {reason:"needs_school_consent"}`.

---

## 7. Where documentation and code disagree — the code wins

### 7.1 `docs/PARTNER_INTEGRATION_SPEC.md` is one commit stale on `GET /partner/institutions`

The spec (§4, "GET /partner/institutions") documents this response shape, still
present on disk at the time of writing:
```json
{ "...", "quotaRemainingToday": 487 }
```
with prose saying to "budget a sync run" from that number. **This is the exact
"lying quota" the newest commit (`ae412fe`) fixed.** As of that commit, the route
(`backend/src/routes/partnerPlatform.js:701-734`) returns:
```json
{ "...", "quotaRemainingToday": <min(grantRemaining, platformRemaining)>,
  "platformRemainingToday": <platformRemaining> }
```
The doc was written in commit `806f6d1` ("docs: follow the 627a9ae/3814b60 code
waves into the integration kit"), **before** `ae412fe` landed two commits later —
so the doc's own commit sequence explains the gap, but it is currently stale: it
neither shows the new `platformRemainingToday` field nor explains that
`quotaRemainingToday` is now the *lower* of two ceilings. An IDAP implementer
reading the spec today would build a sync-pacing loop against a field whose real
semantics changed after the doc was last touched. **Trust the code
(`partnerPlatform.js:701-734`), not the current text of the spec, for this one field.**
No other part of the spec was found to disagree with the two commits that postdate
its writing (`2cda6ef` only reworded the *live* `/contract` endpoint's prose, which
the markdown spec never quoted verbatim, so no drift there).

### 7.2 The prior brief's premise about "connect codes" is now obsolete, confirmed twice over

The earlier finding that `POST /connection-requests` + poll + redeem replaced
connect codes is **fully confirmed** by current code: `PartnerConnectCode` the model
is gone, `POST /partner/link` is gone (its route doesn't exist in `partner.js`
anymore — confirmed by reading the whole file), and `GET /institutions/me/integrations/partners`
+ `POST /institutions/me/integrations/connect-code` are both absent from
`institutionsIntegrations.js`. Any lingering reference to those three endpoints
anywhere (older design docs under `docs/superpowers/specs/2026-08-25-idap-integration-design.md`
still describe the **pre-generalization, IDAP-only, connect-code** flow in its
"Flow" section — see that file's own line 78-92 vs. its "Revision note" at the top
admitting it was superseded) is historical, not current. **Use
`docs/PARTNER_INTEGRATION_SPEC.md` and the route files, never
`2026-08-25-idap-integration-design.md`'s flow diagram, which was superseded by
`2026-08-26-platform-integration-design.md` before this repo's HEAD.**

### 7.3 Internal-identifier leaks in `GET /partner/contract` — fixed, but illustrates the doc-drift risk class

Commit `2cda6ef` found and fixed `GET /partner/contract`'s **live JSON response**
citing a deleted internal identifier (`linkLimiter`) and several `.js` file paths
that an external integrator could never resolve. Fixed generically (a wire-body
scan now guards against any `.js`/`routes/` string in that response,
`verify-partner.js`'s new assertion). This wasn't a markdown-doc/code disagreement —
it was a code-serving-code-internals bug — but it's the same class of drift this
task was warned about, and it was caught only two commits before HEAD, so it's
worth knowing this contract's self-description had a live factual error until
very recently.

### 7.4 No disagreement found in the endpoint list itself

Every endpoint named in `docs/PARTNER_INTEGRATION_SPEC.md` §4 was cross-checked
against the actual route files (`partner.js`, `partnerPlatform.js`,
`institutionsIntegrations.js`) and matches on method, path, auth, and (aside from
§7.1 above) response shape. The error-contract tables in spec §5 were spot-checked
against the actual `res.status(...).json(...)` call sites cited and matched.

---

## 8. File index (for anything not covered above)

| File | What it is |
|---|---|
| `backend/src/routes/partnerPlatform.js` | Platform-key tier: submit/list/poll/redeem connection requests, `GET /institutions` (mappings), `GET /contract` |
| `backend/src/routes/partner.js` | Grant-token tier: whoami/schema/institution/PATCH/results, plus the public filtered `GET /openapi.json` |
| `backend/src/routes/institutionsIntegrations.js` | School dashboard side: list connections, disconnect, list/accept/decline pending requests |
| `backend/src/routes/admin.js` (~2290-3000) | Admin registry (`/admin/partners*`) and approval queue (`/admin/partner-requests*`) |
| `backend/src/middleware/platformAuth.js` | `requirePlatformKey()`, `requirePlatformOrGrant()` |
| `backend/src/middleware/partnerAuth.js` | `requireGrant()`, `consumePartnerWriteQuota()` — read this file's inline comments in full; they document several previously-fixed security findings (`needs_school_consent`, the deleted-account hole, the isUnclaimed flip-back race) that materially affect how a partner must handle refusals |
| `backend/src/models/Partner.js` | Platform identity (credential-less) |
| `backend/src/models/PartnerKey.js` | Platform credential |
| `backend/src/models/PartnerConnectionRequest.js` | Lifecycle row |
| `backend/src/models/PartnerGrant.js` | Per-institution credential |
| `backend/src/models/Institution.js:1-186` | Results/streams/toppers/placement/selections schema |
| `backend/src/utils/partnerContractVersion.js` | Single source of the `2.0.0` version string |
| `docs/PARTNER_INTEGRATION_SPEC.md` | The document to hand IDAP's engineers — accurate except §7.1 above |
| `backend/src/docs/swagger.js` (~1548-1720, ~2210-2280+) | Admin + Partner tagged OpenAPI sections; hand-written |
| `backend/src/scripts/verify-partner.js` | Live-server conformance suite (373 assertions as of HEAD) — the actual ground truth for "does the spec match behavior" |
