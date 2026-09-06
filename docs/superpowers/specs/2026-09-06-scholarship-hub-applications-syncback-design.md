# Scholarship Hub — Applications Sync-Back (Phase 2) Design

**Status:** Approved (section-by-section) — awaiting spec review before planning.
**Date:** 2026-09-06
**Depends on:** Phase 1 syndication (design: `2026-09-06-scholarship-hub-syndication-design.md`; Plan 1A merged to scholarship-hub main; Plan 1B merged to IDAP main @ `3e1c371`).
**Repos:** IDAP (`/Users/automicai/AEMPlatform`, Next.js 16 + Mongoose 8) and Scholarship Hub (`/Users/automicai/scholarship-hub`, Express 5 + Mongoose 8, Node ≥24). Both writable.

---

## 1. Goal & relationship to Phase 1

Phase 1 pushes IDAP scholarships **out** to the Hub, where students discover and apply (`applicationMode: "platform"`). Phase 2 brings those **applications back in**: an application a student submits on the Hub appears in an IDAP "scholarship applications" inbox, where the institution reviews and decides. This is the mirror (inbound) direction of Phase 1's outbound push.

**Confirmed product decisions (via brainstorming):**
1. **Transport = hybrid** — a signed webhook (push, low latency) *and* a scheduled reconciliation poll (pull, reliability), both feeding one idempotent ingestion core.
2. **Data model = a new dedicated `ScholarshipApplication` model** in IDAP (not the admission `Application`, not `Lead`) with its own inbox.
3. **Scope = one-way IN**, including Hub-originated status changes (submission, withdrawal, resubmission). The institution decides in IDAP; those decisions do **not** flow back to the Hub in Phase 2 (deferred — see §9).
4. **Documents = metadata + on-demand proxy fetch** — IDAP stores document metadata and streams the bytes from the Hub on demand (no bulk copy).
5. **Webhook payload = thin ping** — the webhook says "application X changed"; IDAP pulls the full detail from the same partner endpoint the poll uses.

---

## 2. Architecture

### 2.1 One ingestion core, two triggers
IDAP exposes a single idempotent function, `upsertFromHubPayload(payload)`, deduped on `(institutionId, hubApplicationId)`. Two independent triggers call it:
- **Push:** the Hub fires a signed `application.changed` webhook → IDAP's inbound receiver verifies the signature → fetches the current application detail → `upsertFromHubPayload`.
- **Pull:** a scheduled IDAP job (Vercel cron) calls the Hub's "applications since cursor" endpoint → `upsertFromHubPayload` for each row → advance cursor.

Because both converge on one idempotent core, a missed or failed webhook is **never fatal** — the next poll backfills it. Push is a latency optimization layered over a poll that is the correctness guarantee. This is the standard webhook-plus-reconciliation pattern.

### 2.2 Two-repo split (Hub-first)
- **Hub (sending surface, mostly net-new — the Hub has zero outbound infra today):** a partner "applications since cursor" endpoint; a `requirePartner` document-streaming endpoint; webhook registration (callback URL + signing secret) + an outbound signed dispatcher with retry; an emit hook at the application lifecycle transitions.
- **IDAP (receiving surface):** the `ScholarshipApplication` model + idempotent ingestion core; the inbound signed-webhook receiver; the reconciliation pull; the document proxy; the inbox UI; permissions + an admin push notification.

Deploy Hub endpoints **before** IDAP consumes them (same endpoints-first discipline as Phase 1).

### 2.3 The join key
Phase 1 already stamps each syndicated scholarship with `externalRef = IDAP:{institutionId}:{scholarshipId}` (and the provider with `IDAP:{institutionId}`). Every application inherits its scholarship's `externalRef`, so `externalRef` is the address that routes an application back to the right IDAP institution + scholarship. It is **parseable without a DB hit**, then cross-checked against the local `Scholarship.listing.externalRef` (§5.4).

---

## 3. Hub sending surface

### 3.1 Applications-since-cursor endpoint
`GET /api/partner/applications?since=<cursor>&limit=<n>` — `requirePartner` (`Authorization: Bearer sh_pkey_...`).

