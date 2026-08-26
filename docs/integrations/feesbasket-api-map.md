# EduConnect / FeesBasket — Inbound Partner Integration API Map

Read-only reconnaissance for IDAP integration design. Repo: `/Users/automicai/Projects/educonnect`.
All citations are `file:line` against that repo as of commit `96a357d` (`fix(api): document the offers endpoints; test spec coverage against the routes`).

---

## 1. Authentication

Two entirely separate credential types, both Bearer tokens with the same physical shape (`prefix_secret`, SHA-256-hashed at rest, shown once), but they answer different questions:

| Credential | Format | Proves | Issued by | Stored as |
|---|---|---|---|---|
| **Partner API key** | `fbk_live_<8-hex-prefix>_<64-hex-secret>` | "this caller is platform X" | FeesBasket admin, `/admin/partners` | `PartnerKey` |
| **Connection key** | `fbc_live_<8-hex-prefix>_<64-hex-secret>` | "institution Y authorizes platform X" | The institution itself, self-serve at `/portal/integrations` | `ConnectionKey` (single-use) |

Both are presented identically: `Authorization: Bearer <token>`. There is no separate header name or scheme; `bearerAuth` security scheme in the spec (`src/lib/openapi.ts:33-38`). Session-cookie auth (`cookieAuth`, cookie name `ec_access` — `src/lib/auth.ts:18`) is a **third, unrelated** mechanism used only by browser/student/institution-admin endpoints (`/auth/*`, `/offers`, `/offers/{id}/claim`, portal pages) — it is never valid for partner endpoints and vice versa.

**Yes — this is exactly the two-layer model you're expecting**, and the codebase itself calls them "contract 1" and "contract 2":

- **Contract 1 (platform-level):** `Partner` + `PartnerKey`. Established once, admin-side, no institution involved. Proves the caller's platform identity and its overall status (`active`/`suspended`) and its `canProposeInstitutions` flag. By itself **grants access to zero institutions**.
- **Contract 2 (per-institution grant):** `PartnerGrant`, keyed `@@unique([partnerId, institutionId])` and `@@unique([partnerId, externalRef])` (`prisma/schema.prisma:1065-1079`). Created either by redeeming a `ConnectionKey` (`createdVia: "connection"`) or, rarely, by an admin hand-grant override (`createdVia: "admin"`). Carries CSV `scopes` (`catalog,fees,outcomes,media`). Without a live (non-revoked) grant, every data-push/read call for that `externalId` 404s — contract 1 alone never lets you touch data.

Auth flow, read from the actual middleware (`src/lib/partner-auth.ts:50-80`, `requirePartner`):
1. Parse `Authorization: Bearer fbk_live_<prefix>_<secret>` (`src/lib/partner-token.ts:36-43`). Any other shape → `401 unauthorized`.
2. Look up `PartnerKey` by `prefix`; verify `secretMatchesHash` via constant-time compare (`src/lib/partner-token.ts:50-56`).
3. **Unknown key, revoked key, and wrong secret all return the identical `401 unauthorized "Invalid or revoked API key."`** (`src/lib/partner-auth.ts:57-61`) — a caller can never probe which keys exist.
4. Look up `Partner`; if `status !== "active"` → `403 forbidden "This partner account is suspended."` (`:65-67`). Suspending a partner cuts off **every** institution it holds at once.
5. Load all live (`revokedAt` null-or-unset) `PartnerGrant`s for this partner into `ctx.grants`.
6. Fire-and-forget update of `PartnerKey.lastUsedAt`.

Gotcha worth flagging to IDAP's engineers: **Prisma+MongoDB `{ revokedAt: null }` matches only an explicit null, not an absent field.** Every "is this row live" filter in this codebase uses `NOT_REVOKED = { OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }] }` (`src/lib/partner-auth.ts:43`). Not IDAP's problem directly, but explains why grant/key state checks in the codebase look unusually defensive — nothing for IDAP to replicate, just context.

