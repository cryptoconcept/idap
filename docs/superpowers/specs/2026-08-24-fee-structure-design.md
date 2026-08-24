# Phase 4 — Fee Structure

**Date:** 2026-08-24
**Status:** Approved for planning
**Prior specs:** `docs/superpowers/specs/2026-08-24-idap-results-management-design.md`,
`docs/superpowers/specs/2026-08-24-lead-follow-up-design.md`

---

## 1. What this is

An institution publishes its fee structure — tuition and the other line items a class or
course carries — once, per academic year. Its own website reads the same record through
the same credential-free public API pattern Phase 2 established for results. No consumer
re-enters fee data by hand, and no prospective parent has to call the front desk to find
out what something costs.

Fee is the second-most-asked question after results, and the one a school is worst at
publishing in a comparable, structured form — most institutions bury it in a PDF or don't
publish it at all. This module makes it a first-class, structured, machine-readable asset,
built on the exact publish-lifecycle pattern Results Management already proved out.

### What Phase 4 is

Per-institution, per-academic-year fee structures, itemized by class or course: a set of
named line items (Tuition, Admission Fee, Transport, Lab Fee, …) with amounts, each
either mandatory or optional.

### What Phase 4 is not

**No payment collection.** Nothing in this phase moves money. There is no payment gateway,
no dues ledger, no per-student payment status, no receipts. This is publishing a price
list, not running a cashier. Collection is a distinct product with a distinct compliance
and reconciliation burden, deliberately out of scope, per your own explicit choice.

**No per-student fee assignment or waivers.** A fee structure describes what a class or
course costs in general. It does not track that one particular student was granted a
scholarship or a sibling discount. That is collection-adjacent and out of scope for the
same reason.

**No multi-currency.** Every institution on this platform operates in India; amounts are
plain `Number`, assumed INR, with no currency field. Adding one later is additive.

**No automatic effective-dating.** Publishing a fee structure makes it public immediately.
There is no "publish now, go live on 1 April" scheduling — an institution publishes when
it is ready, the same way Results does.

---

## 2. Decision register

Ten decisions were taken before design. They bind the rest of this document.

| # | Decision | Rationale |
|---|---|---|
| 1 | Fee structures live in their own `feestructures` collection, tenant-scoped by `institutionId` — not embedded on `Institution`. | Same reasoning as Results decision 1: fee structures accumulate one-or-more per academic year, indefinitely, each with its own publish lifecycle (a school may publish Class 10's fees before Class 12's). Embedding would bloat every profile read with data the profile endpoint does not serve, and cross-cycle queries (list by year, list by class) need indexes an embedded array cannot provide. |
| 2 | `classOrCourse` is free text, not an enum. | Unlike `board`/`level` in Results — a small, closed taxonomy every consumer must compare on — a class or course name is entirely institution-defined: `"Grade 10"`, `"B.Tech CSE"`, `"Diploma in Nursing"`, `"NEET Foundation Batch"`. Forcing an enum here would either be too narrow for the platform's real institution-type diversity (§ `INSTITUTION_TYPES` already spans schools, colleges, coaching institutions) or would have to grow without bound. Same reasoning that already made `Lead.classInterested` and `Institution.classesOffered` free text. |
| 3 | `classOrCourse` is not validated against `Institution.classesOffered`. | `classesOffered` is optional and often empty — Phase 1 never required it. Hard-validating against it would block fee entry until an unrelated profile field is filled in, which is a needless coupling between two modules. The dashboard editor may *suggest* values from `classesOffered` when present (§10.3), but the fee record itself accepts any string. |
| 4 | Line items are itemized (`label` + `amount` + `frequency` + `optional`), not a single flat total. | Per your own explicit choice. Matches how institutions actually communicate fees (tuition, admission, transport, lab, each a separate line a parent budgets separately), and avoids a redesign the day someone wants to show a breakdown. |
| 5 | `frequency` is a two-value enum, `ONE_TIME` \| `ANNUAL`. | Matches the scope agreed during design — a one-time admission fee versus a recurring annual charge covers the line items this phase actually needs to represent. Not `MONTHLY`/`QUARTERLY`/`PER_TERM`: no institution surveyed for this phase bills that granularly through this module, and a two-value enum that grows later is a cheap migration; a wrongly-guessed five-value enum today is not. |
| 6 | Fee structures are versioned by academic year, one record per `(institutionId, classOrCourse, academicYear)`, with a `DRAFT` / `PUBLISHED` / `ARCHIVED` lifecycle — identical shape to Results. | Per your own explicit choice, matching the Results Management pattern already proven on this platform: last year's fees stay intact as history rather than being silently overwritten, and a new year's numbers go through the same draft-then-publish review step results already use. |
| 7 | The published fee structure is public, via the same credential-free API pattern as Results. | Per your own explicit choice. The reason institutions publish fees at all is to inform prospective families before they enquire — the identical motivation Results Management's spec already recorded for exam outcomes. |
| 8 | Only `INSTITUTION_ADMIN` can create, edit, publish, or delete fee structures. Counselor and Front Desk get no route. | Matches every other institution-configuration surface on this platform (Results, Settings, Integration, Staff) — none of which grant Counselor/Front Desk write access. This is flagged, not just assumed: a front desk quoting fees over the phone is a plausible future need, but it is a *read* extension, not a write one, and is deliberately not built speculatively — see §15. |
| 9 | The uniqueness of a fee structure is enforced by a unique compound index, resolved write-then-catch-11000. | Same idiom as Results decision 6 and Phase 1's slug allocation. Read-then-write races between two browser tabs (an admin editing the same class in two windows) would otherwise silently create duplicate records. |
| 10 | A fee structure is publicly visible only if it is `PUBLISHED` **and** its institution passes the same visibility gate the profile and results endpoints use. | Identical to Results decision 4, for the identical reason: otherwise fee data becomes reachable on an institution whose profile returns 404 — an inconsistency no consumer can reason about, and a residual public surface for a suspended institution. |

