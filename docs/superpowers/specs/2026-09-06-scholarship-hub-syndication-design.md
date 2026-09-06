# Scholarship Hub Syndication (Phase 1) — Design

**Status:** Approved design, ready for implementation planning
**Date:** 2026-09-06
**Repos:** IDAP (`/Users/automicai/AEMPlatform`) and Scholarship Hub (`/Users/automicai/scholarship-hub`) — both in scope
**Author:** brainstormed with the user, section-by-section approval

---

## 1. Goal

An IDAP institution authors a scholarship once, presses **Publish**, and it appears
**live** on Scholarship Hub as that institution's own verified-provider listing —
idempotently, with no manual steps on either side. Students discover and apply on
the Hub. IDAP stays the single source of truth for the scholarship record.

This is **Phase 1 of two**. Phase 2 (applications + provider decisions synced back
from the Hub into an IDAP applicant inbox) is a separate spec and is **out of scope
here** — see §12.

## 2. Confirmed decisions (from brainstorming)

- **Direction:** push IDAP → Hub, plus application sync-back (sync-back is Phase 2).
- **Both repos are writable.** The Hub gains new backend code; the other partner
  repos (PassPercent, FeesBasket, eduFleet) remain read-only and untouched.
- **Students apply on the Hub** (Hub `applicationMode: "platform"`), which is why
  IDAP scholarships must reach the Hub's full publish-completeness bar.
- **Full structured parity:** IDAP's scholarship editor gains the Hub's structured
  eligibility axes, benefits, categories, dates, and required documents so pushed
  listings match and filter well in Hub discovery.

## 3. Why this needs both repos

The Hub as it exists today (verified at source, 2026-09-06):

- Has **no machine/partner API** — the only write path is a human provider logging
  in (15-min JWT), getting **manually admin-verified**, then an admin **manually
  publishing** each listing.
- Has **no idempotency / external reference** on scholarships — a repeated create
  would duplicate listings.
- Has **no outbound webhook / callback** (relevant to Phase 2, not Phase 1).

So a real push integration cannot be built on IDAP alone. Phase 1 adds a
partner-ingestion surface to the Hub and a connector to IDAP.

## 4. Architecture spine

### 4.1 Provider identity — one Hub provider per IDAP institution

When an institution opts in, IDAP provisions a **provider org on the Hub carrying
the school's real name/city**, marked **partner-trusted** (auto-verified). Listings
are owned by that provider, so students see the actual school as the provider — not
"IDAP". A single "IDAP" mega-provider is explicitly rejected: it would break the
Hub's provider-trust model.

### 4.2 Auth & consent — platform key + in-IDAP opt-in (no cross-platform round-trip)

Reuses IDAP's existing two-contract model:

- **Contract 1 — platform credential.** One Hub **partner key** held by the IDAP
  super-admin, encrypted in IDAP's AES-256-GCM vault (`PlatformCredential`,
  `keyEncrypted`, `select:false`, gated by `credentialVaultReady()`).
- **Contract 2 — per-institution consent.** The institution ticks "syndicate my
  scholarships to Scholarship Hub" in IDAP's connections panel. Because IDAP has
  already verified the institution, that opt-in **is** the consent; IDAP vouches
  for the school via the partner key. The Hub's trusted-partner path therefore
  skips the manual document-verification and manual-publish steps a human provider
  faces.

There is **no eduFleet-style "approve on the other platform" round-trip** — the Hub
has no such approval surface, and it would add friction with no security gain here.

### 4.3 Idempotency — upsert by external reference

Every push carries a stable `externalRef`:

- Provider: `externalRef = "IDAP:{institutionId}"`
- Scholarship: `externalRef = "IDAP:{institutionId}:{scholarshipId}"`

The Hub stores `externalRef` (a new **unique** field on its scholarship model) and
**upserts** on it, so re-publishing an edit updates the same listing instead of
duplicating. This is the single most important capability the Hub lacks today.

### 4.4 Lifecycle (mirrors vacancy→eduFleet; failures never latch)

| IDAP action | Push |
|---|---|
| Publish | upsert a live Hub listing; store `listing` state on the IDAP scholarship |
| Edit while published | best-effort repush (records `blockedReason` on failure, never throws) |
| Unpublish / Archive / Delete | withdraw (close) the Hub listing |

A later successful push clears any `blockedReason`.

## 5. Data model + field mapping

### 5.1 IDAP scholarship — fields gained (grouped like the Hub)

