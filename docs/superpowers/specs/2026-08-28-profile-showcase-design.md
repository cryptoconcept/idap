# Profile showcase — Achievements, Notable Alumni, Facilities alignment

**Status:** approved for planning
**Date:** 2026-08-28
**Reconnaissance source (binding for shape parity):** PassPercent's live models at
`/Users/automicai/Documents/GitHub/passpercent/backend/src/` — read directly, not from docs.

## 1. Goal

Give an institution three showcase surfaces beyond its core profile: what it has
won (**Achievements**), who it produced (**Notable Alumni**), and what it offers
(**Facilities**, already present but misaligned).

The binding constraint, set by the user: **shape these to match PassPercent's own
models**, so a school managing this data in IDAP maps cleanly onto what
PassPercent expects — even though no partner push exists for it yet.

## 2. What already exists

| Thing | State |
|---|---|
| `Institution.facilities[]` | `FacilitySchema`: `code` (required, uppercase), `label` (required), `available` (default true), `note`. Embedded, `_id: false`. |
| `FACILITY_SUGGESTIONS` | `src/lib/profile/facilities.ts` — 11 uppercase codes. A convenience list only: **the validation schema accepts any code**, so widening it needs no migration of the schema itself. |
| `facilities-section.tsx` | Working profile-editor section. |
| Achievements / Alumni | **Do not exist anywhere in IDAP.** |
| Per-institution collection precedent | `src/models/Result.ts` — `institutionId: String` indexed, `status` enum defaulting to `DRAFT`, compound indexes led by `institutionId`. |
| Media visibility precedent | `MEDIA_STATUSES = ["ACTIVE", "HIDDEN"]`, `HIDDEN` excluded from every outbound surface. |
| Media storage precedent | `storage.putPublic` under `media/{institutionId}/…`, magic-byte validation, per-kind caps, blob rollback on a rejected write. |

## 3. The partner-push finding (why this is IDAP-only for now)

PassPercent **has** all three concepts — `routes/achievements.js`, `routes/alumni.js`,
`routes/awards.js`. But their auth is `authenticate` + `requireRole('institution')`:
**session-cookie portal routes with no `requireGrant` or `requirePlatformKey`.**

So they are not on the partner API, and IDAP cannot push them today. This is the
same shape as FeesBasket's offers (`feesbasket-api-map.md`). Matching their models
now is what makes a future push a mapping exercise rather than a redesign.

**Consequence for scope:** these three surfaces are dashboard + IDAP's public API
only. No adapter, no mapping function, no `deletes` semantics. Designing a mapping
against a contract that does not exist is the guessed-field mistake that already
cost this project a fix round.

## 4. Facilities — realign the vocabulary

IDAP's structure is already a **superset** of PassPercent's (`{code,label,available,note}`
vs a plain `[String]` of keys), so nothing structural changes. The mismatch is the
code vocabulary.

### 4.1 The mapping

| IDAP today | PassPercent key | Action |
|---|---|---|
| `LIBRARY` | `library` | direct |
| `SCIENCE_LAB` | `science_lab` | direct |
| `COMPUTER_LAB` | `computer_lab` | direct |
| `PLAYGROUND` | `playground` | direct |
| `AUDITORIUM` | `auditorium` | direct |
| `TRANSPORT` | `transport` | direct |
| `CAFETERIA` | `cafeteria` | direct |
| `SMART_CLASSROOM` | `smart_classes` | rename |
| `DIGITAL_LEARNING` | `digital_library` | rename (closest equivalent) |
| `HOSTEL` | `boys_hostel` **and** `girls_hostel` | **splits — see §4.3** |
| `SPORTS` | (none — they enumerate specific sports) | **see §4.3** |

### 4.2 The full vocabulary IDAP adopts

Canonical keys, lowercase snake_case, taken verbatim from PassPercent's
`utils/facilities.js` (38 keys):

`ac_classrooms · art · athletics · auditorium · basketball · boys_hostel ·
cafeteria · cctv · computer_lab · counselor · cricket · dance · day_boarding ·
debate · digital_library · drama · fire_safety · girls_hostel · gps_buses · gym ·
indoor_games · language_lab · library · meals · medical_room · music · playground ·
power_backup · ramp_access · robotics · science_lab · security_guards ·
smart_classes · swimming · transport · visitor_check · wifi · yoga`

This roughly triples what a school can declare, which is a user-facing improvement
independent of the parity goal.

### 4.3 The two lossy cases, and how the migration handles them

Both are cases where IDAP's code carries **less** information than PassPercent's
vocabulary needs, so no automatic conversion is honest.