---

## 3. Architecture

```
                    Institution  ◀── the master record (Phase 1)
                    institutionId: INS0001
                           │
        ┌──────────────────┼──────────────────┬──────────────────┐
        │                  │                  │                  │
     Profile          Lead Network         Results          Fee Structure  ◀── Phase 4
   identity           enquiries          exam cycles         per class/course
   contact            applications       aggregates          per academic year
   address            assignment         score bands         itemized lines
   academic           follow-up          toppers             publish state
   ...                staff              publish state
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

Identical to every prior phase, and non-negotiable:

- **Route** — auth, CSRF, Zod parse, envelope. Never touches storage or the database
  directly.
- **Service** — all database access. `FeeStructureService` is the only module that reads
  or writes the `feestructures` collection.
- **Projection** — `toPublicFeeStructure()` is the sole path from a stored document to a
  public response.

---

## 4. Data model

New collection: `feestructures`.

### 4.1 Identity

| Field | Type | Notes |
|---|---|---|
| `institutionId` | String, required, indexed | `INS0001`. Matches `Lead`, `Application`, `Result`. |
| `classOrCourse` | String, required, ≤120 | Free text — see decisions 2–3. `"Grade 10"`, `"B.Tech CSE"`. |
| `academicYear` | String, required, ≤20 | `2026-27`. Same format as `Result.academicYear`. |

**Uniqueness:** one record per `(institutionId, classOrCourse, academicYear)`.
`classOrCourse` is compared exactly as stored — no case-folding or trimming beyond the
standard `trim()` every free-text field on this platform already gets. Two institutions
entering `"Grade 10"` and `"grade 10"` get two records; this is accepted, matching how
free-text fields behave everywhere else on the platform, and is a dashboard UX concern
(§10.3's suggestion list), not a data-integrity one.

### 4.2 Line items

`lineItems: [FeeLineItemSchema]`, `{_id: false}`, max 20 entries, min 1 to publish (§5).

| Field | Type | Notes |
|---|---|---|
| `label` | String, required, ≤60 | `Tuition`, `Admission Fee`, `Transport`, `Lab Fee`. |
| `amount` | Number, ≥ 0, required | INR. No currency field — see "What Phase 4 is not." |
| `frequency` | enum `FEE_FREQUENCIES`, required | `ONE_TIME` \| `ANNUAL`. See decision 5. |
| `optional` | Boolean, default `false` | `true` for a line item not every family pays — e.g. Transport. |

No two line items in the same fee structure may share the same `label` — validated at
write time (§5), so a structure never carries two ambiguous "Tuition" rows.

### 4.3 Lifecycle

| Field | Type | Notes |
|---|---|---|
| `status` | enum `FEE_STRUCTURE_STATUSES`, default `DRAFT` | `DRAFT` / `PUBLISHED` / `ARCHIVED`. |
| `publishedAt` | Date, optional | Set on the **first** transition to `PUBLISHED`, retained thereafter — records when the institution first made this fee structure public, not when it was last edited. Unpublishing does not clear it. Identical semantics to `Result.publishedAt`. |
| `createdAt` / `updatedAt` | Date | Mongoose timestamps. |

Per-record status, deliberately — the same reasoning as Results decision on per-cycle
status: an institution may publish Class 10's fees before it has finalized Class 12's.

**`ARCHIVED` versus deletion.** Identical distinction to Results §4.5: `ARCHIVED` retains
the record and removes it from public output — the reversible way to retire a year's fee
structure once superseded. `DELETE` is permanent removal of the document. Fee structures
own no external storage (no photos, unlike Results' toppers), so deletion has no storage
cleanup step.

### 4.4 Constants

Declared in `src/lib/constants.ts`, following the existing tuple → derived type → labels
map pattern already used for every other enum on this platform:

```
FEE_FREQUENCIES          ONE_TIME, ANNUAL
FEE_STRUCTURE_STATUSES   DRAFT, PUBLISHED, ARCHIVED
```

Each gets a `*_LABELS` map, since both are rendered in the UI.

### 4.5 Indexes

```
{ institutionId: 1, createdAt: -1 }                                dashboard list
{ institutionId: 1, status: 1, academicYear: -1 }                  public read
{ institutionId: 1, classOrCourse: 1, academicYear: 1 }  unique    fee-structure identity
```

No reserved-for-later index is added here — unlike Results, there is no known future
cross-institution discovery consumer for fee data (see §11).

---

## 5. Validation

Enforced in `src/lib/validation/fee-structure.ts` with Zod, mirroring
`src/lib/validation/result.ts`.

**Always enforced, on every write:**

- every `lineItems[].amount ≥ 0`
- no two `lineItems[].label` values are equal (case-sensitive exact match, matching
  §4.1's `classOrCourse` uniqueness stance)
- `lineItems.length ≤ 20`

**Additionally enforced at publish time:**

- `lineItems.length ≥ 1` — an empty fee structure cannot be published

A draft may be saved with zero line items, mid-entry. Publishing is the gate. This
mirrors every prior phase: a record can be an incomplete draft, but publishing applies
stricter rules.

---

## 6. API surface

### 6.1 Institute admin — own institution

Cookie session + CSRF (`assertSameOrigin` + `requireInstitution`), never bearer — same
boundary as Results and Staff.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/settings/fees` | List this institution's fee structures. |
| `POST` | `/api/settings/fees` | Create one. 409 on duplicate `(classOrCourse, academicYear)`. |
| `GET` | `/api/settings/fees/:feeId` | Read one. |
| `PATCH` | `/api/settings/fees/:feeId` | Update `classOrCourse`, `academicYear`, `lineItems`. |
| `DELETE` | `/api/settings/fees/:feeId` | Permanent delete. |
| `POST` | `/api/settings/fees/:feeId/publish` | `{ action: "publish" \| "unpublish" \| "archive" }` — same three-action shape Results' publish route already settled on. |