Existing: `name`, `criteria` (free text), `amount` (free text), `academicUnitId`
(optional class link), `status` (`DRAFT|PUBLISHED|ARCHIVED`), `publishedAt`.

Added in Phase 1:

- **Basics:** `summary` (≤500), `description` (≤20000; ≥200 to publish),
  `categories[]`, `tags[]`
- **Benefits (all optional):** `amountMin`, `amountMax`, `stipendMonthly`,
  `awards`, `tuitionWaiver`
- **Eligibility:** `stateCodes[]`, `districtCodes[]`, `educationLevels[]`,
  `classesOrCourses[]`, `streams[]`, `genders[]`, `ageMin`, `ageMax`,
  `minPercentage` (0–100), `maxAnnualIncome`, `communityCategories[]`,
  `disabilityRequired`
- **Application:** `applicationMode` (default `"platform"`), `requiredDocuments[]`
  (`{key, label, required}`), `customQuestions[]`
  (`{key, label, type, options?, required, helpText?}`), `applicationSteps[]`
- **Dates:** `closesAt` (required to publish; must be in the future), `opensAt`,
  `resultAt`
- **Details (optional):** `selectionProcess`, `terms`, `faqs[]` (`{q, a}`),
  `sourceUrl`

### 5.2 Vocabulary — IDAP vendors the Hub's enums verbatim

IDAP cannot import the Hub's `packages/shared`, so it copies these enum sets into
IDAP constants **verbatim from the named Hub source files** and a test asserts every
IDAP value is one the Hub accepts (a subset guarantee that fails if the Hub's
vocabulary ever drifts):

- From `scholarship-hub/packages/shared/src/enums.ts`:
  - `SCHOLARSHIP_CATEGORIES` = government, private, university, merit, need_based,
    girl_students, stem, minority_community, disability, sports, international, csr
  - `EDUCATION_LEVELS` = school, puc, diploma, undergraduate, postgraduate, phd, other
  - `GENDERS` = female, male, other
  - `COMMUNITY_CATEGORIES` = general, sc, st, obc, category_1, 2a, 2b, 3a, 3b,
    minority, ews
  - `QUESTION_TYPES` = text, textarea, select, radio, checkbox, date, number, file
  - `APPLICATION_MODES` = platform, external
- From `scholarship-hub/packages/shared/src/data/states.ts` (and its sibling
  districts data): ISO-3166-2:IN state codes (KA = Karnataka is the launch market);
  district codes vendored from the same source.

`streams` and `classesOrCourses` are free-text string arrays on the Hub (no fixed
enum), so IDAP mirrors them as free text.

### 5.3 Field mapping (IDAP → Hub partner payload)

Near 1:1 after vocabulary adoption. The only non-identity moves:

| IDAP | → Hub | Rule |
|---|---|---|
| `name` | `title` | IDAP enforces 3–200 chars |
| `amount` (free text) | `benefits.amountText` | preserved verbatim; **satisfies the Hub benefit gate** (verified: `hasBenefit()` accepts a filled `amountText`) |
| `criteria` (free text) | `eligibility.otherCriteria[]` | split by line |
| `academicUnitId` (class link) | `eligibility.classesOrCourses[]` | the linked `AcademicUnit.pathLabel`; absent = institution-wide → left empty |
| all other fields | same-named Hub field | identity |

**No data loss:** the two legacy free-text fields ride along as `amountText` /
`otherCriteria`; structured fields are additive.

### 5.4 IDAP mirrors the Hub's publish gate locally

IDAP gains `assertScholarshipHubPublishable(input)` mirroring the Hub's
`missingScholarshipFields` (title; summary; description ≥200; ≥1 category; ≥1
benefit — an amount/stipend/waiver, and `amountText` counts; a future `closesAt`;
and for `platform` mode ≥1 required document). The institution sees **which fields
are missing inside IDAP before a push**, so a push never bounces on completeness. A
**gate-parity test** (§9) keeps the two definitions from drifting.

## 6. Hub-side design (`/Users/automicai/scholarship-hub`)

### 6.1 Partner authentication (new)

- A `Partner` record: `{ name, keyHash, active, createdAt }`. Key format
  `sh_pkey_<48 hex>`, stored **hashed** (compared by hash, never logged), with a
  prefix guard so a user access/refresh token can never be used as a partner key
  (mirror the existing `partner-token-logic.ts` prefix-check pattern).
