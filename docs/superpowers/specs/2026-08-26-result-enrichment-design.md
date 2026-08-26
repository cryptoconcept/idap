# Result Enrichment — Design

**Status:** approved, not yet planned
**Date:** 2026-08-26
**Phase:** 7 (absorbs what was scoped as 7 and 8)

---

## 1. What this is

IDAP records an exam cycle as one `Result`: a board, a level, an optional
coarse stream, a year, and how many appeared and passed, with bands and
toppers underneath. That is enough to say "our PU college scored 96%". It is
not enough to say any of the things an institution actually competes on:

- which **branch or combination** produced the result — PCMB versus Commerce,
  CSE versus ECE;
- what **placements** followed — who recruited, how many, at what package;
- how many students cleared a **competitive entrance exam** — NEET, JEE, KCET —
  and at what rank.

This phase adds those three axes, plus a handful of smaller fields, to IDAP's
existing results module. It changes no existing behaviour and breaks no
existing row.

### Why now

IDAP is being connected to external listing platforms, PassPercent first. That
work established that the gap is not in IDAP's *profile* — which maps almost
completely — but in its *results*, which are missing exactly the three axes
above. A connector can reshape data IDAP holds; it cannot invent data IDAP
never recorded. So the data comes first.

### Explicitly not in this phase

- **The connector itself**, and any adapter for any external platform. This
  phase makes the data exist; a later phase moves it.
- **Any change to the public API.** See §7.
- **Any change to `Institution`.** Four profile fields are genuinely absent
  (`university`, `affiliationNo`, `studentStrength`, `facultyStrength`) and three
  more are derivable rather than stored (`feesMin`/`feesMax` from fee structures,
  `classFrom`/`classTo` from the academic tree). None of that is results data and
  none of it belongs here.

---

## 2. Decision register

| # | Decision | Why | Cost if wrong |
|---|---|---|---|
| 1 | A combination is a **sub-document inside a `Result`**, not a new `Result` row | Requires no change to the unique index and no migration. Existing PU rows, which already split Science/Commerce into separate `Result` rows, keep working untouched | If combinations later need their own lifecycle (separate publish, separate audit), they would have to be promoted to rows |
| 2 | `combinations[].academicUnitId` is **optional**; `label` is stored and is what publishes | Linking to the Phase 5 tree gives a picker instead of free typing, but requiring it would force every institution to build a tree before recording a result | A combination whose unit is later renamed keeps its old label |
| 3 | The label is **stored, not derived live** from `pathLabel` | Deliberately unlike `FeeStructure`, which derives live. A result is a historical record: a branch renamed in 2027 must not silently retitle a 2024 result | Renaming a unit does not propagate to past results — which is the intent |
| 4 | Combination-level `grades` uses PassPercent's **fixed buckets**, while result-level `bands` keeps IDAP's flexible shape | Instructed: build to what PassPercent wants. Flagged during design and confirmed | Two grade representations coexist in one model. A later platform wanting different buckets converts from the fixed set, which is lossy |
| 5 | `selections` is an **array with a unique `examCode`**, not a map | Matches how `bands` and `toppers` are already modelled here; Mongoose validates arrays more naturally | Slightly more work to look up one exam by code |
| 6 | `placement` attaches to the **`Result`**, not to a combination | PassPercent models placement at stream level, and a college recruits across branches from one drive | A college wanting per-branch placement splits cannot express it |
| 7 | New fields are **absent from the public projection** | It is an allow-list guarded by a contract test. Adding fields there is a deliberate act with its own decision, not a side effect | External consumers cannot read the new data until a later phase adds it deliberately |
| 8 | Combinations carry an **`id` handle** in the write schema, exactly like toppers; selections are matched by **`examCode`** instead of a synthetic handle | Both nest toppers, and this codebase already has one bug class it treats as a precedent: replacing an array wholesale on every PATCH silently destroys a `photoUrl` only an upload endpoint can write (the existing code comment calls this "the shape of Phase 1's Critical finding"). Without an identity to match on, that recurs one level down the first time a combination's label is corrected | A combination's or selection's toppers lose their photos on the next unrelated edit — reproducing a bug this codebase has already had once |

