# Phase 5 — Academic Structure

**Date:** 2026-08-25
**Status:** Approved for planning
**Prior specs:** `docs/superpowers/specs/2026-08-24-fee-structure-design.md`,
`docs/superpowers/specs/2026-08-24-idap-institution-profile-design.md`

---

## 1. What this is

Every institution on this platform describes what it teaches, and every institution
describes it differently. A school has classes. A PU college has years and combinations.
An engineering college has programmes, branches and semesters. A university has all of
that plus a programme level above it. Today the platform models none of this: an
institution types free text into `academic.classesOffered` / `academic.coursesOffered` on
its profile, and a fee structure keys off a free-text `classOrCourse` string that nothing
validates and nothing links to anything else.

Phase 5 replaces that with **per-institution academic master data**: a small, ordered,
editable tree of the things an institution actually offers, whose *shape* is determined by
the kind of institution it is.

The chain is:

```
Institution type  →  academic segments  →  blueprint (level names)  →  academic units  →  fee structures
   (existing)         (new, chosen)          (new, in code)             (new, per tenant)     (Phase 6)
```

### What Phase 5 is

The blueprint system, the `AcademicUnit` tree, its admin API and its editor UI — plus
rewiring the institution profile's published "classes offered" / "courses offered" to be
derived from the tree instead of hand-typed.

### What Phase 5 is not

**No fee changes.** `FeeStructure` is not touched in this phase. It keeps its free-text
`classOrCourse` and keeps working exactly as it does today. Phase 6 moves it onto academic
units. Phase 5 ships and merges on its own, useful on its own.

**No public academic-structure API.** The tree is internal master data in this phase. The
only thing it changes publicly is the *content* of two profile fields that are already
public. Whether the tree itself gets a public endpoint is a Phase 6+ question.

**No student or enrolment records.** An academic unit is a definition ("we offer B.Com"),
not a roster. Nothing counts students, and no student is attached to a unit.

**No timetable, syllabus, or subject master data.** A unit has a name and a position.
Subjects, staff assignment, and scheduling are separate products.

**No cross-institution catalogue.** Every institution's tree is its own. There is no
platform-level list of "all courses in India" that institutions pick from — an institution
types its own names, because real names vary and a shared catalogue becomes a support
burden the moment one institution's spelling differs.

---

## 2. Decision register

Each of these was decided explicitly. They are recorded so a later reader does not
relitigate them from scratch.

| # | Decision | Chosen | Rejected alternative |
|---|---|---|---|
| 1 | How institution kind drives shape | A **blueprint per segment**, in code, naming the level *tiers* | Hardcoding classes/courses per institution type in the fee module |
| 2 | One kind per institution, or several | **Several** — an institution selects one or more segments | A single `institutionType` picking a single shape |
| 3 | Tree storage | **One self-referencing `AcademicUnit` collection**, `parentId` + denormalized `depth`/`pathLabel` | Fixed columns (`course`/`branch`/`year`) on one flat document; a collection per institution type |
| 4 | `levelKey` storage | **Derived** from `(segment, depth)` at read time | Stored on the document, where a blueprint edit would leave it stale |
| 5 | Deactivation | **Read-time rule** — a unit is effectively inactive if it or any ancestor is inactive | Cascading `active: false` writes down the subtree |
| 6 | Profile `classesOffered` / `coursesOffered` | **Derived from the tree** at each blueprint's `offeringDepth`; stored arrays remain a fallback until a tree exists | Leaving them hand-edited (two sources of truth); deleting them (breaks the public profile contract) |
| 7 | Existing hand-typed offerings | A one-time **"Seed from profile"** action, available only while the tree is empty | A migration script; silently discarding them |
| 8 | Segment removal | **Refused** while any unit exists under that segment | Cascading delete of the segment's units |
| 9 | Unit deletion | Deletes the **whole subtree**, refused only by Phase 6's fee reference guard | Refusing any delete that has children |
| 10 | Where it lives | Its own admin-only nav item, `/academic-structure` | Nested under `/settings`, which is a read-only account page |

---

## 3. Architecture

Three layers, deliberately separated so the volatile part is data and the stable part is
code.