---

## 2. The connection/consent lifecycle

**Corrected history:** an early version of this feature had the admin console redeeming connection keys or otherwise sitting in the loop for contract 2; commit `9e64d68 fix(partner): correct the guide — contract 2 is the institution's, not admin's` fixed the *documentation* to match code that was already institution-only (`src/app/portal/integrations/actions.ts:16-19`: *"Contract 2 is deliberately institution-only: the platform admin has no action anywhere in this file."*). **Current truth, unambiguous in both code and docs:** a FeesBasket admin is never involved in connecting a specific institution to a specific partner. Admin involvement is limited to (a) onboarding the partner platform itself (contract 1) and (b) an explicitly-labeled *override* hand-grant for edge cases (migration, support, demo) — see `src/lib/partner-guide.ts:169-174` and `caadc83 fix(admin): label the hand-grant form as an override, show how each grant arose`.

### Sequence (institution-initiated, the normal path)

1. **Institution side, in `/portal/integrations`** (session-cookie auth, `manageOwnInstitution` capability): the institution admin picks a connectable partner (`connectablePartners()` — only `status: "active"` partners, `src/lib/connections-db.ts:25-31`) and which scopes to authorize (`catalog`/`fees`/`outcomes`/`media` checkboxes), then calls server action `issueConnectionKeyAction` (`src/app/portal/integrations/actions.ts:34-57`).
   - This calls `issueConnectionKey()` (`src/lib/connections-db.ts:60-88`), which mints a `fbc_live_...` key, valid **24 hours** (`CONNECTION_KEY_TTL_HOURS = 24`, `src/lib/connection-key.ts:17`), single-use, shown to the institution **exactly once** — never persisted in plaintext.
   - The institution pastes this key into IDAP's own "connect to FeesBasket" UI.
2. **IDAP calls `POST /api/v1/partner/connections`** (Bearer contract-1 key) with `{ connectionKey, externalId }` where `externalId` is **IDAP's own identifier** for that institution (`src/app/api/v1/partner/connections/route.ts:10-15`, `55-97`).
   - Server redeems it via `redeemConnectionKey()` (`src/lib/connections-db.ts:118-182`): validates the key format, binds it to the calling partner (wrong-partner and unknown collapse to the same client-visible failure — `redeemDecision`, `src/lib/connection-key.ts:70-81`), checks not revoked/redeemed/expired, checks `(partnerId, externalId)` isn't already claimed by a *different* institution, then atomically claims the key (`updateMany` conditional write, prevents double-redeem races — `:144-150`) and upserts the `PartnerGrant` with `createdVia: "connection"`.
   - Response `201`: `{ data: { externalId, institution: { name, customerId, slug }, scopes, connectedAt } }`. From this point IDAP addresses this institution by `externalId` on every other endpoint — it never sees or needs a FeesBasket-internal id.
3. **IDAP calls `GET /api/v1/partner/me`** any time to confirm the key is live and list every granted institution + its scopes + the live enum vocabularies (`src/app/api/v1/partner/me/route.ts`).
4. **IDAP calls `GET /api/v1/partner/institutions/{externalId}`** to read current state before composing a diff — necessary because pushes are partial merges, so IDAP's own send history alone doesn't reveal current state (someone may have edited via the portal).
5. **IDAP calls `POST /api/v1/partner/institutions/{externalId}`** — the actual push (Section 3).
6. If step 5 returns `202` (new-institution proposal, see below), **IDAP polls `GET /api/v1/partner/events/{eventId}`** for the human-review decision.