- Middleware `requirePartner` resolves the partner from
  `Authorization: Bearer sh_pkey_…`, checks `active`, and puts the partner on
  `res.locals`. It never falls through to user-JWT resolution.

### 6.2 Partner endpoints (new, under `/api/partner/*`, all `requirePartner`)

```
POST   /api/partner/providers
  body  { externalRef: "IDAP:{institutionId}", name, city?, stateCode?, type? }
  → upsert a provider org owned by this partner; verificationStatus="verified",
    partnerId=<partner>, partnerTrusted=true
  → { providerId }

PUT    /api/partner/scholarships/{externalRef}
  body  full structured scholarship payload (see §5.3) + owning institution ref
  → resolve owning provider by "IDAP:{institutionId}" (must belong to this partner)
  → upsert scholarship by externalRef (unique)
  → run missingScholarshipFields; if incomplete → 422 { missing: [...] }
  → else set status="published" directly (trusted partner bypasses draft→review→admin-publish)
  → { hubId, slug, publicUrl, remoteStatus }

DELETE /api/partner/scholarships/{externalRef}
  → set status="closed" (idempotent; already-closed → 200)
  → { hubId, remoteStatus:"closed" }
```

### 6.3 Hub model changes

- `Scholarship`: add `externalRef` (string, **unique**, sparse — human-authored
  listings have none) and `partnerId` (ref, nullable). Ownership on partner
  endpoints is derived from `partnerId` + the institution segment of `externalRef`,
  **never from the request body**.
- `Provider`: add `externalRef` (unique, sparse), `partnerId`, `partnerTrusted`.
- The `submitForReview` verification gate and the admin-publish flow are **unchanged
  for human providers**; the partner path is a separate, trusted lane.

### 6.4 Admin authority preserved

An admin can suspend a partner listing (`moderationHold` / status `suspended`). A
subsequent partner `PUT` on a held listing does **not** silently re-publish — it
returns a **BLOCKED** result (409/403 with a reason) so IDAP records a
`blockedReason` instead of overwriting the admin's decision.

### 6.5 Public discovery unchanged

Partner-published listings are ordinary `published` scholarships to every public
read route; no read-side changes. `externalRef`/`partnerId` are internal, never
projected publicly.

## 7. IDAP-side design (`/Users/automicai/AEMPlatform`)

### 7.1 Platform registry

Add `SCHOLARSHIP_HUB` to `PLATFORMS` and `PLATFORM_LABELS` in `src/lib/constants.ts`
(label: "Scholarship Hub"). This flows the new platform through `PlatformCredential`,
`PlatformConnection`, `SyncRun`, the connections panel, and the platform-credentials
admin panel automatically (all iterate `PLATFORMS`).

### 7.2 Connector adapter — `src/lib/connectors/scholarship-hub.ts`

Implements `PlatformAdapter`. Because the Hub API is idempotent-upsert, the adapter
needs two push methods (simpler than the vacancy create/patch/close triad):

```ts
upsertScholarship(ctx, connection, payload): Promise<ListingPushResult>
withdrawScholarship(ctx, connection, externalRef): Promise<ListingPushResult>
```

Plus the connect path (§7.5) and the required `sync` (reconcile). Registers itself
via `registerAdapter(...)` at module scope; `src/lib/connectors/index.ts` adds
`import "./scholarship-hub";`. Uses the shared non-throwing `createConnectorHttp`
client and classifies responses into typed results/errors.

### 7.3 Mapping — `src/lib/connectors/scholarship-hub-mapping.ts`

A pure allow-list builder `toHubScholarshipPayload(scholarship, institution)` — the
only place that decides what leaves IDAP. Scholarship fields only; **no lead/
applicant PII**. Generates stable `key`s for `requiredDocuments`/`customQuestions`.

### 7.4 Orchestrator — `src/services/scholarship-publish.service.ts`

Mirrors `vacancy-publish.service.ts`. Owns all model reads/writes, contract
selection, preflight (`assertScholarshipHubPublishable`), the push call, and
recording results. `ScholarshipService.setStatus` / `update` / `remove` call it
(one-way import: the publish service must not import back into `ScholarshipService`).

### 7.5 Connect flow — the one framework extension

