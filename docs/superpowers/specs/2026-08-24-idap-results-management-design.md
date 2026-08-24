# I-DAP Phase 2 — Results Management

**Date:** 2026-08-24
**Status:** Approved for planning
**Phase 1 spec:** `docs/superpowers/specs/2026-08-23-idap-institution-profile-design.md`

---

## 1. What this is

Phase 1 built the Institution Profile — the master identity every module attaches to.
Phase 2 attaches the first such module: **Results Management**.

An institution publishes its exam-cycle outcomes once. Its own website, and later
PassPercent, read the same record through the same credential-free public API pattern
Phase 1 established. No consumer re-enters results data.

Results are the strongest single driver of admission enquiries in the Indian market. A
school's results page is the most-visited page it has, and the pass percentage is the
first number a parent compares. This module makes that data a first-class, structured,
machine-readable asset rather than a JPEG on a website.

### What Phase 2 is

Institution-level **aggregate** results: how a cohort performed in one exam cycle, plus
the named toppers the institution chooses to celebrate.

### What Phase 2 is not

**No per-student results lookup.** No roll-number-and-DOB marksheet retrieval, no bulk
marks import, no individual student records. That is a different product with a different
privacy posture, and it is out of scope. The only student PII in this module is the
topper list, which the institution enters by hand and explicitly asserts consent for.

**No subject-level breakdown.** No per-subject averages or pass rates. Most institutions
do not publish these, and the data-entry burden outweighs the value.

**No cross-institution discovery API.** PassPercent's comparison endpoint is not built
here (see §11).

**No lead follow-up mechanism.** Phase 1's findings noted that results attract enquiries
and nothing yet converts them — leads have no assignee, no follow-up date, and there is
one institution role. That remains true and remains out of scope. It is a distinct
subsystem touching auth, the role model, and the lead pipeline, and it deserves its own
spec.

---

## 2. Decision register

Seven decisions were taken before design. They bind the rest of this document.

| # | Decision | Rationale |
|---|---|---|
| 1 | Results live in their own `results` collection, tenant-scoped by `institutionId` — not embedded on `Institution`. | Results accumulate indefinitely (2–4 cycles a year, forever). Each needs its own publish lifecycle, since Class 10 results land weeks before Class 12. Cross-institution comparison — the entire point of PassPercent — needs indexes, which embedded arrays cannot provide. Embedding would also bloat every profile read with data the profile endpoint does not serve. |
| 2 | `passPercentage` is computed at read time, never stored. | A stored derived value drifts the moment someone corrects `appeared` or `passed` without recomputing. The one place it is allowed to exist is the projection that emits it. |
| 3 | `board` is an enum; `boardName` carries the open-ended cases. | Board is the axis every consumer compares on. Free text guarantees `CBSE` / `C.B.S.E.` / `Cbse` / `cbse board` within a single quarter, which no consumer can ever reconcile. The enum's `STATE_BOARD` and `OTHER` members plus a `boardName` string handle India's open-ended state boards without surrendering comparability. |
| 4 | A result is publicly visible only if it is `PUBLISHED` **and** its institution passes the same visibility gate the profile endpoint uses. | Otherwise results become reachable on an institution whose profile returns 404 — an inconsistency a consumer cannot reason about, and a way for a suspended institution to keep a live public surface. |
| 5 | A topper without `consentAcknowledged: true` is dropped from public output entirely. | Named minors on a credential-free API is the highest-risk surface in this module. The projection — not the UI, not the editor — is the enforcement point, because the projection is the only thing every public read passes through. |
| 6 | The uniqueness of an exam cycle is enforced by a unique compound index, resolved write-then-catch-11000. | Same idiom as Phase 1's slug allocation. Read-then-write races between two browser tabs and silently creates duplicate cycles; the index cannot. |
| 7 | Topper photos reuse Phase 1's public-media pipeline under the same `/media/:institutionId/` key prefix. | `isOwnedMediaUrl()` — the guard added to close Phase 1's Critical cross-tenant deletion finding — matches on that prefix. Storing topper photos anywhere else would require either a second guard or a weakened one. Reusing the prefix means the existing guard protects the new surface with no modification. |

### Rulings made during design

- **Level is an enum, not free text.** Same reasoning as board (decision 3). `CLASS_10` /
  `Class X` / `10th` / `SSLC` are the same cohort and must group as one.
- **No human-readable result number.** Leads and applications carry `INS0001-LD000001`
  style numbers because parents quote them back over the phone. Nobody quotes a result
  record ID. It gets an ObjectId and nothing more.