### Alternate path: proposing a brand-new institution
If IDAP pushes to an `externalId` with no grant, and its `Partner.canProposeInstitutions` flag is on (admin-set), the push is queued as a `pending_approval` `IngestionEvent` instead of `404`ing (`src/app/api/v1/partner/institutions/[externalId]/route.ts:353-441`). A human reviewer approves/rejects (`src/lib/partners.ts:212-424`, `426-466`); approval creates the `Institution` (`status: "pending_review", active: false` — **not verified, not yet in discovery**) and the `PartnerGrant` together, replaying every accumulated pending push in order. This is the **one** case where the grant is admin-created rather than institution-authorized, because no institution account existed yet to authorize anything (`src/lib/partner-guide.ts:111`). Without the flag, an institution must connect itself first — "there is no other way in."

### Disconnection
The institution can revoke a live grant unilaterally, any time, from `/portal/integrations` (`revokeConnectionAction` → `revokeConnection()`, `src/lib/connections-db.ts:100-106`) or withdraw an unredeemed key it generated (`revokeConnectionKeyAction` → `revokeConnectionKey()`, `:91-97`). Revocation only sets `revokedAt`; rows are never deleted, so re-granting is an upsert, not a fresh create.

---

## 3. The data-push endpoints

There is **one** push endpoint. It is not split per data type — profile, programs, fees, placements, results, scholarships and media all go through the same call as sections of one JSON body (partial merge). **Offers are not part of this API at all** — see the callout at the end of this section.

### `POST /api/v1/partner/institutions/{externalId}`
`src/app/api/v1/partner/institutions/[externalId]/route.ts:121-578`

- **Auth:** Bearer contract-1 key + a live `PartnerGrant` for `externalId`.
- **Required header:** `Idempotency-Key` (any non-empty string) — **hard 422 without it**, not optional.
- **Path param:** `externalId` — IDAP's own identifier, as established in `POST /partner/connections` (or a brand-new one, only if `canProposeInstitutions`).
- **Body:** `IngestionPayload` — see field-by-field breakdown in Section 4.
- **Ordering guarantee that matters for retries:** rate-limit check → idempotency-key presence check → JSON parse → payload hash → idempotency lookup (replay/conflict/fresh) → schema validation → grant resolution → scope check → apply.
- **Responses:**
  - `200 { data: IngestionResult }` — applied. `IngestionResult` = `{ eventId, status: "applied", applied: AppliedCounts, warnings: IngestionIssue[], institution: { customerId, slug, externalId } }`. On replay, adds `replayed: true`.
  - `202 { data: IngestionResult }` — queued as a creation proposal (no grant existed, `canProposeInstitutions` true). `{ eventId, status: "pending_approval", message }`.
  - `401` — bad/missing/revoked key.
  - `403 forbidden` — partner suspended, **or** grant's scopes don't cover part of the payload (`error.code` distinguishes the two only by message text, both are 403).
  - `404 not_found` — no grant for this `externalId` and partner cannot propose.
  - `409 conflict` — `Idempotency-Key` reused with a different payload or a different `externalId`.
  - `422 validation_error` — five distinct sub-cases, distinguished by `error.details` shape (missing header → no details; schema-invalid → `{ paths, issues }`; incomplete proposal → `{ errors }` only, no `warnings`; failed plan → `{ errors, warnings }`; replay of an earlier 422 → same shape + `eventId`, `replayed: true`). Full breakdown at `src/lib/openapi.ts:730-734`.
  - `429 rate_limited` — `Retry-After` header present, seconds.

### `GET /api/v1/partner/institutions/{externalId}`
`src/app/api/v1/partner/institutions/[externalId]/route.ts:585-661` — read-back for reconciliation (partial-merge means IDAP cannot infer current state from its own push history alone). Returns full nested state: institution profile fields, programs (with fees/components, placements), results, scholarships, media. **Every `externalId` in the response is scoped to the calling partner** — a row written by another partner or by the institution directly in the portal comes back with `externalId: null` (still counted in `totalAnnualCost`, just not addressable by this partner for updates). No scope check on this read (`:598-604` — a "fees"-only grant can still read program names).