**Layer 1 — Blueprints (`src/lib/academic/blueprints.ts`), code, stable.**
A pure constant map from segment to an ordered list of levels. A level carries a `key`, a
singular `label`, a `plural`, and an `example` used as an input placeholder. The blueprint
names *tiers* — "Branch", "Combination", "Year / semester" — and never names *values*. The
strings "Grade 1", "PCMB", and "Computer Science & Engineering" appear nowhere in this
codebase outside placeholder examples and test fixtures.

Adding a thirteenth institution type later means adding one entry to this map. It means no
change to the model, the service, the routes, the editor, or the fee module.

**Layer 2 — `AcademicUnit` (`src/models/AcademicUnit.ts`), per-tenant data, volatile.**
One document per node. Each carries the segment it belongs to, its parent, its depth, its
display name, its sort position, and whether it is active. `depth` and `pathLabel` are
denormalized so that neither validation nor display needs a recursive read.

**Layer 3 — Consumers.**
Phase 5 has exactly two: the academic-structure editor, and the derived profile offerings.
Phase 6 adds fee structures. Neither consumer knows anything about institution types — they
read units, and units are the same shape whatever segment produced them. That is the
property that makes the design scale.

### Trees are small

An institution's tree is tens of nodes, not thousands: a school has ten classes; an
engineering college with six branches across four years has thirty-one. Every design
choice below assumes that. `listUnits` reads the whole tree in one query and the client
assembles it; a rename walks descendants and rewrites `pathLabel`; a delete collects the
subtree in memory. None of that is acceptable at ten thousand nodes and all of it is
correct and simple at fifty. `ACADEMIC_UNIT_MAX_PER_INSTITUTION = 500` is the guard that
keeps the assumption true.

---

## 4. Segments and blueprints

`ACADEMIC_SEGMENTS` is a curated list where **every entry is a genuinely different shape**.
It is not a list of institution types. Medical, nursing and B.Ed colleges all have the
shape `Course → Year / semester`, so they share the `DEGREE` segment rather than each
getting their own.

| Segment | Label | Levels | `offeringDepth` |
|---|---|---|---|
| `SCHOOL` | School (up to Class 10 / SSLC) | Class | 0 |
| `PRE_UNIVERSITY` | Pre-University (PUC) | PU year → Combination | 1 |
| `DEGREE` | Degree college | Course → Year / semester | 0 |
| `ENGINEERING` | Engineering college | Programme → Branch → Year / semester | 1 |
| `POLYTECHNIC` | Polytechnic / Diploma | Diploma course → Year / semester | 0 |
| `UNIVERSITY` | University | Programme level → Course → Specialisation → Year / semester | 1 |
| `COACHING` | Coaching / Training | Programme → Batch | 0 |
| `OTHER` | Other | Programme | 0 |

`offeringDepth` names the tier that answers "what do you offer" — the tier whose names are
worth publishing on a profile. For a school that is the class; for a PU college the
combination, not the year; for an engineering college the branch, not the programme.

### Level keys

`ACADEMIC_LEVEL_KEYS = ["CLASS", "PU_YEAR", "COMBINATION", "COURSE", "PROGRAMME",
"BRANCH", "PROGRAMME_LEVEL", "SPECIALISATION", "YEAR", "BATCH"]`

A key is shared where the tier genuinely is the same thing: `DEGREE`, `POLYTECHNIC` and
`UNIVERSITY` all use `COURSE`, differing only in the label the blueprint gives it.

### Default segments

`DEFAULT_SEGMENTS_FOR_TYPE: Record<InstitutionType, AcademicSegment[]>` seeds the initial
selection from the institution type an institution already has:

`SCHOOL → [SCHOOL]`, `PU_COLLEGE → [PRE_UNIVERSITY]`, `DEGREE_COLLEGE → [DEGREE]`,
`ENGINEERING_COLLEGE → [ENGINEERING]`, `MEDICAL_COLLEGE → [DEGREE]`,
`NURSING_COLLEGE → [DEGREE]`, `B_ED_COLLEGE → [DEGREE]`, `POLYTECHNIC → [POLYTECHNIC]`,
`UNIVERSITY → [UNIVERSITY]`, `COACHING_INSTITUTION → [COACHING]`,
`TRAINING_INSTITUTION → [COACHING]`, `OTHER → [OTHER]`.

