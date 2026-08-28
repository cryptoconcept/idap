# eduFleet Vacancies — Design Spec

**Date: 2026-08-28.** Approved approach: **A — explicit per-vacancy publish
with sync state tracked.**

**Reconnaissance source (binding):** `docs/integrations/edufleet-api-map.md`
(2026-08-28), read from `/Users/automicai/edufleet-exchange`. Where this spec
and that map disagree about eduFleet's behaviour, **the map wins** — and where
the map and eduFleet's live source disagree, the source wins and both documents
get corrected. That repository is **READ-ONLY**.

## 1. What this builds

Schools post teacher openings in IDAP, and a connector pushes them to eduFleet
Exchange as job listings. Two halves:

1. **A Vacancy domain in IDAP** — the thing that does not exist today. Of
   everything eduFleet's job contract wants, only `institutionName`, `city`,
   `district`, `taluk` and `state` have a source in IDAP (all on
   `Institution`). Every field that *defines* a vacancy has no home at all.
2. **An eduFleet connector** — platform credential, per-school connection with
   the request/approve/redeem lifecycle, and a per-vacancy push.

## 2. Why a real domain rather than a push form

The alternative — a thin form that composes an eduFleet request and stores
nothing — was rejected for three reasons, each independently sufficient:

- Nothing to `PATCH` against later, so a school could never correct or close a
  vacancy it had posted.
- The 409-reconciliation rule is unimplementable without IDAP holding the
  `externalJobId`.
- A partner-pushed listing is publicly visible immediately; a school that
  cannot see what it published cannot be responsible for it.

## 3. Scope

**In:** the Vacancy model, its service, routes and dashboard section; the
eduFleet adapter and its pure mapping module; the connection lifecycle; the
push, its state tracking and its failure surfaces.

**Out, and why:**

- **Applications and candidates.** eduFleet's model is direct contact between
  school and teacher. IDAP holds the opening, never the pipeline.
- **Vehicles and used items.** They have **no partner API surface of any
  kind** — session-only Server Actions — and used items are additionally
  feature-flagged off inside eduFleet. This is a gap on eduFleet's side, not
  IDAP's; nothing IDAP builds can carry them until a partner surface exists.
- **Pulling anything back from eduFleet** beyond what a push response returns.
  No teacher browsing, no match data.

## 4. The Vacancy domain

New per-institution collection `Vacancy`, following `Result.ts`'s precedent:
`institutionId` as a **String tenant key, indexed — not an ObjectId ref**,
matching every other per-institution collection here.

```
institutionId       String, required, indexed
title               String, required, trim, ≤120
subject             VACANCY_SUBJECTS, required
description         String, required, trim, ≤2000
salaryMin           Number, optional      // monthly rupees
salaryMax           Number, optional      // monthly rupees
experienceRequired  Number, optional      // years, defaults 0 at the boundary
facilities          [String], optional    // VACANCY_BENEFITS values
status              VACANCY_STATUSES, default "DRAFT"
listing             ListingState, optional  // §7
```

Indexes: `{institutionId: 1, createdAt: -1}` and
`{institutionId: 1, status: 1}`.

`VACANCY_STATUSES = ["DRAFT", "OPEN", "FILLED", "CLOSED"]`. `DRAFT` is the
default and is never pushed. Location is **not** stored per vacancy — it is
read from the `Institution` row at push time, so a school that corrects its
city does not have to correct every open vacancy.

**Guard optional numerics with `!= null`, never `?? 0`** — `salaryMin: 0` is a
meaningful value and `?? 0` would erase the distinction between "free" and
"unstated".

## 5. Reference data, and why it is transcribed

eduFleet constrains two fields to fixed vocabularies:

- **16 subjects** in three groups — academic (Mathematics, Physics, Chemistry,
  Biology, English, Kannada, Hindi, Social Science), administration (Principal,
  Vice Principal, Coordinator, Administrator), support (Accountant, Clerk,
  Driver, Librarian). Matched by **exact string**, not fuzzily.
- **11 benefits**, sent as literal label strings: Provident Fund (PF), ESI
  (medical insurance), Gratuity, Health insurance, Staff accommodation,
  Transport / bus facility, Free / subsidised meals, Paid leave, Annual /
  festival bonus, Training & development, Maternity benefits.

Both are **transcribed into `src/lib/constants.ts` as `VACANCY_SUBJECTS` and
`VACANCY_BENEFITS`, with a parity test asserting the literal lists**, exactly
as the facilities vocabulary was handled for PassPercent. A runtime fetch from
`/partner/contract` would make creating a vacancy in IDAP depend on eduFleet
being reachable, which is the wrong coupling for a domain schools own.

The parity test **must not read eduFleet's repository at runtime** — it is a
sibling checkout absent on CI, so such a test errors on a missing path rather
than comparing. Transcribe, and cite the source path in a comment.

### 5.1 The silent-drop hazard

`sanitizeFacilities()` on eduFleet's side **silently discards** any benefit
string not on its list and de-duplicates the rest. It is **not** a validation
error — eduFleet will never tell IDAP that something was dropped.

So IDAP validates `facilities[]` against `VACANCY_BENEFITS` **before** pushing
and refuses to push an unrecognised value, rather than letting eduFleet quietly
swallow it. A school that lists a benefit and finds it silently missing from
the public listing has been misled by IDAP, not by eduFleet.

## 6. Which contract each push uses

IDAP calls **both**, chosen per push: **the school's grant when a live
connection exists, the platform key otherwise.** This is dictated by the
contract, not preference.