### `GET /api/v1/partner/events/{eventId}`
`src/app/api/v1/partner/events/[id]/route.ts` — poll after a `202`. Returns `{ eventId, targetRef, status, createdAt, reviewedAt, reviewNote, result }`. `status` ∈ `applied | pending_approval | rejected | failed`. A `failed` event's real error text is **redacted** to a generic message unless it's specifically a stored rate-limit code — raw Prisma error internals are never exposed cross-process (`:14-23`).

### `GET /api/v1/partner/me`
`src/app/api/v1/partner/me/route.ts` — identity check + live vocabularies (`institutionTypes`, `feeTypes`, `feeFrequencies`, `mediaKinds`) + per-institution scopes. **Use this to build IDAP's mapping table** — the guide explicitly says "Read these rather than hard-coding them: an unmapped value is a hard 422."

### `POST /api/v1/partner/connections`
Covered in Section 2.

### Offers — NOT reachable via the partner API
`POST /api/v1/offers` (`src/app/api/v1/offers/route.ts:25-54`) and `POST /api/v1/offers/{id}/claim` (`src/app/api/v1/offers/[id]/claim/route.ts`) both call `requireCapability("manageOwnInstitution")` / `requireCapability("applyOrLead")` — **session-cookie auth only** (`src/lib/api.ts:26-39`), never `requirePartner`. They are tagged `"offers"` in the spec, not `"partner"`, and `IngestionPayloadSchema` (`src/lib/ingestion-schema.ts:152-161`) has no `offers` field. **IDAP cannot push scholarship-style "offers"/discount codes through the Bearer-token ingestion API at all** — only an institution admin logged into the FeesBasket UI (or a session-authenticated first-party integration) can create them. This is despite the commit message "document the offers endpoints" sounding partner-related — that commit only added the *already-existing, cookie-authed* offers endpoints to `openapi.json` (they were previously undocumented) and added the coverage test. If IDAP needs to surface admission "offers," the closest partner-writable analog is the `scholarships` ingestion section (free-form `criteria`/`amount` strings, not couponed discounts).

---

## 4. Data model expectations — exact field names and enums

### Fee components (`FeeComponent` / `IngestionFeeComponentInput`)
`src/lib/enums.ts:58-90`, schema at `src/lib/ingestion-schema.ts:68-75`:
```
{ externalId: string(1-120), type: FeeType, amount: number>=0, frequency: FeeFrequency }
```
- `type` enum (`FEE_TYPES`): `tuition | admission | semester | books | uniform | lab | exam | transport | hostel | mess | activity | other`
- `frequency` enum (`FEE_FREQUENCIES`): `annual | semester | one_time`
- **All three of type/amount/frequency are required** — no optional fee-component fields, no free-text fee names beyond the fixed `type` enum (map anything custom to `other`).

**Total Annual Cost computation** — `src/lib/fees.ts:16-28`, `computeTotalAnnualCost`:
```js
annual   -> amount
semester -> amount * 2      // i.e. assumes exactly 2 semesters/year
one_time -> amount          // included in first-year total, not amortized
```
Recomputed **server-side, write-through** after every merge (`totalAnnualCost` persisted on `FeeStructure`, rule 4 in `src/lib/ingestion.ts:14`) — IDAP never sends a total; it's always derived from the live component set (including components written by other parties on the same institution).

### Programs (`Program` / `IngestionProgramInput`)
`src/lib/ingestion-schema.ts:95-107`:
```
{ externalId(req), name?, level?: InstitutionType, board?, branchOrCombination?,
  durationMonths?, seats?, fees?: {academicYear, components[]}, placements?[] }
```
**Important mapping trap:** `level` is validated against `INSTITUTION_TYPES` — the **same 20-value enum used for the institution's own `type`** (`preschool | school | puc | degree | engineering | medical | mba | nursing | education | commerce | arts | science | law | pharmacy | architecture | mca | bca | bsw | bhm | other`). This is **not** a UG/PG/Diploma-style level — IDAP must map its own program-level taxonomy onto this institution-type vocabulary (confirmed identical in both `src/lib/enums.ts:9-30` and the OpenAPI `IngestionProgramInput.level` enum at `src/lib/openapi.ts:182`, so no spec/code drift here, just an unusual modeling choice worth flagging).
`name` and `level` are **required only when creating** (no existing row resolves for that `externalId`) — omit-safe on updates (`src/lib/ingestion.ts:239-254`).