---

## 3. Architecture

No new services, no new routes, no new pages. This phase extends four existing
seams and adds three UI sections.

```
src/models/Result.ts              extend: combinations, placement, selections,
                                  boys/girls, distinction, firstClass
src/lib/constants.ts              add:    EXAM_CODES, EXAM_CODE_LABELS,
                                          RECRUITER_CATEGORIES, GRADE_BUCKETS
src/lib/validation/result.ts      extend: schemas + assertResultInvariants
src/services/result.service.ts    extend: create/update pass the new fields through
src/components/results/           add:    combinations-section.tsx,
                                          placement-section.tsx,
                                          selections-section.tsx
                                  extend: result-editor.tsx composes them
```

The existing decomposition is kept: `result-editor.tsx` composes sections, each
section owns one concern, and repeatable rows follow `band-editor.tsx`.

---

## 4. Data model

All additions are optional. A `Result` that sets none of them is byte-identical
in behaviour to one written before this phase.

**On field naming.** The *shape* follows PassPercent; the *names* follow IDAP.
`averageScore` and `averagePackage` are spelled out here because `Result`
already has `averageScore`, where PassPercent's wire format says `avgScore` /
`avgPackage`. A model that spells the same concept two ways depending on which
sub-document you are in is a worse cost than a rename in an adapter, which is
one line and the adapter's whole job.

### 4.1 Shared sub-shapes

```ts
/** PassPercent's fixed buckets — see Decision 4. */
const GRADE_BUCKETS = ["90+", "80-90", "70-80", "60-70", "50-60", "below50"] as const;

GradeCounts   = Record<(typeof GRADE_BUCKETS)[number], number>   // each min 0, default 0
CohortSplit   = { appeared?: number; passed?: number }           // each min 0
```

### 4.2 Combinations

```ts
// Stored shape — keeps its _id (unlike BandSchema's `{_id: false}`), because a
// combination nests toppers and needs an identity for the same reason a
// topper does: see Decision 8 and §4.5a.
combinations: [{
  academicUnitId?: ObjectId;   // optional link to the Phase 5 tree
  label: string;               // required, trimmed; what publishes
  appeared?: number;           // min 0
  passed?: number;             // min 0
  distinction?: number;        // min 0 — count scoring distinction
  firstClass?: number;         // min 0
  highestScore?: number;       // 0..100
  averageScore?: number;       // 0..100
  grades?: GradeCounts;
  boys?: CohortSplit;
  girls?: CohortSplit;
  toppers?: [TopperSchema];    // the EXISTING topper sub-schema, reused verbatim
}]
```

The write schema (`createResultSchema`/`updateResultSchema`) adds one field this
stored shape does not have: `id?: string`, following `topperSchema`'s own
pattern exactly. It names an existing combination on this result so a patch can
be matched back to the row it came from — a handle, not a stored field, and
never used to set the stored `_id` directly.

`toppers` reuses `TopperSchema` unchanged, so a combination topper gets the same
`photoUrl` write protection and the same `consentAcknowledged` flag. Reaching
those toppers from the photo endpoint is not automatic — see §4.5. Preserving
them across an edit to their parent combination is not automatic either — see
§4.5a.

### 4.3 Placement

```ts
placement: {
  eligible?: number;           // min 0
  placed?: number;             // min 0
  highestPackage?: number;     // ₹ LPA, min 0
  averagePackage?: number;     // ₹ LPA, min 0
  recruiters?: [{
    name: string;              // required, trimmed
    category?: RecruiterCategory;
    selected?: number;         // min 0
    averagePackage?: number;   // min 0
    tieUp?: boolean;           // default false
    roles?: string[];
  }];
}
```

`RECRUITER_CATEGORIES = ["IT", "PRODUCT", "CORE", "CONSULTING", "STARTUP", "OTHER"]`.