- **Scoping (mandatory):** returns only applications whose scholarship's `partnerId` equals the authenticated partner. To make the cursor scan efficient and leak-proof, **denormalize `partnerId` onto the `Application` row** at creation (from `scholarship.partnerId` when present) and add a compound index `(partnerId, updatedAt, _id)`. A one-time backfill sets `partnerId` on any pre-existing partner-scholarship applications.
- **Filter:** `applicationMode: "platform"` and status in the submitted family (never `draft`). Withdrawn rows ARE included (so IDAP learns of withdrawals).
- **Ordering / cursor:** ascending `(updatedAt, _id)`; `since` is the last tuple IDAP processed. Requires a monotonic change timestamp on the Application. Plan 2A's first step is to verify at source whether Mongoose `timestamps` is already enabled on `ApplicationModel`; if not, it enables `{ timestamps: true }` (the standard, indexable `updatedAt`) rather than hand-rolling a parallel `changedAt` field.
- **Projection (allow-list — no field beyond this contract, no other applicant's data):** `hubApplicationId` (the `_id`), `externalRef` (from the scholarship), `scholarshipTitle`, `applicant` (`profileSnapshot.student`: `{name, email, mobile?}`), `answers` (only keys for that scholarship's own `customQuestions`), `documents` (metadata only: `[{key, label, filename, contentType}]` — **no bytes, no `storageKey`**), `status`, `applicationNo?`, `submittedAt?`, `withdrawnAt?`, `hubUpdatedAt` (= `updatedAt`), and a compact `timeline` (status history) if cheap.
- **Optional (forward-looking):** MAY accept `?institutionExternalRef=IDAP:{institutionId}` to scope to one institution for on-demand refresh; not required for Phase 2's platform-level poll.

### 3.2 Document-streaming endpoint
`GET /api/partner/applications/:hubApplicationId/documents/:key/file` — `requirePartner`.

Resolves the file **through the application's own `documents[]` slot** (by `key`, never a raw document id — the same safe pattern the Hub's provider document route uses), confirms the application belongs to the calling partner, then streams bytes via the existing `sendDocumentFile`/`streamFile` plumbing with a correct `Content-Disposition`. This is what IDAP's proxy (§4.5) calls on demand.

### 3.3 Webhook registration + secret
`PUT /api/partner/webhook { url }` — `requirePartner`. Validates `url` (https), (re)generates an HMAC signing secret, stores `webhookUrl` + `webhookSecret` + `webhookActive: true` on `PartnerModel`, and returns the secret **once** in the response body (mirrors the `mint-partner-key` "printed once" pattern). Re-invoking rotates the secret. `PartnerModel` today is `{name, keyHash, active}`; Plan 2A adds these three fields.