- **`HOSTEL`** — IDAP does not record which genders are accommodated. Converting it
  to `boys_hostel`, `girls_hostel`, or both would fabricate a fact the institution
  never stated.
- **`SPORTS`** — a category, not a facility. Expanding it into specific sports would
  invent claims.

**Rule: convert what maps, and report the rest — never guess.** The migration
converts the nine mappable codes, leaves `HOSTEL` and `SPORTS` rows **in place
unchanged**, and prints them per institution so an admin re-picks deliberately. The
UI surfaces them as needing attention rather than silently dropping them.

This mirrors the media migration's refuse-don't-truncate rule: a migration that
silently reinterprets data is unrecoverable, because nobody knows what was
changed.

### 4.4 Migration

`scripts/migrate-facility-codes.ts`, run as `npm run migrate:facility-codes`,
following `scripts/sync-fee-indexes.ts`'s conventions (dry-run by default,
`--apply` to write).

- Rewrites the nine direct/rename codes on `Institution.facilities[].code`.
- Leaves `HOSTEL`/`SPORTS` untouched and reports them: institutionId, code, label.
- Idempotent: an institution whose codes are already lowercase is skipped.
- Preserves `label`, `available` and `note` on every converted row.

## 5. Achievements

New collection `Achievement`, mirroring PassPercent's `models/Achievement.js`.

```
institutionId  String, required, indexed          // IDAP's tenant key, not an ObjectId ref
category       ACHIEVEMENT_CATEGORIES, required
title          String, required, trim, ≤120
description    String, trim, ≤2000
eventDate      Date
level          ACHIEVEMENT_LEVELS, default "school"
students       [{ name: String req ≤100, grade: String ≤20 }]
photos         [String]                            // storage keys, see §7
certificates   [String]                            // storage keys, see §7
status         SHOWCASE_STATUSES, default "ACTIVE"
```

New constants:

```
ACHIEVEMENT_CATEGORIES = ["ACADEMIC","SPORTS","CULTURAL","OLYMPIAD","SCIENCE_FAIR","ROBOTICS","COMMUNITY_SERVICE"]
ACHIEVEMENT_LEVELS     = ["SCHOOL","TALUK","DISTRICT","STATE","NATIONAL","INTERNATIONAL"]
```

**On casing:** IDAP's house style is uppercase enum constants (`RESULT_STATUSES`,
`MEDIA_KINDS`); PassPercent's are lowercase. IDAP keeps its own convention
internally, and the value-level translation is a lowercasing map at whatever
future push exists. The *members* match one-for-one, which is what parity requires
— matching their casing would break IDAP's own consistency for no gain.

Indexes, following `Result.ts`: `{institutionId: 1, createdAt: -1}` and
`{institutionId: 1, status: 1, category: 1}`.

## 6. Notable Alumni

New collection `Alumnus`, mirroring PassPercent's `models/NotableAlumni.js`.

```
institutionId  String, required, indexed
name           String, required, trim, ≤100
batch          String, trim, ≤20                   // free text: "2015" or "2012-2015"
category       ALUMNI_CATEGORIES, required
currentRole    String, trim, ≤120
org            String, trim, ≤120
photo          String                               // storage key, see §7
note           String, trim, ≤500
status         SHOWCASE_STATUSES, default "ACTIVE"
```

```
ALUMNI_CATEGORIES = ["DOCTOR","ENGINEER","ENTREPRENEUR","CIVIL_SERVICES","SCIENTIST","ARTIST","SPORTS","OTHER"]
```

`batch` stays free text deliberately — PassPercent models it that way, and a school
describing a cohort as "2012-2015" is not an error to be normalised away.

Indexes: `{institutionId: 1, createdAt: -1}` and `{institutionId: 1, status: 1, category: 1}`.

## 7. Photos and certificates

Both domains reuse the media phase's storage path exactly — no new mechanism.

- Stored via `storage.putPublic` under `showcase/{institutionId}/{achievements|alumni}/{objectId}{ext}`.
- Images validated by magic bytes, not the client-supplied content type.
- Certificates additionally accept PDF, validated by the `%PDF-` prefix the media
  phase already checks for.
- Caps: 10 photos + 5 certificates per achievement; 1 photo per alumnus.
- Enforced atomically **inside the update filter** with the `$expr`/`$size` pattern
  `addMediaImage` uses, with `storage.deletePublic` rollback when the filter
  rejects — otherwise a refused upload orphans a stored file.
- Deleting a record deletes its stored objects, mirroring `deleteOwnedPhoto`.