**Recruiters carry no logo in this phase.** PassPercent accepts one, but IDAP has
no upload path for it and this phase does not add one — and a `logoUrl` column
nothing can write is a dead field advertising a capability that does not exist.
Accepting a URL from the request body instead is not the shortcut it looks like:
a client-settable media URL is precisely the shape that produced Phase 1's
cross-tenant deletion finding. A recruiter wall of names is useful on its own;
logos can come with the endpoint that can safely store them.

### 4.4 Selections

```ts
selections: [{
  examCode: ExamCode;          // required, enum
  appeared?: number;           // min 0
  qualified?: number;          // min 0
  bestRank?: number;           // min 1
  toppers?: [TopperSchema];    // reused verbatim
}]
```

`EXAM_CODES = ["NEET", "JEE_MAIN", "JEE_ADVANCED", "KCET", "COMEDK"]` with a
label map beside it, following `RESULT_BOARD_LABELS`. Adding an exam later is one
entry in each.

Selections need no separate `id` handle the way combinations do: `examCode` is
already a stable, non-free-text key — unlike a label, it cannot be edited into
a typo — and §5.1 already requires it unique within a result. A patch matches
an existing selection by `examCode` directly. Its nested toppers are preserved
across that match exactly as a combination's are — see §4.5a.

### 4.5 Topper photos must reach nested toppers

Reusing `TopperSchema` gives combination and selection toppers a `photoUrl` —
and today nothing could write it. `setTopperPhoto` locates its target with
`before.toppers?.find(...)`, which only ever searches the result-level array. A
field on the schema that no endpoint can populate is a dead field advertising a
capability that does not exist.

So this phase **widens the lookup** in `setTopperPhoto` and `removeTopperPhoto`
to search, in order: `toppers`, `combinations[].toppers`, `selections[].toppers`.

**The route signature does not change.** Topper `_id`s are unique within the
document, so `/api/settings/results/{resultId}/toppers/{topperId}/photo` already
addresses a nested topper unambiguously — the endpoint simply has to look in
three places instead of one.

The non-obvious part is the write, not the read: the current update uses a
positional operator against `toppers`, which cannot reach a topper two levels
down. Writing a nested topper's URL needs `arrayFilters` (or an equivalent
addressed path), and the implementation must confirm the URL actually landed
rather than trusting a `findOneAndUpdate` that matched nothing.

Ownership is unaffected — `findOwned` already scopes by `institutionId` before
any of this runs, and the storage key stays under the institution's own prefix
so `isOwnedMediaUrl` continues to cover it.

### 4.5a Preserving nested topper identity across an update

This is the deeper half of the problem §4.5 opens: reaching a nested topper
from the photo endpoint is one thing; not silently destroying it on an
unrelated edit is another, and the two are separate defects with separate
fixes.

`mergeToppers` already exists in `result.service.ts` and is already generic —
nothing about it is specific to the top-level `toppers` array; it takes an
incoming list, an existing list, matches by the `id` handle, and carries each
match's `_id` and `photoUrl` across untouched. It is reused as-is for a
combination's `toppers` and a selection's `toppers` — not reimplemented.

What this phase adds is the layer above it: `update()` currently replaces
`combinations`, `selections` and `placement` wholesale on any patch, the same
way it replaces `bands` — correct for `bands` and `placement.recruiters`,
because neither nests anything with identity to lose (Decision 8's converse:
`placement.recruiters` carries no photo in this phase, so it is safe to
replace exactly like `bands`). It is wrong for `combinations` and `selections`,
because both nest toppers.

So `update()` gains two more merge functions, called only when the patch
actually touches that field — mirroring exactly how `mergeToppers` is only
invoked `if (patch.toppers)`:

- **`mergeCombinations(incoming, existing)`** — matches each incoming row to an
  existing one by its `id` handle (Decision 8), the same shape `mergeToppers`
  already has for the top level, and then calls `mergeToppers` again on
  *that combination's own* `toppers` field before returning it. A combination
  with no matching `id`, or no `id` at all, is a new combination with fresh
  toppers — again identical to how an un-matched top-level topper is created
  fresh today.