### Placements (nested under a program)
`{ externalId, year(1900-2100), highest?: int>=0|null, average?: int>=0|null, pct?: int(0-100)|null, topRecruiters?: string[]≤50|null }`.

### Results (`Result`)
`{ externalId, year: int(1900-2100), metric: string(1-120), value: string(1-120) }` — **`value` is a free-text string**, not numeric — e.g. metric `"Pass %"`, value `"98"` or `"98%"`, entirely IDAP's convention.

### Scholarships (`Scholarship`)
`{ externalId, name: string(1-200), criteria?: string(≤2000)|null, amount?: string(≤120)|null }` — `amount` is **free-form text** (`"Up to ₹50,000"`, `"100% tuition"`), not a number/currency type. There is also a `visibility` field on the DB model (`public | coupon_unlock | premium`) but it is **not writable via ingestion** — defaults to `"public"` and isn't in `IngestionScholarshipInput`.

### Media
`{ externalId, kind: MediaKind, url: httpsOrHttp-uri, caption?: string(≤240)|null }`. `MEDIA_KINDS` = `image | brochure | video | prospectus` (`src/lib/enums.ts:270-271`). IDAP pushes a **URL only** — no file upload/binary transfer in this API; the platform does not fetch/store bytes on IDAP's behalf as part of ingestion (the `Media.bytes` DB field exists for portal-uploaded files' storage-quota accounting, unrelated to partner-pushed media).

### Institution profile patch
Full optional field list at `src/lib/openapi.ts:238-266` / `src/lib/ingestion-schema.ts:39-66`: `name, type(InstitutionType), city, state, tagline, description, boardAffiliation, establishedYear, addressLine1/2, taluk, district, pinCode(regex \d{6}), country, lat, lng, contactPerson, contactEmail, contactPhone, altPhone, website, logoUrl, coverImageUrl`. **Explicitly excluded/non-writable** (confirmed by `.strict()` rejecting them as 422, and called out by name in the design doc, `docs/superpowers/specs/2026-08-25-partner-ingestion-api-design.md:330-336`): `status`, `plan`, `featured`, `sponsored`, `creditBalance`, `ratingAvg`, and all billing/subscription fields (`planStartedAt`, `planRenewsAt`, `planPricePaid`, `planPeriod`, `isTrial`, `trialUsed`). A partner cannot alter an institution's plan tier or verification/discovery status through this API — a proposed institution always lands `pending_review`/`active:false` regardless of payload content.

### Merge semantics (apply to every array-typed section)
From `src/lib/ingestion.ts:9-14` and the guide (`src/lib/partner-guide.ts:76-93`):
1. Absent field/section = untouched. Explicit `null` = clear (nullable fields only).
2. Array items matched by **your own `externalId`**, scoped per-partner (`(sourcePartnerId, externalId)` — not DB-unique-enforced due to Mongo null-index behavior, but logic-enforced as unique).
3. Deletion is only ever explicit via the top-level `deletes: { programs[], feeComponents[], placements[], results[], scholarships[], media[] }` block (each ≤500 ids, defaults to `[]`).
4. A row created by someone else (another partner, or the portal) is returned with `externalId: null` and is invisible/untouchable to your merges, but **still counted** in `totalAnnualCost`.
5. Every request body is whole-payload atomic — `hasErrors` on the plan means **nothing** in the request applies (`applyPlan` asserts this, `src/lib/ingestion-db.ts:110-112`), applied inside one MongoDB transaction (55s timeout, `src/lib/ingestion-db.ts:95`).