Every handler follows the established shape:
`try { assertSameOrigin → requireInstitution → validate → service → jsonSuccess } catch { handleApiError }`.

### 6.2 Platform admin

**None.** Same boundary as every tenant-data module on this platform — enforced by
construction, no route exists to check against.

### 6.3 Public — credential-free

| Method | Path |
|---|---|
| `GET` | `/api/public/:institutionId/fees` |
| `GET` | `/api/public/institutions/:slug/fees` |

Both mirror the Results public endpoints exactly:

- No credentials. `security: []`.
- `Cache-Control: public, max-age=300` — same as profile and results.
- IP-keyed rate limiting via the existing, shared `PUBLIC_READ_RATE_LIMIT` (60/min) —
  reused, not a new bucket.
- **404-never-403.** A draft fee structure, an archived one, and one belonging to a
  suspended institution are indistinguishable to a caller — identical rule to every
  other public endpoint on this platform.
- `OPTIONS` returns `publicCorsPreflight()`.

Optional filter: `?academicYear=`. Absent, returns all published fee structures for the
institution, newest academic year first, all classes/courses.

### 6.4 OpenAPI

`src/lib/api/openapi.ts` gains both public paths under the existing `Website` tag, and a
`PublicFeeStructureResponse` schema, matching how Results' public paths were documented.