- **Bands are institution-editable, not fixed.** A fixed 90/75/60 ladder is more
  comparable, but institutions genuinely publish different ladders (distinction /
  first class / second class is still common at PU and degree level). Overlap and
  sum validation, not a fixed ladder, is what keeps the data sane.
- **Results do not contribute to profile completion.** Profile completion measures the
  identity record. Folding an unrelated module into that percentage would make the meter
  drop for every institution the day this ships.

---

## 3. Architecture

```
                    Institution  ◀── the master record (Phase 1)
                    institutionId: INS0001
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
     Profile          Lead Network         Results        ◀── Phase 2
   identity           enquiries          exam cycles
   contact            applications       aggregates
   address            documents          score bands
   academic           notes              toppers
   ...                activity           publish state
                           │
                           ▼
                    ┌─────────────┐
                    │     API     │
                    └─────────────┘
                     │           │
          Institute admin      Public (credential-free)
          cookie + CSRF        allow-list projection
```

### Layer separation

Identical to Phase 1, and non-negotiable:

- **Route** — auth, CSRF, Zod parse, envelope. Never touches storage or the database
  directly.
- **Service** — all database and storage access. `ResultService` is the only module that
  reads or writes the `results` collection.
- **Projection** — `toPublicResult()` is the sole path from a stored document to a public
  response.

---

## 4. Data model

New collection: `results`.

### 4.1 Cycle identity

| Field | Type | Notes |
|---|---|---|
| `institutionId` | String, required, indexed | `INS0001`. Flat human-readable id, matching `Lead` and `Application`. |
| `board` | enum `RESULT_BOARDS`, required | See §4.6. |
| `boardName` | String, ≤120 | Required when `board` is `STATE_BOARD` or `OTHER`; ignored otherwise. The display name, e.g. `Karnataka State Board`. |
| `level` | enum `RESULT_LEVELS`, required | See §4.6. |
| `stream` | enum `RESULT_STREAMS`, nullable | `SCIENCE` / `COMMERCE` / `ARTS`. Null for Class 10 and most non-PU levels. |
| `academicYear` | String, required, ≤20 | `2025-26`. Same format as `Application.academicYear`. |
| `examLabel` | String, ≤120, optional | Display override when the generated label reads poorly. |

**Uniqueness:** one record per `(institutionId, board, level, stream, academicYear)`.
`stream` is stored as `null` rather than omitted so the unique index treats "no stream"
as a single consistent value.

### 4.2 Aggregates

| Field | Type | Notes |
|---|---|---|
| `appeared` | Number, required, ≥ 0 | Cohort size. |
| `passed` | Number, required, ≥ 0 | Must be ≤ `appeared`. |
| `averageScore` | Number, 0–100, optional | Percentage. |
| `highestScore` | Number, 0–100, optional | Percentage. |

`passPercentage` is **not a field**. It is computed as `appeared > 0 ? passed / appeared * 100 : null`, rounded to one decimal, at projection time.

### 4.3 Score bands

`bands: [BandSchema]`, `{_id: false}`, max 8 entries.

| Field | Type | Notes |
|---|---|---|
| `label` | String, required, ≤40 | `90% and above`, `Distinction`. |
| `minPercentage` | Number, 0–100, required | Inclusive. |
| `maxPercentage` | Number, 0–100, required | Inclusive. Must be ≥ `minPercentage`. |
| `count` | Number, ≥ 0, required | Students in this band. |

Validated as a set: bands must not overlap, and `sum(count) ≤ appeared`.

### 4.4 Toppers

`toppers: [TopperSchema]`. **Keeps its own `_id`** — the photo endpoint addresses toppers
individually, exactly as `GalleryItemSchema` does. Max 25 entries.

| Field | Type | Notes |
|---|---|---|
| `name` | String, required, ≤120 | |
| `percentage` | Number, 0–100, required | |
| `rank` | Number, ≥ 1, optional | Display rank within this cycle. |
| `note` | String, ≤200, optional | `School topper`, `District rank 3`. |
| `photoUrl` | String, optional | Public media URL under `/media/:institutionId/`. |
| `consentAcknowledged` | Boolean, default `false` | The institution asserts it holds the student's/guardian's consent to publish. |

`consentAcknowledged` records an assertion by the institution, which is where the
liability actually sits. It is not consent management, and this document does not claim
it is. Its enforcement value is in §8.

### 4.5 Lifecycle