Connecting an institution to `SCHOLARSHIP_HUB` provisions its Hub provider via the
partner key and marks the `PlatformConnection` **CONNECTED immediately** — no
`initiate`→poll→`refresh` round-trip. Concretely, `initiate` calls
`POST /api/partner/providers`, stores the returned `providerId` as the connection's
grant handle (encrypted like any grant), and returns an already-connected result.
This is a small, additive extension to the connect flow; the existing
`REQUEST_APPROVE_REDEEM` and `PASTE_KEY` paths are untouched.

### 7.6 Listing state — `src/models/Scholarship.ts`

Add an embedded `listing` sub-document, mirroring `Vacancy.listing`:

```
listing {
  hubId, externalRef, slug, publicUrl,
  remoteStatus,        // "published" | "closed"
  lastPushedAt,
  blockedReason,       // set on BLOCKED/CONFLICT, unset on success
}
```

It is **withheld from the public projection**: `src/lib/scholarship/public-projection.ts`
stays an explicit allow-list and never spreads the document, so `listing` (and the
new internal fields) can never leak (mirror `vacancies/public-projection.ts` Rule 2).

### 7.7 Sync / reconcile

Extend `ConnectionService.syncNow` to build a scholarship worklist for any adapter
that implements `upsertScholarship` + `withdrawScholarship` (mirror
`reconcilesVacancies` / `loadSyncVacancies`), passing repush/withdraw closures via a
new `SyncSourceData.scholarships`.

### 7.8 UI

- Connections panel: `SCHOLARSHIP_HUB` appears automatically from the enum, with an
  opt-in toggle (Contract 2 consent).
- Scholarship editor gains the structured fields (§5.1) and a
  "publish to Scholarship Hub" affordance mirroring `vacancies-section.tsx`,
  surfacing `listing.publicUrl`, `remoteStatus`, and any `blockedReason`.

### 7.9 Generalized push result — the second framework extension

Lift today's vacancy-shaped `JobPushResult` into a shared `ListingPushResult` with
the same `OK / BLOCKED / CONFLICT` variants, so scholarships and vacancies share the
taxonomy. The vacancy path keeps its behavior; only the type is generalized.

## 8. Failure handling (reuses IDAP's existing typed taxonomy)