---

## 7. Authorization

| Actor | Read own fees | Write own fees | Read published fees | Read other institutions |
|---|---|---|---|---|
| Institute admin | yes | yes | yes | **no** |
| Counselor / Front Desk | **no** | **no** | yes (as any public caller) | yes, published only |
| Platform admin | **no** | **no** | yes (as any public caller) | **no** |
| API client (bearer) | **no** — not in this phase | **no** | yes | **no** |
| Anonymous public | — | — | yes | yes, published only |

Every institute-admin route resolves the institution from the session via
`requireInstitution()` and scopes the query by that `institutionId`. A `feeId` from
another tenant returns **404, not 403** — the platform-wide rule.

---

## 8. Public projection

`src/lib/fee-structure/public-projection.ts` exports `toPublicFeeStructure()`. It is the
**sole** path from a stored fee-structure document to a public API response.

Built field-by-field, never a spread, never a deny-list — identical discipline to
`toPublicResult()`. A test asserts the exact set of emitted keys, so a field added to the
schema fails that test until someone deliberately decides whether it is public.

The one rule the projection enforces, and the only place it is enforced:

1. **Only `PUBLISHED` fee structures are ever projected.** Callers pass filtered input,
   but the projection re-checks — defence in depth, matching every other public
   projection on this platform.

Emitted: `classOrCourse`, `academicYear`, `lineItems` (`label`, `amount`, `frequency`,
`optional`), `publishedAt`.

Never emitted: `_id`, `institutionId`, `status`, `createdAt`/`updatedAt`.

---

## 9. Dashboard

### 9.1 Navigation

One item added to `INSTITUTION_NAV` in `src/components/dashboard/nav-config.ts`,
`adminOnly: true`, in the second group alongside Staff/Profile/Integration/Settings —
matching Results' exact nav entry (`adminOnly: true`), not the first group's
Dashboard/Enquiries/Applications. §7's Counselor/Front-Desk "read published fees" row is
satisfied entirely through the anonymous public endpoint (§6.3), not an authenticated
dashboard route — there is no `/fees` page for either role to usefully land on, so
hiding the nav item for them is correct, not a workaround.

```
Dashboard · Enquiries · Applications · Results
Staff · Institution Profile · Integration · Settings · Fees
```

Nothing is added to `SUPER_ADMIN_NAV`.

### 9.2 Fee structures list — `/fees`

A table of fee structures: class/course, academic year, total (sum of `lineItems[].amount`
where `frequency: "ANNUAL"`, shown as a quick-glance figure, not a stored field), status
chip, last updated. Sorted newest academic year first, then class/course alphabetically.
Empty state invites the first entry.

### 9.3 Fee structure editor — `/fees/[feeId]`

One page, two sections:

- **Identity** — class/course (a plain text input; if `Institution.classesOffered` is
  populated, the input suggests from that list via a datalist/combobox, but accepts any
  value — see decision 3), academic year.
- **Line items** — repeatable rows: label, amount, frequency (one-time/annual toggle),
  optional checkbox. Add/remove rows. A running total is shown, split by "required" and
  "optional" so the editor can see at a glance what a family's mandatory annual cost is
  versus what's opt-in.

Archive/delete controls mirror `ArchiveDeleteControl` from the results editor exactly —
same component shape, same confirmation-dialog pattern, reused rather than re-invented.

Publish/unpublish is a dialog naming exactly what will become public — mirroring every
prior phase's publish dialog, which enumerates the public leaf fields.

---

## 10. Future extensibility

**Counselor/Front-Desk write access.** If it turns out front desk staff need to correct
fee typos or add a new course's pricing without going through an admin, that is a
`ROLE_PERMISSIONS` table addition (`FEES_UPDATE` or similar) — additive, no schema
change. Deliberately not built now; see decision 8.

**Payment collection.** Should this platform ever take on dues tracking or payment
collection, the fee structure this phase builds is the natural source of truth for "what
should this student be charged" — but that is a distinct module with its own spec, its
own compliance posture, and almost certainly a payments provider integration, not an
extension of this one.

---

## 11. Migration

**None required.** This phase adds a new collection and touches no existing document.