| | Platform key (Contract One) | School grant (Contract Two) |
|---|---|---|
| `institutionName` | **required** | not accepted |
| Location | `city` **required** | `city` **or** `branchId` — or the write 400s |
| `district`/`taluk`/`state` | optional, Karnataka-validated | not accepted |
| `sourceUrl` | accepted | not accepted |
| Resulting `origin` | `aggregated` | `school_posted` |
| Claimable by the school | **yes** | no — already owned |
| School's plan cap applies | no | **yes** — free plan caps active jobs |

Two consequences that must be visible in the UI rather than discovered:

- **A school connecting later does not retroactively own its earlier
  listings.** Those were pushed as `aggregated` and must be claimed.
- **A grant push can fail with `403 upgrade_required`** when the school's
  eduFleet plan has no active-job slots left. IDAP surfaces that as "your
  eduFleet plan has no room for another live listing", never as a generic
  failure.

**The location requirement is undocumented in eduFleet's own machine-readable
schema.** `partnerSchema()` omits that a grant push needs `city` or
`branchId`. Building from the self-describing contract alone yields a connector
that 400s. IDAP always sends `city` from the `Institution` row.

## 7. Push lifecycle and listing state

`externalJobId` is **IDAP's vacancy id**, stable for the vacancy's lifetime.

Per vacancy IDAP stores a `listing` block: the eduFleet `jobId`, which contract
created it (`AGGREGATED` | `SCHOOL_POSTED`), the last push time, and a
`claimed` flag.

- **Publish** is explicit — a school action on an `OPEN` vacancy, never
  automatic on save. A partner-pushed listing is publicly visible the instant
  it is created; auto-publishing a half-written vacancy to a public jobs board
  is the wrong default.
- **Edit** after publish issues a `PATCH`.
- **`FILLED` or `CLOSED` in IDAP** pushes `status: "closed"`. Note Contract
  Two's PATCH accepts only `"closed"` — a school-posted listing cannot be
  reopened through the partner API, so reopening a filled vacancy in IDAP
  creates a **new** listing rather than reviving the old one.

### 7.1 The claim transition is a one-way door

A school may claim an `aggregated` listing in eduFleet. Once claimed, IDAP's
platform key **can no longer edit it** — further writes return
`403 claimed`.

IDAP records the claim and renders that vacancy **read-only with a visible
reason**, rather than letting an admin edit a field and meet a 403. This is the
single irreversible transition in the contract and the main reason approach A
was chosen over auto-sync.

### 7.2 The shared id-space

`externalJobId` uniqueness is `(partnerId, externalJobId)` and **shared across
both contracts** — the same id cannot exist once under each. On a `409`, IDAP
**trusts the response's `contract` field over its own assumption** about which
endpoint owns the row, because a collision raised by the other contract will
404 against the endpoint IDAP would otherwise retry.

## 8. The adapter

**The connection half fits the existing framework almost mechanically.**
eduFleet is `connectMode: "REQUEST_APPROVE_REDEEM"` — the mode PassPercent
already uses. `initiate()` maps onto `POST /partner/connection-requests`, and
eduFleet's `duplicate_open_request` 409 has the same "adopt and continue" shape
IDAP already implements. `refresh()`'s status switch maps one-to-one onto
eduFleet's five states.

Credentials: `ef_pkey_` platform key in the existing vault; `ef_pgrant_` school
grant on `PlatformConnection`. `PLATFORMS` gains `"EDUFLEET"`.

Two known frictions, recorded so they are not rediscovered:

- **`remoteInstitution.slug` can never be populated.** eduFleet's `School` has
  no slug field at all. It stays `undefined` permanently.
- **Name and city require a follow-up call.** The redeem response carries
  neither; `GET /partner/school` with the fresh grant is the only source.

**The payload half needs a new adapter method, not an extension of
`SyncSourceData`.** That type is Result-centric by construction — built for
PassPercent's periodic exam-results push. Vacancies are per-record CRUD keyed
on an external id, with 409 reconciliation and claim semantics. Forcing them
through `SyncSourceData` would distort the interface for every future adapter.

## 9. Error handling

Every eduFleet failure reason maps to an IDAP-side outcome that tells the
school what to do. `upgrade_required` → the plan message in §6.
`claimed` → mark the vacancy read-only (§7.1). `revoked` → the school
disconnected on eduFleet's side; the connection is marked disconnected and
future pushes fall back to the platform key. `validation_failed` → surface
`details[]` rather than a generic message.

## 10. Visibility and consent

A vacancy is only ever pushed by an explicit school action. The publish
confirmation states plainly that the listing becomes **publicly visible
immediately on eduFleet** and, when pushed under the platform key, that the
school may claim it there.

`publish-dialog.tsx`'s `GOES_PUBLIC` list is IDAP's consent surface and its own
docblock claims it lists exactly what leaves. Vacancies are pushed to a third
party rather than served on IDAP's public profile, so they are a **separate
disclosure** at the point of publishing, not an addition to that list.

## 11. Testing

- **Tenant scoping is absolute**, mutation-checked per service method, with the
  other institution's record asserted byte-for-byte unchanged — not merely that
  a call threw. A correctly-scoped query that finds nothing throws the same
  error as a broken filter.
- The subject and benefit parity tests, per §5.
- The unrecognised-benefit refusal, per §5.1.
- The 409 `contract`-field reconciliation, per §7.2 — including that IDAP does
  **not** retry against its own endpoint when the other contract owns the row.
- Claim → read-only, per §7.1.
- A test must FAIL when the behaviour it guards is removed.

## 12. Open questions, deliberately not decided here

- **Whether IDAP should push at all for a school with no eduFleet connection.**
  Doing so creates a claimable aggregated listing the school has not asked for.
  The alternative is requiring a connection first, which is a smaller product
  but a slower start. Decide before the plan.
- **Whether a `FILLED` vacancy should auto-close its listing** or wait for an
  explicit action.