| Situation | Result | Behavior |
|---|---|---|
| Completeness 422 (shouldn't happen — local gate) | `ConnectorRejectedError` → VALIDATION_ERROR | no retry |
| Admin moderation hold | `BLOCKED` | recorded as `listing.blockedReason`, returned as 200 to the UI |
| externalRef conflict (shouldn't happen — upsert owns the ref) | `CONFLICT` | recorded as `blockedReason` |
| Partner key revoked / invalid | `ConnectorAuthError` | connection → DISCONNECTED, ciphertext dropped |
| Daily write cap | `ConnectorCapExceededError` | RATE_LIMITED; sweep stops (run-scoped) |
| Network / 429 | `ConnectorHttpError` | existing client retries once on 429 with `Retry-After` |
| Later successful push | — | `$unset listing.blockedReason` |

## 9. Testing strategy

### IDAP
- **Mapping — mutation-distinguishing:** deleting any single mapping line must fail a
  test (per the project's confounded-tests rule). Verify by copying the file aside,
  mutating, restoring from the copy, and checking shasum — never `git checkout`.
- **Enum-subset test:** every vendored IDAP vocabulary value is one the Hub accepts.
- **Gate-parity test:** `assertScholarshipHubPublishable` returns the same
  missing-field verdicts as the Hub's `missingScholarshipFields` across a shared
  fixture table.
- **Adapter classification:** table-driven over HTTP response → typed result
  (OK/BLOCKED/CONFLICT/rejected/cap/auth), using the non-throwing client contract.
- **Orchestration lifecycle:** publish→upsert records `listing`; edit→repush;
  unpublish/archive/delete→withdraw; a failure records `blockedReason` without
  throwing; a later success clears it.
- **Consent enforcement:** no CONNECTED connection → no push; revoke → withdraw +
  ciphertext dropped.
- **Public projection:** `listing` and internal fields never appear in the public
  projection (positive allow-list assertion).
- Suite runs at `--maxWorkers=4` (MongoMemoryServer pool).

### Hub
- **Partner-key auth:** valid / invalid / revoked / prefix-mismatch / inactive.
- **Ownership scoping:** a partner cannot upsert/withdraw a human provider's or
  another partner's listing; ownership derives from credentials + externalRef, not
  the body.
- **Upsert:** create vs. update by `externalRef` (two PUTs → one listing).
- **Withdraw idempotency:** withdraw twice → 200, status stays `closed`.
- **Moderation hold:** `PUT` on a held listing → BLOCKED, no re-publish.
- **Completeness:** incomplete payload → 422 with the missing-field list.
- **Human-provider flow unchanged:** existing verification/review tests stay green.

### Cross-repo contract
- One shared set of payload fixtures validated by **IDAP's mapping tests** and the
  **Hub's endpoint tests**, so the wire contract is asserted from both ends.
- Extend the Hub's `journey:*` scripts with `journey:partner`: provision a provider
  → upsert a scholarship → it appears in the public discovery API → withdraw removes
  it.

## 10. File touch-list

### Hub (create unless noted)
- `apps/api/src/models/partner.model.ts` — `Partner`
- `apps/api/src/middleware/partner-auth.ts` — `requirePartner`
- `apps/api/src/modules/partner/partner.routes.ts` — the three endpoints
- `apps/api/src/modules/partner/partner.service.ts` — provisioning + upsert + withdraw
- `apps/api/src/modules/scholarships/scholarship.model.ts` — **modify:** add
  `externalRef` (unique sparse), `partnerId`, `moderationHold`
- provider model — **modify:** add `externalRef`, `partnerId`, `partnerTrusted`
- `apps/api/src/modules/router.ts` — **modify:** mount `/api/partner`
- `scripts/journeys/partner.ts` + `package.json` `journey:partner` — **modify**
- Tests alongside each of the above

### IDAP (create unless noted)
- `src/lib/constants.ts` — **modify:** `PLATFORMS`, `PLATFORM_LABELS`, plus the
  vendored vocabulary constants + any `SCHOLARSHIP_LISTING_*` enums
- `src/lib/connectors/scholarship-hub.ts` — adapter
- `src/lib/connectors/scholarship-hub-mapping.ts` — mapping builder
- `src/lib/connectors/index.ts` — **modify:** side-effect import
- `src/lib/connectors/types.ts` — **modify:** `ListingPushResult`, adapter push
  method signatures, `SyncSourceData.scholarships`
- `src/models/Scholarship.ts` — **modify:** structured fields + `listing` sub-doc
- `src/lib/validation/scholarship.ts` — **modify:** enriched create/update schemas
  + `assertScholarshipHubPublishable`
- `src/lib/scholarship/public-projection.ts` — **modify:** confirm `listing`/internal
  fields excluded
- `src/services/scholarship-publish.service.ts` — orchestrator
- `src/services/scholarship.service.ts` — **modify:** call the publish service
- `src/services/connection.service.ts` — **modify:** scholarship worklist in `syncNow`
- `src/app/api/settings/scholarships/[scholarshipId]/publish/route.ts` — **modify/align**
- Scholarship editor components + `connections-panel` — **modify** (structured fields,
  publish affordance)
- Tests alongside each of the above

## 11. Security summary

- Partner key hashed at rest on the Hub, encrypted in IDAP's vault; never logged.
- Ownership derived from credentials, never the request body.
- Pushes gated on CONNECTED consent + scope; revocation withdraws + drops ciphertext.
- Allow-list payload — scholarship fields only, no applicant/lead PII in Phase 1.
- All IDAP listing state and lookups scoped by `institutionId`.
- Admin moderation on the Hub cannot be overridden by a partner upsert.

## 12. Out of scope / Phase 2 preview

- **Applications + provider decisions synced back** from the Hub into an IDAP
  applicant inbox. Requires (Hub) a signed outbound webhook on application-submitted
  / status-changed events, and (IDAP) a receive endpoint + a scholarship-applicants
  model and UI. Its own spec.
- **Structured eligibility on the Hub's matching beyond what parity already gives.**
- Anything touching PassPercent / FeesBasket / eduFleet.

## 13. Risks & open items

- **Vocabulary drift.** Mitigated by the enum-subset test; if the Hub adds an enum
  value IDAP hasn't vendored, IDAP simply can't emit it until re-vendored — safe,
  and the test documents the gap.
- **Hub connect-flow extension.** The immediate-connect path (§7.5) is new; keep it
  additive so `REQUEST_APPROVE_REDEEM` / `PASTE_KEY` are provably unchanged.
- **Districts data volume.** Vendor only what the eligibility editor needs
  (Karnataka launch market first); the subset test covers correctness regardless.
- **Deploy order.** Hub partner endpoints must ship before IDAP begins pushing (an
  IDAP push against a Hub with no `/api/partner` 404s). The plan orders Hub-first.