### Scopes gate sections, not fields
`SECTION_SCOPES` (`src/lib/ingestion.ts:425-433`):
| Scope | Payload sections |
|---|---|
| `catalog` | `profile`, `programs` |
| `fees` | `fees` (nested in programs), `deletes.feeComponents` |
| `outcomes` | `placements`, `results`, `scholarships` |
| `media` | `media` |

A grant with only `fees` scope can push fee components without any `catalog` grant (a fees-only integration is fully supported).

---

## 5. Idempotency, batching, limits, quotas

- **Idempotency:** `Idempotency-Key` header is **mandatory** on the push endpoint (missing → 422, itself journalled). Same key + same canonical payload hash + same `externalId` → replay of the stored terminal response verbatim, including original HTTP status (`src/lib/ingestion.ts:766-802`). Same key + different payload or different `externalId` → `409`. A prior `failed` status is re-runnable under the same key (not treated as a terminal replay). Payload hash is a canonical (sorted-keys, array-order-preserved) SHA-256 of the zod-normalized body (`canonicalPayloadHash`, `src/lib/ingestion.ts:741-753`).
- **Batching:** No multi-institution batch endpoint — one `externalId` per call. But **within** one institution, one call batches heavily: up to 200 programs (each up to 60 fee components + 50 placements), 200 results, 100 scholarships, 200 media items, plus up to 500 ids per `deletes.*` list (`src/lib/ingestion-schema.ts` maxItems throughout). A full initial sync can be one large POST.
- **Rate limit:** Fixed trailing 60-second window, **per API-key-prefix**, default **60 requests/minute**, overridable per-deployment via a `PlatformSetting` row (`partner.rateLimit.perMinute`) with no plan-tier differentiation (`src/lib/ingestion-db.ts:398-420`, `rateLimitDecision` `src/lib/ingestion.ts:834-844`). Exceeding it returns `429` with a `Retry-After: 60` header; the rejected request itself is journalled under a synthesized, non-colliding key so it never poisons the caller's real `Idempotency-Key`.
- **Plan tiers (Free/Standard/Pro) do NOT gate the partner API at all.** `PLANS`/`PLAN_META` (`src/lib/enums.ts:166-195`) govern the institution's own portal features (featured listing, sponsored placement, lead bundles) — there is no code path connecting `Institution.plan` to ingestion rate limits, payload size caps, or media caps. The only quota mechanism found is the single global (or per-deployment-overridden) requests/minute limiter above, keyed on the partner's API key, not on the target institution's subscription plan.
- **No storage/media byte quota applies to partner-pushed media** — ingestion media items are URLs (see Section 4); no file bytes traverse this API.

---

## 6. Spec trustworthiness

`src/app/api/v1/openapi.json/route.ts` simply serves the hand-authored `spec` object exported from `src/lib/openapi.ts` (744 lines) — **not generated** from route handlers, decorators, or zod schemas via any build step. It's manually kept in sync by whoever edits a route.

**`tests/openapi-coverage.test.ts` (added in the commit you named) proves only one direction:**
> *every implemented route+method is documented in the spec* — it walks `src/app/api/v1/**/route.ts`, extracts exported HTTP method names via regex, converts the file path to an OpenAPI-style path template, and asserts a matching `spec.paths` entry exists with that method present (`tests/openapi-coverage.test.ts:47-63`). Path-parameter *names* are normalized away before comparison (`shape()`, `:33-35`) — only the URL shape and the presence of each method is checked. A second test (`:66-80`) checks internal consistency: every `{placeholder}` in a documented path has a matching declared path parameter.