| Field | Type | Notes |
|---|---|---|
| `status` | enum `RESULT_STATUSES`, default `DRAFT` | `DRAFT` / `PUBLISHED` / `ARCHIVED`. |
| `publishedAt` | Date, optional | Set on the **first** transition to `PUBLISHED`, and retained thereafter — it records when the institution first made this cycle public, not when it was last touched. Unpublishing does not clear it. |
| `createdAt` / `updatedAt` | Date | Mongoose timestamps. |

Per-record status, deliberately. An institution publishes Class 10 in May and Class 12 in
June; a single institution-wide results flag cannot express that.

**`ARCHIVED` versus deletion.** `ARCHIVED` retains the record and its history while
removing it from public output — the reversible way to retire an old cycle. `DELETE`
(§6.1) is permanent removal of the document and its owned topper photos. Both exist
because retiring a cycle and erasing one are different intentions, and only the second
is destructive.

### 4.6 Constants

Declared in `src/lib/constants.ts` following the existing tuple → derived type → labels
map pattern:

```
RESULT_BOARDS    CBSE, ICSE, ISC, IB, IGCSE, STATE_BOARD, UNIVERSITY, AUTONOMOUS, OTHER
RESULT_LEVELS    CLASS_10, CLASS_12, PUC_1, PUC_2, UG, PG, DIPLOMA, OTHER
RESULT_STREAMS   SCIENCE, COMMERCE, ARTS
RESULT_STATUSES  DRAFT, PUBLISHED, ARCHIVED
```

Each gets a `*_LABELS` map, since all four are rendered in the UI.

### 4.7 Indexes

```
{ institutionId: 1, createdAt: -1 }                                    dashboard list
{ institutionId: 1, status: 1, academicYear: -1 }                      public read
{ institutionId: 1, board: 1, level: 1, stream: 1, academicYear: 1 }   unique — cycle identity
{ status: 1, board: 1, level: 1, academicYear: -1 }                    reserved for §11
```

The fourth index serves no query built in this phase. It exists so the cross-institution
discovery API is a purely additive change later, with no migration and no index build on
a populated collection.

---

## 5. Validation

Enforced in `src/lib/validation/result.ts` with Zod, mirroring
`src/lib/validation/institution.ts`.

**Always enforced, on every write:**

- `passed ≤ appeared`
- `sum(bands[].count) ≤ appeared`
- no two bands overlap
- every `minPercentage ≤ maxPercentage`
- all percentage fields within 0–100
- `boardName` present when `board` is `STATE_BOARD` or `OTHER`

**Additionally enforced at publish time:**

- `appeared > 0`
- every topper has `consentAcknowledged: true`

A draft may be saved incomplete. Publishing is the gate. This mirrors Phase 1, where a
profile can be a partial draft but publishing applies stricter rules.

---

## 6. API surface

### 6.1 Institute admin — own institution