## 8. Visibility — IDAP's pattern, not PassPercent's

PassPercent's models carry `status: pending/approved/rejected`, `reviewedBy`,
`reviewedAt`, `rejectReason`. That is **PassPercent moderating submissions from
schools**, which is a relationship IDAP does not have with its own tenants — IDAP
is the source of truth.

So IDAP uses its own established visibility shape:

```
SHOWCASE_STATUSES = ["ACTIVE", "HIDDEN"]
```

`HIDDEN` records are manageable in the dashboard and **never appear on any
outbound surface**, exactly as `HIDDEN` media behaves. If a future push to
PassPercent exists, their moderation applies on their side to what IDAP sends;
IDAP does not model their workflow.

## 9. Services and routes

Two services following `ResultService`'s shape, both `institutionId`-scoped on
every read and write:

- `AchievementService` — `list`, `create`, `update`, `remove`, `addPhoto`, `addCertificate`, `removeAsset`
- `AlumniService` — `list`, `create`, `update`, `remove`, `setPhoto`

Routes under `src/app/api/settings/achievements/` and `.../alumni/`, thin wrappers
in the house pattern: `assertSameOrigin` → `requireInstitution` → validate →
service → `handleApiError`. Multipart upload routes follow the media routes'
`target`/`kind` precedent.

## 10. Public API

Both join the existing public profile response at
`/api/public/[institutionId]/profile`, alongside `media`:

```
achievements: [{ id, category, title, description, eventDate, level, students, photos, certificates }]
alumni:       [{ id, name, batch, category, currentRole, org, photo, note }]
```

- **`ACTIVE` only.** `HIDDEN` never leaves.
- Sorted: achievements by `eventDate` descending then `createdAt`; alumni by
  `batch` descending then `name`.
- Asset URLs absolute via `toPublicUrl` (`src/lib/media/public-url.ts`).
- `assertExternallyReachable` is **not** called here — it guards outbound partner
  pushes only, and there is no push for these. Calling it would break local
  development for no benefit.
- Empty arrays, never `undefined`.

## 11. Dashboard

Two new profile sections beside the existing ones, plus the facilities section
gaining the widened vocabulary and an "unmapped code" notice for `HOSTEL`/`SPORTS`
rows the migration left alone.

Both new sections follow `media-section.tsx`: list, create/edit dialog, per-record
photo upload, hide/show, delete behind the confirm-dialog pattern, and add-controls
disabled with a visible reason when a cap is reached.

Navigation: both live under the **Academics** group added in `8181f00`.

## 12. Testing

- Migration: the nine conversions; `HOSTEL`/`SPORTS` left untouched **and reported**
  (mutation-checked — make it convert them and confirm that test fails); idempotence;
  dry-run writes nothing.
- Magic-byte rejection for both images and certificate PDFs, asserting the storage
  adapter was **never invoked** on rejection rather than only that it threw.
- Per-record caps, discriminating: fill one record's photos to its cap and assert a
  **different** record still accepts one — the assertion must exercise the same
  method whose filter is mutated.
- Tenant isolation on **every** service method, each mutation-checked by removing
  its `institutionId` and asserting the other institution's record is byte-for-byte
  unchanged — not merely that an error was thrown.
- Public API excludes `HIDDEN` for both domains, mutation-checked.
- Enum parity: a test asserting IDAP's category/level members map one-for-one onto
  PassPercent's lists, so a future divergence is caught here rather than at push time.

## 13. Out of scope

- Any partner push, adapter, or mapping function for these three domains (§3).
- PassPercent's moderation workflow (§8).
- Achievement `students` linking to real student records — free text, as theirs is.
- Awards (their `AwardCycle`/`AwardNomination`) — a platform-run awards programme,
  not institution-owned content.

## 14. Global constraints

- Tenant scoping absolute: every read and write `institutionId`-scoped.
- Never silently reinterpret existing data; report and refuse (§4.3).
- Guard optional numerics with `!= null`, never `?? 0`.
- `npx tsc --noEmit` 0 errors; `npx eslint src` exactly 0 errors / 7 warnings.
- Test factories are positional: `makeInstitution(institutionId, overrides)`.
- Integration tests need `clearDatabase`/`startTestDatabase`/`stopTestDatabase`
  from `../helpers/db`; without them a model call hangs until a 10s
  "buffering timed out" that reads like a code bug and is not one.
- Playwright at `/Users/automicai/VVOGI/node_modules/playwright` (absolute path).
- Never kill a dev server by pattern — by PID, after confirming its cwd.