- **`mergeSelections(incoming, existing)`** — matches by `examCode` instead of
  a handle (§4.4), otherwise identical: recurses into `mergeToppers` for that
  selection's own toppers.

Both are invoked exactly where `mergeToppers` already is, and their output
feeds the same merged record `assertResultInvariants` checks — so what is
validated is still exactly what is written, unchanged from today's rule.

No such step exists for `placement`, and none is needed: it replaces wholesale,
because it nests nothing with server-written identity to lose.

### 4.6 Result-level additions

```ts
distinction?: number;   // min 0
firstClass?: number;    // min 0
boys?: CohortSplit;
girls?: CohortSplit;
```

### 4.7 Indexes

**None added, none changed.** Every new field is inside a document already
addressed by `{institutionId, board, level, stream, academicYear}`. This phase
therefore ships **no index migration** — deliberately unlike Phase 6a, whose
missing migration was that phase's one Critical.

---

## 5. Validation and invariants

Schema-level rules (`min`, `max`, `enum`, `required`) live on the Mongoose
schema. Cross-field rules live in `assertResultInvariants`, which both `create`
and `update` already call, and which `assertPublishable` already builds on.

### 5.1 New invariants

Each is a real way to record a nonsensical result, and each gets its own test.

| Rule | Message |
|---|---|
| `passed <= appeared` **per combination** | `combinations: "<label>" has more passed than appeared` |
| Sum of `combinations[].appeared` `<=` result `appeared` | `combinations: the combinations account for more students than appeared` |
| Combination labels are **distinct** after trim | `combinations: each combination needs a distinct label` |
| `distinction + firstClass <= passed` (result and combination) | `distinction and first class together exceed the number who passed` |
| `boys.appeared + girls.appeared <= appeared` | `boys and girls together exceed the number who appeared` |
| `boys.passed <= boys.appeared`, same for girls | `boys: more passed than appeared` |
| Grade bucket counts sum `<= appeared` for that combination | `grades: the grade bands account for more students than appeared` |
| `placement.placed <= placement.eligible` | `placement: more students placed than were eligible` |
| `sum(recruiters[].selected) <= placement.placed` | `placement: the named recruiters account for more selections than the placed total` |
| `placement.averagePackage <= placement.highestPackage` | `placement: the average package cannot exceed the highest` |
| Recruiter names are **distinct** after trim | `placement: each recruiter needs a distinct name` |
| `selections[].qualified <= selections[].appeared` | `selections: <exam> has more qualified than appeared` |
| `examCode` is **unique** within a result | `selections: each exam can appear only once` |

Two rules are deliberately **not** enforced:

- **Combination `appeared` need not sum to the result's `appeared`.** A college
  may record two of its five branches. The cap in §5.1 stops overcounting;
  requiring equality would refuse partial data, which is the normal case.
- **`selections[].qualified` is not capped by the result's `passed`.** A student
  can clear NEET without appearing in that board cycle at all, and the two
  cohorts genuinely differ.

### 5.2 Publish gate

`assertPublishable` gains nothing. A result is publishable on the same terms as
before — the new axes are enrichment, and refusing to publish a perfectly good
board result because nobody typed a recruiter would be wrong.

---

## 6. UI

Three sections added to the existing `result-editor.tsx`, each following
`band-editor.tsx`'s repeatable-row pattern and this codebase's Radix
conventions: a `Select` and a `Checkbox` are buttons with no native `onChange`,
so they are driven by `watch`/`setValue`, never by spreading `register()`.

- **`combinations-section.tsx`** — repeatable rows. The label field is an
  `AcademicUnit` picker when the institution has a tree (storing both
  `academicUnitId` and the resolved label) and a plain text input when it does
  not. Each row expands to reveal grades, gender split and its own toppers,
  collapsed by default: most institutions fill in label/appeared/passed and
  nothing else, and a row that opens with fourteen inputs reads as work.