Cookie session + CSRF (`assertSameOrigin` + `requireInstitution`), never bearer.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/settings/results` | List this institution's results. |
| `POST` | `/api/settings/results` | Create a cycle. 409 on duplicate cycle. |
| `GET` | `/api/settings/results/:resultId` | Read one. |
| `PATCH` | `/api/settings/results/:resultId` | Update fields, bands, toppers. |
| `DELETE` | `/api/settings/results/:resultId` | Delete, including owned topper photos. |
| `POST` | `/api/settings/results/:resultId/publish` | `{ action: "publish" \| "unpublish" }`. |
| `POST` | `/api/settings/results/:resultId/toppers/:topperId/photo` | Multipart upload. |
| `DELETE` | `/api/settings/results/:resultId/toppers/:topperId/photo` | Remove photo. |

Every handler follows the established shape:
`try { assertSameOrigin → requireInstitution → validate → service → jsonSuccess } catch { handleApiError }`.

### 6.2 Platform admin

**None.** The platform admin provisions institutions; they do not read institution
results, exactly as they do not read enquiries or applications. No route is added, which
is how the boundary is enforced — by construction, not by a check.

### 6.3 Public — credential-free

| Method | Path |
|---|---|
| `GET` | `/api/public/:institutionId/results` |
| `GET` | `/api/public/institutions/:slug/results` |

Both mirror the Phase 1 public profile endpoints exactly:

- No credentials. `security: []`.
- `Cache-Control: public, max-age=300` — same as the profile endpoint.
- IP-keyed rate limiting via `PUBLIC_READ_RATE_LIMIT` (60/min). Keyed on IP only, never
  on `institutionId` or slug, so one institution's traffic cannot exhaust another's
  allowance.
- **404-never-403.** A draft result, an archived result, a suspended institution and a
  nonexistent institution are indistinguishable to a caller. There is no 403 branch to
  write, because none exists in the handler.
- `OPTIONS` returns `publicCorsPreflight()`.

Optional filters: `?academicYear=`, `?level=`, `?board=`. Absent filters return all
published cycles, newest academic year first.

### 6.4 OpenAPI

`src/lib/api/openapi.ts` gains both public paths under the existing `Website` tag, and
a `PublicResultsResponse` schema. Every institution's downloadable spec therefore
documents the results API automatically.

---

## 7. Authorization

| Actor | Read own results | Write own results | Read published results | Read other institutions |
|---|---|---|---|---|
| Institute admin | yes | yes | yes | **no** |
| Platform admin | **no** | **no** | yes (as any public caller) | **no** |
| API client (bearer) | **no** — not in this phase | **no** | yes | **no** |
| Anonymous public | — | — | yes | yes, published only |

Every institute-admin route resolves the institution from the session via
`requireInstitution()` and scopes the query by that `institutionId`. A `resultId` from
another tenant returns **404, not 403** — same rule as the rest of the platform.

---

## 8. Public projection

`src/lib/results/public-projection.ts` exports `toPublicResult()`. It is the **sole**
path from a stored result document to a public API response.

Built field-by-field, never a spread, never a deny-list — identical to `toPublicProfile`.
A test asserts the exact set of emitted keys, so a field added to the schema fails that
test until someone deliberately decides whether it is public.

Three rules the projection enforces, and the only place they are enforced:

1. **Only `PUBLISHED` results are ever projected.** Callers pass filtered input, but the
   projection re-checks; defence in depth on the module's highest-risk boundary.
2. **Toppers without `consentAcknowledged: true` are dropped.** Not blanked, not
   anonymised — omitted from the array entirely.

   This is not redundant with §5's publish-time check, and the distinction matters:
   consent can be **withdrawn after publication**. An institution may untick consent on
   an already-published result, and doing so must take that topper off the public API
   immediately, without requiring the institution to unpublish the whole cycle. §5 gates
   the transition; the projection gates every read. Withdrawal is the case only the
   second one catches.
3. **`passPercentage` is computed here** and emitted; the raw stored fields
   `appeared`/`passed` are also emitted, so a consumer can verify the arithmetic.

Never emitted: `_id` of the result or its toppers, `createdAt`/`updatedAt`,
`consentAcknowledged` itself, and any future internal field.

---

## 9. Storage — topper photos

Topper photos are institution media, not documents. They use `putPublic` / `deletePublic`
on the **public-access Blob store**, under the key prefix
`media/:institutionId/results/:resultId/:topperId`.

That prefix is load-bearing. `isOwnedMediaUrl(url, institutionId)` — added to close Phase
1's Critical finding, where an attacker-supplied URL could delete another tenant's blobs —
matches on `/media/:institutionId/`. Keeping topper photos under it means the existing
guard covers this surface unchanged.

Every deletion path calls that guard first: replacing a photo, deleting a topper,
deleting a whole result. A result deletion deletes only photos whose URLs pass the
ownership check; a URL that fails is left alone rather than deleted, and never blocks
the record's deletion.

`ResultService` calls storage. Routes never do.

---

## 10. Dashboard

### 10.1 Navigation

One item added to `INSTITUTION_NAV` in `src/components/dashboard/nav-config.ts`, in the
first group alongside Enquiries and Applications, since it is tenant data rather than
configuration:

```
Dashboard · Enquiries · Applications · Results
Institution Profile · Integration · Settings
```

Nothing is added to `SUPER_ADMIN_NAV`.

### 10.2 Results list — `/results`

A table of cycles: label (board + level + stream + year), appeared, pass %, status chip,
last updated. Sorted newest academic year first. Empty state invites the first cycle.

### 10.3 Results editor — `/results/[resultId]`

One page, three sections:

- **Cycle** — board, boardName, level, stream, academic year, exam label.
- **Outcome** — appeared, passed, average, highest, and the band editor (add/remove rows,
  live validation of overlap and sum against `appeared`).
- **Toppers** — repeatable rows with name, percentage, rank, note, photo upload, and the
  consent checkbox. The publish button is disabled, with a named reason, while any topper
  lacks consent.

Live-computed pass percentage is shown beside `appeared`/`passed` as they are typed, so
the number the institution is about to publish is never a surprise.

Publish/unpublish is a dialog naming exactly what will become public — mirroring Phase
1's publish dialog, which enumerates every public leaf field.

---

## 11. Future extensibility

The cross-institution discovery API PassPercent needs — `GET /api/public/results` with
filtering by board, level, year and locality, plus pagination and ranking — is
**deliberately not built here**. PassPercent does not exist yet, and guessing its filters
blind produces an API that must be broken later.

What this phase does provide: the fourth index in §4.7, and a projection that already
emits exactly the fields such an endpoint would serve. Adding the discovery endpoint later
is additive — a new route and a new service method, no schema change, no migration, no
index build against a populated collection.

---

## 12. Migration

**None required.** This phase adds a new collection and touches no existing document.

- No backfill. Institutions simply have no results until they enter one.
- No change to `Institution`, `Lead`, `Application`, or any existing schema.
- No change to Phase 1's profile projection, its completion calculation, or its tests.
- Deploy order is irrelevant; the new routes are inert until an institution creates a
  result.

This is the payoff from decision 1. Had results been embedded on `Institution`, this
section would describe a migration of every existing document.

---

## 13. Testing

Mirroring Phase 1's split between `tests/unit` (pure, no DB) and `tests/integration`
(real Mongo via `mongodb-memory-server`).

**Unit**

- `results-projection.test.ts` — exhaustive-key assertion; unconsented toppers dropped;
  `passPercentage` arithmetic including the `appeared === 0` case; draft never projected.
- `results-validation.test.ts` — every invariant in §5, each asserted to *fail* on
  violation: `passed > appeared`, overlapping bands, band sum exceeding `appeared`,
  out-of-range percentages, missing `boardName`, publish blocked without consent.
- `openapi-results.test.ts` — both public paths present, `security: []`.

**Integration**

- `results-crud.test.ts` — create, read, update, delete; duplicate cycle returns 409 via
  the unique index, not a pre-read.
- `results-publish.test.ts` — publish sets `publishedAt`; unpublish preserves data;
  publish rejected while a topper lacks consent.
- `results-tenant-isolation.test.ts` — a `resultId` from another tenant returns 404, not
  403, on every institute-admin route.
- `results-public.test.ts` — published cycle returns 200 by both id and slug; draft
  returns 404; archived returns 404; result on a suspended institution returns 404;
  unconsented topper absent from the payload; **consent withdrawn on an already-published
  result removes that topper from the next read**; `?academicYear=` / `?level=` /
  `?board=` filters select correctly and an unknown value returns an empty list rather
  than an error; rate limit trips; `Cache-Control` header correct.
- `results-media.test.ts` — topper photo upload lands under the owned prefix; deletion
  respects `isOwnedMediaUrl`; a foreign URL is not deleted.

**Method.** Every guard is verified by mutation: remove the guard, confirm the test fails,
restore it. A test that passes with its guard deleted is not evidence of anything.

---

## 14. Definition of done

- All tests green, and the pre-existing 297 still green.
- `npx tsc --noEmit` clean; lint clean.
- Every invariant in §5 has a test that fails when its guard is removed.
- The projection's exhaustive-key test fails when a field is added to the schema.
- A published result is readable by `curl` with no credentials, by both id and slug.
- A draft result, and a published result on a suspended institution, both return 404.
- An unconsented topper is absent from public output, verified over real HTTP.
- The platform admin has no route to results — verified by absence, and by a test
  asserting a `SUPER_ADMIN` session is rejected on the institute-admin routes.
- Topper photo deletion is guarded by `isOwnedMediaUrl`, verified by mutation.
- OpenAPI documents both public paths.

---

## 15. Known limitations

- `consentAcknowledged` is an assertion by the institution, not verified consent. There
  is no consent artefact, no audit trail of who ticked it, and no expiry.
- No revision history. Correcting a published result overwrites it; only the existing
  `Activity` log records that a change occurred.
- No cross-institution query (§11), so PassPercent cannot yet be built against this.
- No bulk import. An institution with a decade of historical results enters them by hand.
- Bands are free-form, so two institutions' ladders may not be directly comparable even
  though both are valid.
- No per-consumer analytics on the public results endpoint, the same gap Phase 1 recorded.
- The 5-minute cache means a correction to a published result can take up to five minutes
  to propagate — chosen deliberately for consistency with the profile endpoint.

---

## 16. Recommended Phase 3

**Lead follow-up**, still. Phase 1 flagged it, this phase deliberately did not take it,
and shipping results makes it more urgent rather than less: this module exists to drive
enquiries into a pipeline that still has no assignee, no follow-up date, and one
institution role.