### 3.4 Emit hook + outbound dispatcher
- **Emit hook:** a single helper `emitApplicationChanged(application)` called from each lifecycle transition of a **partner-owned** application (`submitApplication`, `withdrawApplication`, resubmit-after-info-request) — co-located with the existing `notify(...)` fan-out in `application.service.ts`. It no-ops unless the scholarship is partner-owned and the partner has `webhookActive`.
- **Delivery (outbox + worker):** the hook inserts a `PartnerWebhookDelivery` row `{partnerId, url, payload, status, attempts, nextAttemptAt, lastError?}`. A delivery worker (a CLI job on the Hub's existing `runJob`/cron convention) signs and POSTs pending rows: `X-SH-Signature: sha256=<hmac-sha256(rawBody, webhookSecret)>` + `X-SH-Timestamp: <unix>`; on non-2xx it schedules a backed-off retry; after N attempts it marks the row `failed` (the poll covers permanent failures). Delivery idempotency reuses the `JobDedupeModel` unique-index insert-and-catch pattern.
- **Payload (thin):** `{ event: "application.changed", externalRef, hubApplicationId, changedAt }`. IDAP always pulls current state, so a single event type suffices — no need to enumerate submitted/withdrawn/etc. on the wire.

---

## 4. IDAP receiving surface

### 4.1 `ScholarshipApplication` model
Tenant-scoped by `institutionId` (string, indexed — same convention as `Lead`/`Application`). Fields:
- **Link:** `institutionId`, `scholarshipId` (local Scholarship `_id`), `externalRef`, `hubApplicationId` (the idempotency key), `applicationNo?` (the Hub's `SH-...` number).
- **Applicant snapshot:** `applicant: {name, email?, mobile?}`.
- **Content:** `answers` (Mixed, keyed by question), `documents: [{key, label, filename, contentType}]` (metadata; bytes fetched on demand).
- **Two status axes:**
  - `hubStatus` — mirror of the Hub-side status (`submitted | under_review | shortlisted | additional_info_required | approved | rejected | withdrawn`), updated by every sync.
  - `reviewStatus` — IDAP's own institution workflow (`NEW | UNDER_REVIEW | SHORTLISTED | APPROVED | REJECTED`), owned locally. Sync sets it exactly once, to `NEW`, at row creation (§4.2 step 5); every subsequent sync **never overwrites** it — only the inbox UI/service (institution decisions) may change it after that.
- **Workflow/audit:** `assignedTo?`, `assignedAt?` (reuse the Lead assignment pattern), `submittedAt?`, `withdrawnAt?`, `hubUpdatedAt` (ordering guard), `lastSyncedAt`.
- **Idempotency index:** partial-unique `{institutionId, hubApplicationId}` (partial on `hubApplicationId $exists`, matching the M4 rationale).

`source` is implicitly `HUB`; the admission `Application` `SOURCES` enum is not touched.

### 4.2 Ingestion core
`ScholarshipApplicationService.upsertFromHubPayload(payload)` — the single function both triggers call:
1. Parse `externalRef` → `{institutionId, scholarshipId}` (no DB hit).
2. **Gate:** the institution must have a `CONNECTED` `SCHOLARSHIP_HUB` `PlatformConnection` (reuse `isHubConnected`); otherwise skip (no-op, success).
3. **Verify:** load `Scholarship.findOne({ _id: scholarshipId, institutionId })` and confirm `listing.externalRef === payload.externalRef`; reject+log a mismatch (forged/stale ref).
4. **Ordering guard:** if a row already exists and `payload.hubUpdatedAt < stored.hubUpdatedAt`, skip the Hub-owned field write (a stale poll snapshot must not revert a newer push).
5. **Upsert** (M4 pre-check + catch-11000 refetch) keyed on `(institutionId, hubApplicationId)`: write the Hub-owned fields (applicant, answers, documents metadata, `hubStatus`, `hubUpdatedAt`, `submittedAt`/`withdrawnAt`, `lastSyncedAt`). On **first insert** set `reviewStatus = NEW` and fire `notifyNewHubApplication`. On update, **never touch** `reviewStatus`/`assignedTo`.

A Hub-side withdrawal flips `hubStatus` to `withdrawn` (surfaced in the inbox) but never deletes the row.

### 4.3 Inbound webhook receiver
`POST /api/webhooks/scholarship-hub` — IDAP's first externally-reachable POST receiver. It reads the **raw** body, verifies `X-SH-Signature` (HMAC-SHA256 over the raw body, **constant-time** compare) against the platform-wide secret, checks `X-SH-Timestamp` within a short window (replay protection), then parses `{externalRef, hubApplicationId}`, fetches the current detail from the Hub (§4.5 client), calls `upsertFromHubPayload`, and returns `2xx` quickly. Bad/absent signature → `401`; malformed → `400`; a detail-fetch failure → `5xx` (so the Hub retries; the poll is still the backstop). No detail leaked on failure; body-size capped; rate-limited (reuse `consumeRateLimit`). The route's *shape* mirrors IDAP's existing API-client bearer handler, swapped to HMAC-over-body.

### 4.4 Reconciliation pull
A scheduled job (Vercel cron via `vercel.ts` crons) calls the Hub's `GET /api/partner/applications?since=<cursor>`, runs `upsertFromHubPayload` per row, and advances the cursor. **The cursor is platform-level** (one partner key = one stream across all institutions), stored on `PlatformCredential` (e.g. `applicationsSyncCursor`), because the partner endpoint is partner-scoped; each ingested row is still gated per-institution on CONNECTED (§4.2). A newly-connected institution's back-history, if ever needed, can be filled with an on-demand institution-scoped refresh using §3.1's optional filter — not required for Phase 2.

### 4.5 Document proxy + partner HTTP client
- IDAP gains a small partner HTTP client that authenticates to the Hub with the `sh_pkey_` platform key (decrypted from `PlatformCredential.keyEncrypted` via the existing vault) — used by both the webhook detail-fetch and the document proxy.
- `GET /…/scholarship-applications/:id/documents/:key/file` (dashboard-auth, permission-gated, tenant-scoped) resolves the document through the local application row, then streams from the Hub's §3.2 endpoint on demand. Optional caching is a later enhancement.

### 4.6 Inbox UI
A new dashboard list view mirroring `ApplicationsListView`: a `FilterBar` (by scholarship / `hubStatus` / `reviewStatus` / assignee / date), pagination, and a detail view showing applicant + answers + document view-links + both status controls + assignment. Scoped by `tenantFilter` (+ a visibility filter for counselor assignment, mirroring leads). Every mutation writes an `ActivityService` audit entry. No React render harness exists in IDAP, so decision logic is extracted to pure helpers and unit-tested (the `result-editor-logic` precedent from Phase 1); the form/list JSX is covered by `tsc` + service-level tests.

### 4.7 Notifications & permissions
- **Notification:** `NotificationService.notifyNewHubApplication(...)` on first ingest, via the existing FCM `afterResponse().catch()` pattern (failure never fails ingestion). No email channel exists to add to.
- **Permissions:** new `SCHOLARSHIP_APPLICATIONS_VIEW / DECIDE / ASSIGN` entries in `ROLE_PERMISSIONS`, granted to `INSTITUTION_ADMIN` and `COUNSELOR`, checked via `hasPermission()`.

---

## 5. Security & trust model

1. **Webhook authenticity:** HMAC-SHA256 over the raw body, constant-time compare, timestamp within a short replay window. Failures return uniform `401`/`400` with no detail and no work before verification. Body-size capped and rate-limited.
2. **Secret storage & rotation:** the signing secret lives as a new `webhookSecretEncrypted` field on `PlatformCredential` (Contract 1, platform-wide — there is exactly one partner, IDAP), via the AES-256-GCM vault (`IDAP_CREDENTIAL_KEY`). Rotation = re-run `PUT /api/partner/webhook`, then update the IDAP credential. Missing vault key → the receiver fails closed (existing credential behavior).
3. **Partner-side auth & scoping:** the Hub's list and document endpoints are behind `requirePartner` and strictly scoped to the caller's own `partnerId`; documents resolve through the application's own `documents[]` slot, never a raw document id.
4. **Tenant integrity on ingest:** `externalRef` from the wire is a claim, not proof — IDAP parses it, then verifies it against the local `Scholarship.listing.externalRef` + `institutionId` scoping and the CONNECTED gate. A forged/replayed ping can at worst cause a redundant, idempotent re-fetch of data IDAP is already entitled to; it can never inject an application for an unconnected institution or a scholarship IDAP never syndicated.
5. **PII discipline:** the flow carries applicant PII (name/email/mobile, answers, documents) — its purpose — but only to the one institution that owns the scholarship, gated by the new permissions and IDAP's tenant/visibility filters. The Hub allow-lists the projection (only that scholarship's answers, only that partner's rows). No public document URLs; every byte passes an ownership check.

---

## 6. Data flow, idempotency & failure handling

**Idempotency** is on `(institutionId, hubApplicationId)`, with an `hubUpdatedAt` ordering guard so a stale poll snapshot never reverts a newer push and push/poll racing converges. Local `reviewStatus`/assignment are never touched by sync.

**Failure matrix:**
- Webhook never arrives (IDAP down / dispatch fails) → Hub outbox retries with backoff, then gives up; the poll backfills. Push best-effort, poll authoritative.
- Webhook arrives but detail-fetch fails → `5xx`, Hub retries; poll is the backstop.
- Institution disconnected → ingest gate skips gracefully (`2xx` no-op).
- Scholarship missing / `externalRef` mismatch → that record rejected + logged; batch continues.
- Duplicate delivery (push + poll same change) → idempotent upsert, no dup rows.
- Withdraw-after-decision (student withdraws on the Hub after the institution shortlisted) → `hubStatus=withdrawn` and `reviewStatus=SHORTLISTED` coexist; the inbox surfaces "withdrawn on Hub" prominently. No data loss.
- Document fetch fails at view time → proxy returns a retryable error; metadata still shows. Non-fatal.

---

## 7. Testing

Both repos keep their conventions (Hub: Vitest + real local mongod; IDAP: Vitest + MongoMemoryServer at `--maxWorkers=4`). Security tests are first-class.
- **Hub:** partner-scoping on the list endpoint (never leaks another partner's applicants), cursor ordering/pagination, allow-list projection (no field beyond contract), platform-mode-only, withdrawn included; document ownership-through-slot + partner scoping + 404s; HMAC signing correctness + outbox retry/backoff + idempotent delivery; emit-hook fires only for partner-owned webhook-active scholarships.
- **IDAP:** ingestion idempotency (replay returns same row, cross-tenant never collides — mirror `application-lifecycle` idempotency), CONNECTED-gate skip, `externalRef` verify/reject, the `hubUpdatedAt` ordering guard, **`reviewStatus`-never-clobbered**, first-insert-notify; webhook receiver HMAC valid/invalid/replay + raw-body + uniform errors + rate-limit + disconnected no-op; pull cursor advance/backfill/idempotent re-ingest; document proxy auth/permission/tenant gates + Hub-down error; inbox filtering/assign/status at the service layer + pure UI helpers.

---

## 8. Decomposition & deploy order

**Plan 2A — Hub sending surface** (green + deployed before IDAP consumes): `partnerId` denormalization + index + backfill; applications-since-cursor endpoint; document-streaming endpoint; `PUT /webhook` registration + secret; `PartnerWebhookDelivery` outbox + signed dispatcher/retry worker; emit hook.

**Plan 2B — IDAP receiving surface:** `ScholarshipApplication` model; ingestion core; inbound webhook receiver + HMAC; partner HTTP client; reconciliation pull + cron; document proxy; permissions + notification; the inbox UI as its tail (split a **Plan 2C** for the UI only if 2B grows too large).

**Deploy order:** ship 2A; register IDAP's webhook (`PUT /partner/webhook`) and store the returned secret + `sh_pkey_` in IDAP's vault; configure the Vercel reconciliation cron; then enable 2B's push/pull. Otherwise pings `404` and polls return empty.

---

## 9. Out of scope / deferred

- **Decision push-back to the Hub** (IDAP shortlist/approve/reject → the applicant sees the outcome on the Hub). This closes the student loop and is the natural Phase 3: it needs a Hub endpoint to accept a partner decision, student-facing status display, and Hub-vs-IDAP status conflict handling. It extends Phase 1's push path.
- **Orphan applications** — if IDAP deletes a syndicated scholarship while Hub applications for it still exist, ingest logs + skips them (mirror of Phase 1's parked orphan-listing item). Tracked follow-up.
- **Eager document copy / caching** into IDAP storage (Phase 2 fetches on demand).
- **Applicant identity linking** — matching a Hub applicant to an existing IDAP `Lead`/`Application`/person by email/phone. Phase 2 keeps `ScholarshipApplication` standalone.
- **Email notifications** — IDAP has no email channel; only FCM push is wired.

---

## 10. Reused primitives (existing code the plans build on)

- **IDAP:** M4 idempotency (`application.service.ts`/`lead.service.ts` pre-check + catch-11000; partial-unique index); AES-256-GCM vault (`src/lib/security/credentials.ts`) + `PlatformCredential`/`PlatformConnection`; `isHubConnected`/`requireConnection` + `externalRefOf` (`src/services/scholarship-publish.service.ts`); `Scholarship.listing`; tenant/visibility filters (`src/lib/tenant`, `leadVisibilityFilter`); inbox patterns (`ApplicationsListView`, `FilterBar`, pagination, `application-status-dialog`, lead assign/status controls); FCM `afterResponse().catch()` (`notification.service.ts`); `ROLE_PERMISSIONS`/`hasPermission`; `ActivityService` audit.
- **Hub:** `requirePartner` + `sh_pkey_` partner-key (`middleware/partner-auth.ts`, `lib/partner-key.ts`); the `partner` module + `Scholarship.externalRef`/`Provider.externalRef`/`partnerId`; `JobDedupeModel` idempotency pattern; `runJob`/cron CLI-job convention; `sendDocumentFile`/`streamFile` + the provider document-through-slot resolution; local-disk `storage.ts`.