- No backfill. Institutions simply have no fee structures until they enter one.
- No change to `Institution`, `Lead`, `Application`, `Result`, `User`, or any existing
  schema.
- No change to any prior phase's public projection, dashboard, or tests.
- Deploy order is irrelevant; the new routes are inert until an institution creates a
  fee structure.

---

## 12. Testing

Mirroring every prior phase's split between `tests/unit` (pure, no DB) and
`tests/integration` (real Mongo via `mongodb-memory-server`).

**Unit**

- `fee-structure-projection.test.ts` — exhaustive-key assertion; draft never projected;
  archived never projected.
- `fee-structure-validation.test.ts` — every invariant in §5, each asserted to *fail* on
  violation: negative amount, duplicate label, more than 20 line items, publish blocked
  with zero line items.
- `openapi-fee-structure.test.ts` — both public paths present, `security: []`.

**Integration**

- `fee-structure-crud.test.ts` — create, read, update, delete; duplicate
  `(classOrCourse, academicYear)` returns 409 via the unique index, not a pre-read.
- `fee-structure-publish.test.ts` — publish sets `publishedAt`; unpublish preserves data;
  archive removes from public output while retaining the record; publish rejected with
  zero line items.
- `fee-structure-tenant-isolation.test.ts` — a `feeId` from another tenant returns 404,
  not 403, on every institute-admin route.
- `fee-structure-public.test.ts` — published fee structure returns 200 by both id and
  slug; draft returns 404; archived returns 404; a fee structure on a suspended
  institution returns 404; `?academicYear=` filters correctly and an unknown value
  returns an empty list rather than an error; rate limit trips; `Cache-Control` header
  correct.
- `fee-structure-routes-permissions.test.ts` — a Counselor and a Front Desk session both
  403 on every `/api/settings/fees*` route. §7's "read" row for these two roles is the
  *public* endpoint, which needs no session at all — there is no institute-admin read
  route granted to them to test the success path of, so this file's job is purely to
  prove the write boundary, matching the role-boundary regression test pattern Lead
  Follow-up's Task 13 established.

**Method.** Every guard is verified by mutation: remove the guard, confirm the test
fails, restore it. A test that passes with its guard deleted is not evidence of anything.

---

## 13. Definition of done

- All tests green, and the pre-existing suite (496 as of the close-phase-gaps merge)
  still green.
- `npx tsc --noEmit` clean; lint clean.
- Every invariant in §5 has a test that fails when its guard is removed.
- The projection's exhaustive-key test fails when a field is added to the schema.
- A published fee structure is readable by `curl` with no credentials, by both id and
  slug.
- A draft fee structure, and a published one on a suspended institution, both return 404.
- The platform admin has no route to fee structures — verified by absence, and by a test
  asserting a `SUPER_ADMIN` session is rejected on the institute-admin routes.
- A Counselor and a Front Desk session are both rejected on every write route, verified
  by mutation (remove the check, confirm the test that currently expects 403 now sees
  200 or a write actually landing).
- OpenAPI documents both public paths.

---

## 14. Known limitations

Recorded honestly, matching every prior phase:

- **No revision history.** Correcting a published fee structure overwrites it; only the
  existing `Activity` log records that a change occurred, the same gap Results §15
  records.
- **No effective-dating.** A fee change goes live the moment it's published — no
  "publish now, take effect on a future date."
- **No per-student assignment, discount, or waiver tracking.** Out of scope per §1.
- **No payment collection.** Out of scope per §1 and §10.
- **No bulk import.** An institution with several classes/courses enters each by hand.
- **Duplicate `classOrCourse` spellings across records are possible** (`"Grade 10"` vs
  `"grade 10"`) — accepted per decision/§4.1, a dashboard UX concern rather than a
  data-integrity one.

---

## 15. Recommended Phase 5

Not named yet, matching the discipline every prior phase's closing section has followed:
guessing at a phase nobody has asked for produces work that has to be redone. The two
plausible near-term candidates, neither committed to:

- **Counselor/Front-Desk read (or write) access to fees**, if it turns out front desk
  staff are fielding fee questions by phone often enough that "look it up in the
  dashboard" beats "check the public page like anyone else." See §10.
- **Self-service lead claiming**, still on the table from Lead Follow-up §9 — unrelated
  to this phase, carried forward because nothing since has resolved it either way.

Both should come from what actually turns out to hurt once this phase and Lead
Follow-up are in real use, not from guessing now.