This is a **default, not a constraint**. The selection is stored independently and edited
independently; changing `institutionType` later never rewrites a stored selection. A school
that adds a PU college ticks Pre-University and keeps School — that is the whole point of
decision 2.

---

## 5. Data model

### `Institution.academic.segments`

```ts
segments: { type: [String], enum: ACADEMIC_SEGMENTS, default: undefined }
```

Added to the existing `AcademicSchema` sub-document. `undefined` means "never chosen" and
reads through `defaultSegmentsFor(institutionType)`. Once written it is authoritative.

### `AcademicUnit`

```ts
const AcademicUnitSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    segment: { type: String, enum: ACADEMIC_SEGMENTS, required: true },
    /**
     * Explicit null for a root, never omitted — the unique sibling index has to
     * see one consistent value for "no parent", the same reason `Result.stream`
     * stores an explicit null.
     */
    parentId: { type: Schema.Types.ObjectId, default: null },
    depth: { type: Number, required: true, min: 0 },
    name: { type: String, required: true, trim: true },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    /** "PUC 1st Year › PCMB" — denormalized so display never walks ancestors. */
    pathLabel: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

AcademicUnitSchema.index({ institutionId: 1, segment: 1, depth: 1, sortOrder: 1 });
AcademicUnitSchema.index(
  { institutionId: 1, segment: 1, parentId: 1, name: 1 },
  { unique: true },
);
```

The unique index is the duplicate guard, refusing two siblings with the same name without a
read-then-write race. Names are compared as stored (trimmed, case-sensitive) — "Grade 1"
and "grade 1" are distinct, which is a deliberate non-decision: institutions type their own
names and normalising case would surprise more often than it would help.

`levelKey` is **not stored**. `levelFor(segment, depth)` returns it from the blueprint.

---

## 6. Validation

`src/lib/validation/academic-structure.ts`.

```
createAcademicUnitSchema  { segment, parentId: string | null (optional), name }
updateAcademicUnitSchema  { name?, active? }         // segment and parent are immutable
reorderAcademicUnitsSchema { segment, parentId: string | null, orderedIds: string[] }
updateSegmentsSchema      { segments: AcademicSegment[] }
```

`name` is `requiredText("Name", 120)`. `orderedIds` is 1–100 entries. `segments` is 1–8
entries and must contain no duplicates.

Neither `segment` nor `parentId` is patchable: moving a node between parents changes its
depth, its level, its `pathLabel` and every descendant's, and no user need for it has been
established. A misplaced unit is deleted and recreated.

They are made immutable the same way `updateFeeStructureSchema` makes `status` immutable —
by being **absent from the schema**, so Zod strips them from the body before the service
ever sees them. No `.strict()`: nothing in `src/lib/validation/` uses it, and a stripped key
and a rejected key are the same guarantee at the service boundary. The test asserts the
behaviour (a patch carrying them leaves both unchanged), not the mechanism.

Cross-field invariants live in the service, not the schema, because they need the parent
document:

- **Depth is within the blueprint** — `depth < ACADEMIC_BLUEPRINTS[segment].levels.length`.
  A school cannot create a child under a class; the blueprint has one level.
- **The parent belongs to the same segment**, and to the same institution.
- **The segment is one the institution has selected.**
- **The institution is under `ACADEMIC_UNIT_MAX_PER_INSTITUTION`.**

---

## 7. API surface