**What it does NOT check** (confirmed by reading the test body, not inferred):
- It does **not** check the reverse — a path documented in `openapi.json` with no corresponding route file would pass silently (dead/aspirational documentation could exist undetected, though I found none in this snapshot).
- It does **not** validate request-body or response-body schemas against the actual code (e.g., it can't tell you the `IngestionPayload` schema in `openapi.ts` still matches `ingestionPayloadSchema` in `ingestion-schema.ts` — those are two independently hand-maintained representations of the same contract, verified only by human diligence, not a test). In this snapshot they line up field-for-field on inspection (I checked `FeeComponent`/`IngestionFeeComponentInput`, `IngestionProgramInput.level`, and the offers section), but nothing structural prevents future drift there.
- It does not check descriptions, examples, or security requirements for accuracy — only path+method existence.

**Practical implication for IDAP:** trust the spec's **endpoint inventory** (paths/methods) as accurate — the coverage test would fail CI on any add/remove drift there. Do **not** blindly trust the spec's **body schemas** as machine-verified — cross-check field names/enums against the actual zod schemas in `src/lib/ingestion-schema.ts` (which is what this document already did). No drift was found between spec and code in this audit, but the guarantee is narrower than "the spec matches the routes" might suggest — it's "the spec's endpoint list matches the routes' endpoint list."

---

## Key source files (all read in full during this audit)

- `src/lib/openapi.ts` — hand-authored spec, 744 lines
- `src/app/api/v1/openapi.json/route.ts` — spec-serving route (`?download=1` variant)
- `tests/openapi-coverage.test.ts`, `tests/openapi-download.test.ts`
- `src/lib/partner-auth.ts` — `requirePartner`, `NOT_REVOKED`, `resolveGrant`, `grantScopes`
- `src/lib/partner-token.ts` — `fbk_live_...` format/hashing
- `src/lib/connection-key.ts` — `fbc_live_...` format, `redeemDecision`, `sanitizeScopes`
- `src/lib/connections-db.ts` — `issueConnectionKey`, `redeemConnectionKey`, `revokeConnection(Key)`, `institutionConnections`
- `src/lib/partners.ts` — admin-side partner/key/grant CRUD, `approveProposal`/`rejectProposal`
- `src/lib/partner-guide.ts` — the canonical prose narrative (two-contract model, sequence, merge rules, failure codes) shared by `/developers` and the OpenAPI `partner` tag
- `src/lib/ingestion.ts` (910 lines) — pure merge planner: `planMerge`, `planPrograms`, `mergeById`, `canonicalPayloadHash`, `idempotencyOutcome`, `rateLimitDecision`, `proposalRequirements`, `buildAppliedResult`, `SECTION_SCOPES`
- `src/lib/ingestion-schema.ts` — zod wire contract (`ingestionPayloadSchema` and all nested schemas)
- `src/lib/ingestion-db.ts` — `loadCurrentState`, `applyPlan` (the transaction), `ingestionRateLimit`
- `src/lib/fees.ts` — `computeTotalAnnualCost`, offer/discount math (`discountSavings`, `effectiveCost`, `bestOfferFor`)
- `src/lib/enums.ts` — every vocabulary (`INSTITUTION_TYPES`, `FEE_TYPES`, `FEE_FREQUENCIES`, `PARTNER_SCOPES`, `MEDIA_KINDS`, `PLANS`, `OFFER_KINDS`, ...)
- `src/app/api/v1/partner/connections/route.ts`, `partner/me/route.ts`, `partner/institutions/[externalId]/route.ts`, `partner/events/[id]/route.ts`
- `src/app/api/v1/offers/route.ts`, `offers/[id]/claim/route.ts` — confirmed session-cookie-only, not partner-reachable
- `src/app/portal/integrations/page.tsx`, `actions.ts` — institution self-serve connect/disconnect UI
- `prisma/schema.prisma` — `Partner`, `PartnerKey`, `ConnectionKey`, `PartnerGrant`, `IngestionEvent`, `Program`, `FeeStructure`, `FeeComponent`, `Result`, `Scholarship`, `Media`, `Offer`, `OfferClaim` models (lines 402-1107)
- `docs/superpowers/specs/2026-08-25-partner-ingestion-api-design.md` — original design doc, confirms plan/billing-field exclusion was deliberate