- **`placement-section.tsx`** — the four headline numbers, then a repeatable
  recruiter list.
- **`selections-section.tsx`** — repeatable rows keyed by an exam `Select`,
  with already-chosen exams excluded from the list rather than accepted and
  then rejected by the invariant.

Sections render for every institution type. A school will leave placement empty;
that is a two-line section it ignores, and gating visibility on institution type
would mean a PU college running coaching for engineering entrance could not
record its own KCET selections.

Monochrome design system throughout: no hue-based colour outside
`text-destructive` / `variant="destructive"`.

---

## 7. Public API — unchanged, deliberately

`src/lib/results/public-projection.ts` is an allow-list: it names the fields
that may leave, so a field added to the schema is private until someone
deliberately publishes it. **This phase adds nothing to it.**

Consequently `tests/unit/results-projection.test.ts`,
`tests/unit/openapi-results.test.ts` and `tests/unit/api-contract.test.ts` must
pass **unedited**, and `src/lib/api/openapi.ts` must be untouched. That is the
proof the public contract did not move.

Publishing placement or selections externally is a real decision with its own
privacy weight — a recruiter list is commercially sensitive, and a topper's
rank in a national exam is personal. It belongs to the phase that has a reason
for it, not to this one.

---

## 8. Authorization — unchanged

Every path already runs through `requireInstitution()` and, for mutations,
`assertSameOrigin(request)` first. No new route, no new role, no
`ROLE_PERMISSIONS` entry. Cross-tenant access continues to read as `NOT_FOUND`,
never `FORBIDDEN`.

---

## 9. Testing

Extend the existing files rather than adding parallel ones:

| File | Adds |
|---|---|
| `tests/unit/result-model.test.ts` | schema defaults, enums, `min`/`max`, absent-means-absent for each new optional block |
| `tests/unit/results-validation.test.ts` | one test per invariant in §5.1, plus the two deliberately-unenforced rules asserted as **accepted** |
| `tests/integration/results-crud.test.ts` | create and update round-trip each new axis; tenant scoping unchanged; **a combination's or selection's topper photo survives an unrelated PATCH to that same combination/selection** — the test §4.5a exists to pass |
| `tests/integration/results-media.test.ts` | a photo set on a **combination** topper and on a **selection** topper lands on that topper and no other; a foreign `topperId` still reads as `NOT_FOUND` |
| `tests/unit/results-projection.test.ts` | **unedited** — and one new assertion that a result carrying every new field still projects exactly the pre-existing public keys |

That last row is the important one. It is the test that would fail if a future
change quietly published placement data, and it is cheap to add now while the
allow-list's contents are fresh.

**Every invariant gets a mutation check**: delete the guard, confirm the named
test fails and that it is the only failure, restore, confirm green. An assertion
that passes with its guard removed is worse than a missing test, because it
wears a badge saying covered.

---

## 10. Definition of done

- `Result` carries `combinations`, `placement`, `selections`, `boys`/`girls`,
  `distinction`, `firstClass` — all optional, all absent by default.
- `TopperSchema` is **reused**, not redefined, by combinations and selections —
  and `setTopperPhoto`/`removeTopperPhoto` can actually reach those toppers, so
  `photoUrl` is never a field nothing can write.
- A combination's or selection's toppers survive a PATCH that edits an unrelated
  field on that same combination or selection — `mergeCombinations`/
  `mergeSelections` (§4.5a) genuinely preserve identity, not merely `mergeToppers`
  at the top level.
- Every invariant in §5.1 is enforced and independently mutation-checked.
- The three new editor sections save and reload every field they show.
- `src/lib/api/openapi.ts` untouched; `results-projection`, `openapi-results`
  and `api-contract` tests pass **unedited**.
- No index added or changed; **no migration ships with this phase**.
- No existing test weakened or deleted — every test diff is a pure insertion.
- `npx tsc --noEmit` clean; `npm run lint` **0 errors**, warnings only of the
  pre-existing `react-hooks/incompatible-library` class.