Admin-only, cookie session only, under `/api/settings/academic-structure/` — matching the
`/api/settings/fees` convention where the dashboard route is `/academic-structure` and the
API sits under `settings`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/settings/academic-structure` | Segments, available segments, blueprints, and every unit — one call feeds the whole editor |
| `PUT` | `/api/settings/academic-structure/segments` | Replace the selected segments |
| `POST` | `/api/settings/academic-structure/units` | Create one unit (201) |
| `PATCH` | `/api/settings/academic-structure/units/[unitId]` | Rename, or activate/deactivate |
| `DELETE` | `/api/settings/academic-structure/units/[unitId]` | Delete the unit and its subtree |
| `POST` | `/api/settings/academic-structure/reorder` | Rewrite `sortOrder` across one parent's children |
| `POST` | `/api/settings/academic-structure/seed` | One-time import from the profile's stored offerings |

`GET` returns the **full** `ACADEMIC_BLUEPRINTS` map, not just the selected segments' — the
segment checkbox row has to label segments the institution has *not* ticked. The editor
therefore never hardcodes a level label and never needs a second request to learn what a
tier is called.

Every mutating route records to `ActivityService` with `entityType: "ACADEMIC_UNIT"`, the
same way every fee-structure mutation does. A delete records the subtree root's `pathLabel`
(see §14 for what that does not capture).

Reorder is its own endpoint rather than a `PATCH` per unit: it is one atomic
rewrite across a sibling set, and issuing it as N patches would leave the order broken
between requests.

---

## 8. Authorization

`requireInstitution()` on every route, exactly as Fee Structure and Results do. This is a
hard `role !== "INSTITUTION_ADMIN"` check that throws, **not** a `ROLE_PERMISSIONS` /
`requirePermission()` lookup — that table exists for Lead Follow-up's Counselor and
Front-Desk model, and Phase 5 adds no entry to it. Counselors and Front Desk have no
academic-structure access at all, read or write, matching how they already have no access
to Results, Fees, Profile, Staff or Settings.

The platform admin (`SUPER_ADMIN`) has no route here, enforced by construction — no route
exists — and, following the precedent `results-routes.test.ts` set and Phase 4's final
review found missing, **by an explicit test** asserting a `SUPER_ADMIN` session is rejected.

Every read and write is scoped by `institutionId` from the session, never from the request.
A unit id belonging to another tenant reads as **`NOT_FOUND`, never `FORBIDDEN`** — the
platform-wide "404-never-403" convention. This applies to the parent id on create too: a
foreign `parentId` is "no such parent", not "not yours".

---

## 9. Derived profile offerings

`toPublicProfile(doc)` is a pure function and stays one. It gains an optional second
parameter:

```ts
toPublicProfile(doc, offerings?: { classesOffered: string[]; coursesOffered: string[] })
```

When `offerings` is supplied it wins; when it is absent the stored `academic.classesOffered`
/ `academic.coursesOffered` arrays are used as they are today. The parameter **must** be
optional: `toPublicProfile` has one production call site
(`src/services/institution.service.ts:718`) and eight call sites in
`tests/unit/public-projection.test.ts`, and none of them may need editing.

That one production call site calls `AcademicStructureService.offeringsFor(institutionId)`
and passes the result **only when the institution has at least one effectively-active unit**.

That conditional is what makes this safe to deploy: an institution that has not built a tree
yet keeps publishing exactly what it publishes today. Nothing disappears on release day.

The derivation itself is a **pure function**, `deriveOfferings(units, segments)` in
`src/lib/academic/offerings.ts`, taking an already-loaded unit list and returning the two
arrays. `AcademicStructureService.offeringsFor(institutionId)` is the thin wrapper that
loads the units and calls it. That split is what lets §12's offerings tests be real unit
tests over fixtures rather than integration tests needing a database.

`deriveOfferings` returns:

- `classesOffered` — names of effectively-active units in the `SCHOOL` segment at that
  blueprint's `offeringDepth`, in `sortOrder`.
- `coursesOffered` — names of effectively-active units in every **other** selected segment
  at each blueprint's own `offeringDepth`, ordered by segment then `sortOrder`, de-duplicated.

"Segment order" everywhere in this spec means **`ACADEMIC_SEGMENTS` declaration order**, not
the order the institution happened to tick the boxes in. A stored selection is a set; only
the declaration order is stable enough to derive a published array from.

"Effectively active" means the unit is active **and every ancestor is active** (decision 5).

The two array inputs are removed from the profile editor's Academic section, replaced by a
read-only summary of what the tree currently yields and a link to `/academic-structure`.
The stored arrays are left in the database untouched — they are the fallback above, and the
source the seed action reads.

---

## 10. Seed from profile

`POST /api/settings/academic-structure/seed` exists so that removing two text inputs never
costs an institution the data it already typed.

Preconditions, all required, all checked server-side:

- the institution currently has **zero** academic units;
- at least one of the stored arrays is non-empty.

Behaviour: every entry becomes a depth-0 unit, and the only question is which segment it
lands in. Each array has a preferred segment and one fallback:

| Array | Preferred segment | If that is not selected |
|---|---|---|
| `classesOffered` | `SCHOOL` | the first selected segment |
| `coursesOffered` | the first selected **non-`SCHOOL`** segment | the first selected segment |

"First" is `ACADEMIC_SEGMENTS` declaration order. Because at least one segment is always
selected (§6 caps `segments` at 1–8 entries, minimum one), both fallbacks always resolve —
there is no case where an entry has nowhere to go and no case where the endpoint errors on
otherwise valid data. An institution that typed classes but is configured as a PU college
gets its data as PU years, which is wrong-ish and editable, rather than losing it.

Entries that are blank after trimming, and entries that would collide with one already
created in the same segment, are skipped. The response reports how many units were created
and how many were skipped.

The zero-units precondition makes the endpoint idempotent by construction: a second call
finds units and refuses. The editor surfaces the action only when the tree is empty and at
least one stored array has content.

---

## 11. Dashboard

A new admin-only nav item, **Academic Structure** (`ListTree` icon), placed in the second
nav group immediately before **Fees** — fees depend on it, so it reads in dependency order.
`adminOnly: true`, mirroring the page's own guard.

`/academic-structure` is one page with two regions.

**Segments.** A row of checkboxes, one per `ACADEMIC_SEGMENT`, with the current selection
ticked. Unticking a segment that has units is refused by the server; the editor disables
those checkboxes and explains why on hover rather than letting the request fail.

**The tree.** One collapsible section per selected segment. Within a section, units render
as an indented list ordered by `sortOrder`, each row showing the name, its tier label from
the blueprint, and — where the blueprint has a deeper level — an "Add \<child tier\>"
action. Each row carries rename, move up / move down, activate / deactivate, and delete.
Move up / move down are client-side reorderings of one sibling set that then `POST` the
**whole** resulting `orderedIds` list — the endpoint takes a complete sibling set, never a
delta.
Inactive units render muted with an "Inactive" badge, and their subtrees render muted too,
which is the read-time rule made visible.

An empty segment shows the blueprint's first-level `plural` in its empty state ("No classes
yet", "No programmes yet") — text that comes from the blueprint, never from a conditional
on institution type.

Delete asks for confirmation and names the subtree size when it is greater than one
("Delete B.E. and the 12 units beneath it?").

The page follows the existing monochrome design system: no hue-based colour outside
`destructive`.

---

## 12. Testing

Written test-first, per task, in the existing Vitest layout.

**Unit — blueprints (`tests/unit/academic-blueprints.test.ts`)**
- every segment has at least one level;
- every `offeringDepth` is within its own level list — the off-by-one that would silently
  publish an empty offerings array;
- every level `key` is a member of `ACADEMIC_LEVEL_KEYS`;
- `DEFAULT_SEGMENTS_FOR_TYPE` covers every `INSTITUTION_TYPE` and names only real segments;
- `levelFor(segment, depth)` returns `null` past the end rather than throwing.

**Unit — validation (`tests/unit/academic-structure-validation.test.ts`)**
- name required, trimmed, capped at 120;
- `segments` rejects duplicates and rejects an empty array;
- `orderedIds` rejects an empty list and a list over 100;
- `updateAcademicUnitSchema` strips `segment` and `parentId` — the immutability rule,
  asserted at the schema, and again in the CRUD integration tests as "a patch carrying both
  leaves both unchanged".

**Unit — offerings derivation (`tests/unit/academic-offerings.test.ts`)**
- a school tree yields `classesOffered` and an empty `coursesOffered`;
- a PU tree yields combinations, **not** years — the `offeringDepth` rule under test;
- an engineering tree yields branches, not programmes and not years;
- a unit whose parent is inactive is excluded even though the unit itself is active;
- a composite school + PU institution yields both arrays populated from the right segments.

**Integration — CRUD (`tests/integration/academic-structure-crud.test.ts`)**
- create a root, create a child, `depth` and `pathLabel` computed correctly;
- a duplicate sibling name is refused;
- the same name under two different parents is allowed;
- creating past the blueprint's depth is refused;
- creating under a parent from a different segment is refused;
- creating in an unselected segment is refused;
- rename cascades `pathLabel` to grandchildren, not just children;
- delete removes the whole subtree;
- reorder rewrites `sortOrder` and refuses an id set that does not match the sibling set.

**Integration — routes (`tests/integration/academic-structure-routes.test.ts`)**
- each route rejects an anonymous session;
- each route rejects a `COUNSELOR` and a `FRONT_DESK` session;
- each route rejects a `SUPER_ADMIN` session;
- a unit id from another institution returns `NOT_FOUND`, never `FORBIDDEN`;
- a `parentId` from another institution returns `NOT_FOUND`;
- unticking a segment that still has units is refused.

**Integration — seed (`tests/integration/academic-structure-seed.test.ts`)**
- seeds classes and courses into the right segments;
- refuses when units already exist;
- a second call is refused, leaving the first call's units untouched.

**Integration — derived profile (`tests/integration/academic-structure-profile.test.ts`)**
- an institution with no units still publishes its stored arrays;
- an institution with units publishes the derived values instead;
- deactivating every unit falls back to the stored arrays rather than publishing nothing.

**Page guard (`tests/integration/admin-only-pages.test.ts`, existing file)**
- `/academic-structure` redirects a Counselor, matching the `/fees` entry added in Phase 4.

Every guard added in this phase is verified by **mutation check**: delete the guard, confirm
the named test fails, restore it, confirm green. A guard whose test passes without it is not
a tested guard.

---

## 13. Definition of done

- `ACADEMIC_SEGMENTS`, labels, `ACADEMIC_LEVEL_KEYS`, `ACADEMIC_BLUEPRINTS`,
  `DEFAULT_SEGMENTS_FOR_TYPE` in place, with no institution-specific value strings anywhere
  in `src/` outside placeholders and fixtures.
- `AcademicUnit` model registered in `src/models/index.ts` with both indexes.
- `Institution.academic.segments` added, with the default-from-type read path.
- `deriveOfferings(units, segments)` as a pure function in `src/lib/academic/offerings.ts`.
- `AcademicStructureService` covering list, create, update, delete, reorder, segments,
  seed, and `offeringsFor`, every mutation recording to `ActivityService`.
- All seven routes, all `requireInstitution()`, all `institutionId`-scoped.
- `/academic-structure` page and nav item, admin-only.
- Profile Academic section's two array inputs replaced by the read-only summary and link.
- `toPublicProfile` takes optional offerings; the public profile path supplies them only
  when a tree exists.
- OpenAPI unchanged — Phase 5 adds no public path. The `api-contract.test.ts` public-path
  count stays at 9.
- `npx tsc --noEmit` clean, `npm run lint` clean, full suite green.

---

## 14. Known limitations

**Rename walks descendants in the application, not the database.** A rename issues one read
of the subtree and one bulk write. At the tree sizes stated in §3 this is a few dozen
documents. It is not safe at thousands, and the `ACADEMIC_UNIT_MAX_PER_INSTITUTION` guard is
what keeps it from getting there.

**No move.** A unit cannot be reparented (§6). Delete and recreate.

**No audit of what a deleted subtree contained.** `ActivityService` records the delete and
the root's `pathLabel`, not the names beneath it. Recovering a mistaken delete means
retyping.

**Case-sensitive sibling names.** "Grade 1" and "grade 1" can coexist as siblings. Stated in
§5 as deliberate.

**`offeringsFor` de-duplicates across segments.** A composite institution offering "B.Com"
in two segments publishes it once. Correct for a public list, but it means the public arrays
are not a faithful count of units.

---

## 15. What Phase 6 owes this phase

Phase 6 — the fee rework — is not scoped here, but three obligations follow directly from
choices made above and must not be lost:

1. **`AcademicStructureService.removeUnit` needs a fee-reference guard.** In Phase 5 nothing
   references a unit, so delete is unguarded. The moment `FeeStructure.academicUnitId`
   exists, deleting a unit whose subtree is referenced must be refused. This is the single
   highest-value carry-forward from this spec.
2. **`FeeStructure` moves onto units:** `academicUnitId` required, `classOrCourse` demoted to
   a denormalized snapshot of `pathLabel` so the existing public fee contract does not
   change, unique key moved to `(institutionId, academicUnitId, academicYear)`. No backfill —
   there is no production fee data (Phase 4's decision).
3. **Bulk assignment and fee heads**, both from the original request: select N units → one
   `POST /api/settings/fees/bulk` → N independent DRAFT structures, each editable afterward;
   and a configurable per-institution fee-head list that the line-item label input suggests
   from while still accepting free text.