- Full suite green, with the expected count stated per task and verified.

---

## 11. Known limitations

1. **Two grade representations coexist** — flexible `bands` at result level,
   fixed buckets at combination level (Decision 4). Deliberate, instructed, and
   the one place the "build to PassPercent" instruction has a visible cost.
2. **A renamed academic unit does not retitle past results** (Decision 3).
   Intended: a result is a historical record.
3. **Placement cannot be split per branch** (Decision 6).
4. **A combination matched by no `id`, or an `id` matching nothing on the
   result, is created fresh with fresh toppers** — identical to how an
   un-matched top-level topper behaves today (§4.5a). Not a new limitation;
   naming it here so it is not mistaken for one when this phase's tests
   exercise it.
5. **Recruiters have no logo** (§4.3) — deliberate, pending an upload endpoint.
6. **Nothing new is publicly readable** (§7) until a later phase decides so.
7. **Academic year remains free text**, so a typo (`2026-2027` for `2026-27`)
   still creates a separate cycle. Pre-existing; unchanged here.

---

## 12. What the next phase owes this one

The connector phase will need, and this phase deliberately does not provide:

1. **A stream mapping** from IDAP's `(level, institutionType)` onto an external
   platform's stream keys, as a config table rather than hardcoded conditionals.
2. **A rollup rule** — where several IDAP rows land on one external stream key,
   `appeared` and `passed` are **summed and the percentage recomputed**, never
   averaged. Averaging percentages across unequal cohorts is arithmetically
   wrong, and it is the easiest mistake to make here.
3. **An explicit unmapped outcome.** IDAP levels `DIPLOMA` and `OTHER`, and
   results at B.Ed/Nursing/Coaching/Training institutions, have no PassPercent
   home. They must be skipped *and reported in the UI* — silence is
   indistinguishable from a sync bug when an admin cannot find their results.
4. **Grade-bucket conversion** for any platform whose buckets differ from the
   fixed set adopted in Decision 4.

---

## 13. As built

Implemented via Subagent-Driven Development, 9 tasks, merged to `main` at
`b87a3f7` (fast-forwarded from `feat/result-enrichment`, forked at `02418e1`).
754 tests passing, 77 files, `tsc`/lint clean.

**Fixed before merge, found by the whole-branch review:**
- Nested topper photos (in `combinations[]`/`selections[]`) were orphaned on
  removal in both `update()` and `remove()` — the latter undisclosed by any
  task review until the final review found it independently. A shared
  `collectToppers()` helper in `result.service.ts` now enumerates every
  topper across all three arrays for both cleanup sites.
- Nested topper `consentAcknowledged` was captured and displayed but never
  enforced — `assertPublishable`/`blockingPublishReasons` only checked
  top-level toppers. Both now check all three arrays; `setStatus`'s call site
  was extended to pass `combinations`/`selections` through.
- `placement`'s average-vs-highest-package check used a truthiness guard
  (`highest > 0`) instead of this file's own `!= null` convention, letting
  `highestPackage: 0` coexist with a positive average. Fixed to match every
  sibling invariant.
- `recruiters[].roles` had no length cap, the only array in this phase without
  one. Added `RESULT_MAX_RECRUITER_ROLES`.

**Deliberate non-fixes, carried forward rather than fixed under time pressure
in the one available fix wave** — recorded so neither is rediscovered as a
fresh finding:
- A PATCH that omits `combinations[].toppers`/`selections[].toppers` silently
  deletes them, unlike top-level `toppers`' preserve-on-omission semantics.
  Not reachable today — the UI always sends `toppers` — but a trap for a
  future maintainer who patches these arrays directly.
- `combinations[].academicUnitId` is accepted with no check that the unit
  belongs to the calling institution. No read amplification today since
  nothing resolves it server-side and the UI only offers same-tenant units;
  becomes real the moment the connector phase (§12) resolves it to a label.
  Fix by mirroring `fee-structure.service.ts`'s existing
  `AcademicUnit.findOne({ _id, institutionId })` → `notFound` pattern.
