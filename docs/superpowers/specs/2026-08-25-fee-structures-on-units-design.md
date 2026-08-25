# Phase 6a — Fee Structures on Academic Units

**Date:** 2026-08-25
**Status:** Approved for planning
**Prior specs:** `docs/superpowers/specs/2026-08-24-fee-structure-design.md` (Phase 4),
`docs/superpowers/specs/2026-08-25-academic-structure-design.md` (Phase 5)

---

## 1. What this is

Phase 4 gave institutions itemized fee structures keyed by a free-text `classOrCourse`
string. Phase 5 gave them a real academic structure — an ordered, per-tenant tree whose
shape follows the kind of institution they are. Phase 6a joins the two: a fee structure
stops naming a class in prose and starts pointing at an academic unit.

That closes the last gap in the original request. An institution defines what it teaches
once, and everything else — its public profile's course list, and now its published fees —
reads from that one definition instead of from three separately-typed copies.

### What Phase 6a is

`FeeStructure.academicUnitId`, the unique key moved onto it, the label derived from the
unit at read time, a unit picker in place of the free-text input, and the fee-reference
guard that Phase 5 deliberately left undone.

### What Phase 6a is not

**No bulk assignment and no configurable fee heads.** Both are real and both are wanted;
they are Phase 6b, on top of this. Phase 6a deliberately adds no new capability — it
re-keys an existing one — so that a regression here is attributable to the restructure
rather than to a new feature landing at the same time.

**No backfill.** Phase 4 established there is no production fee data. `academicUnitId` is
required from day one and there is no legacy code path.

**No change to the public fee API.** Not a single byte of the published contract moves.
That is a hard constraint, not an aspiration — see §8.

---

## 2. Decision register

| # | Decision | Chosen | Rejected alternative |
|---|---|---|---|
| 1 | Where the class/course label comes from | **Derived live** from the unit's `pathLabel` at read time | A stored snapshot with a rename cascade; a stored snapshot never updated |
| 2 | `classOrCourse` on the model | **Removed entirely** | Kept as a denormalized column |
| 3 | Is `academicUnitId` patchable | **No** — delete and recreate | Patchable, which would move the record's unique key underneath it |
| 4 | Which units may carry a fee | **Any unit, any depth** | Leaves only |
| 5 | Where the delete guard lives | In `AcademicStructureService.remove`, importing the **`FeeStructure` model** | Importing the fee *service* (a cycle risk); a database-level constraint (Mongo has none) |
| 6 | Sort order for fee lists | **In memory by derived `pathLabel`**, after enrichment | A `$lookup` aggregation; sorting by `academicUnitId`, which is meaningless to a reader |
| 7 | Fee structures for an institution with no tree | **Impossible, and the UI says so** | An empty dropdown that silently cannot be submitted |
| 8 | Public contract | **Byte-identical**, no OpenAPI edit | Exposing `academicUnitId` publicly |

---

## 3. Architecture

The change is narrow in concept and wide in mechanics.

**Conceptually:** one column becomes a foreign key, and one string becomes a join.

**Mechanically:** `classOrCourse` is currently read in the model, the service's DTO, three
sort clauses and three audit-trail descriptions, the public projection, the form, the list
view, and roughly sixty tests. Every one of those has to move to the new source. The task
count for this phase is driven by that migration, not by new logic — a fact the plan should
reflect rather than disguise.

**The enrichment seam.** `FeeStructureService` gains one private helper that takes a set of
fee-structure rows, batch-fetches the units they reference in a single `$in` query, and
returns the rows with `classOrCourse` attached. Every read path — `list`, `get`,
`listPublic` — goes through it. Nothing else in the codebase learns that the label is
derived; the DTO and the public projection keep the same shape they have today.

This is deliberately the same shape as Phase 5's `offeringsFor` seam: the derivation lives
in the service, and the projection stays a pure allow-list over a document.

---

## 4. Data model

```ts
// FeeStructure
academicUnitId: { type: Schema.Types.ObjectId, required: true, index: true },
// classOrCourse: REMOVED
```

Indexes:

```ts
FeeStructureSchema.index({ institutionId: 1, createdAt: -1 });                    // unchanged
FeeStructureSchema.index({ institutionId: 1, status: 1, academicYear: -1 });      // unchanged
FeeStructureSchema.index(
  { institutionId: 1, academicUnitId: 1, academicYear: 1 },
  { unique: true },
);                                                                                // replaces the classOrCourse key
```

One fee structure per unit per academic year, still refused by the index rather than a
pre-read, for the same reason as before: a read-then-write races two browser tabs into
creating both.

`academicUnitId` is a bare `ObjectId` with no `ref`. Nothing in this codebase uses Mongoose
`populate`, and the enrichment helper queries the model directly — a `ref` would imply a
populate-based access pattern that does not exist here.

---

## 5. Validation

`createFeeStructureSchema` replaces `classOrCourse` with `academicUnitId`, using the same
24-hex-character `objectIdString` shape Phase 5 established in
`src/lib/validation/academic-structure.ts`. Lift that helper into
`src/lib/validation/common.ts` rather than defining it twice — two modules now need it. That
edit also touches `src/lib/validation/academic-structure.ts`, which must import it from the
new home rather than keeping its local copy; its existing tests must pass unedited
afterwards, which is the evidence the lift changed no behaviour.

`updateFeeStructureSchema` gains **no** `academicUnitId` field. It stays absent, exactly as
`status` is absent, so Zod strips it and a PATCH cannot move a fee structure onto a
different unit and take its unique key with it. `academicYear` remains patchable.

Everything else — line items, the duplicate-label invariant, the publish gate — is
untouched.

---

## 6. Service changes

**`create`** additionally loads the unit, scoped by `institutionId`. A unit belonging to
another institution, or a malformed id, reads as `NOT_FOUND` — the platform's
404-never-403 rule, and the same wording `AcademicStructureService` already uses. The
loaded unit's `pathLabel` supplies the audit-trail description, so no second read is needed.

**`list` / `get` / `listPublic`** run their rows through the enrichment helper. `list` and
`listPublic` then sort **in memory** by `(academicYear desc, classOrCourse asc)` — the
database can no longer sort by a column that does not exist, and an aggregation `$lookup`
is disproportionate for tens of rows.

**`update`** and **`setStatus`** need the label only for their audit descriptions; they
enrich the single row they already hold.

**`remove`** likewise, for its description.

**`AcademicStructureService.remove`** gains the guard Phase 5 promised:

```ts
const ids = await subtreeIds(institutionId, before);

// Phase 5 left this unguarded because nothing referenced a unit yet. It does now.
const referenced = await FeeStructure.countDocuments({
  institutionId,
  academicUnitId: { $in: ids },
});
if (referenced > 0) {
  throw validationError(
    `Delete the ${referenced} fee structure(s) under this unit before deleting it`,
  );
}
```

It counts across the **whole subtree**, not just the unit itself: deleting a programme must
be refused when a fee hangs off a branch anywhere below it. The comment that currently
marks this as a Phase 6 obligation is removed in the same edit — the obligation is
discharged.

---

## 7. Authorization

Unchanged in every respect. `requireInstitution()` on the admin routes, credential-free on
the two public routes, `assertSameOrigin` on every mutation, 404-never-403 for foreign ids —
now including a foreign `academicUnitId` on create. Phase 6a adds no route, no role, and no
`ROLE_PERMISSIONS` entry.

---

## 8. The public contract does not change

The public fee endpoints keep emitting exactly `classOrCourse`, `academicYear`, `lineItems`
and `publishedAt`. `toPublicFeeStructure` is not edited at all: it still reads
`doc.classOrCourse`, and the service now supplies that field on the row it hands over.

Consequences, all of which are gates in §12:

- `src/lib/api/openapi.ts` is untouched; the public-path count in
  `tests/unit/api-contract.test.ts` stays at **9**.
- `tests/unit/openapi-fee-structure.test.ts` and
  `tests/unit/fee-structure-projection.test.ts` must pass **unedited**. If either needs a
  change, the contract moved and something is wrong.

The only observable difference to a public consumer is a good one: renaming a branch now
updates every fee structure beneath it on the next request, where before the label would
have been whatever prose was typed months earlier.

---

## 9. Dashboard

**The fee form's free-text input becomes a unit picker** — a `Select` over the
institution's academic units, each option labelled with its full `pathLabel` so
"B.E. › CSE › Year 1" is unambiguous against "B.Tech › CSE › Year 1". Units that are
**effectively inactive** are excluded — that is Phase 5's read-time rule (a unit counts as
inactive when it or any ancestor is), the same one `inactiveIds` and `effectivelyActive`
already implement, not merely the unit's own `active` flag. Pricing something you have
hidden, or something under a branch you have hidden, is not a thing to offer.

**`/fees/new` gains an empty state.** When the institution has no academic units, the page
does not render a form with an empty dropdown; it explains that fees attach to classes and
courses, and links to `/academic-structure`. This is the ordering dependency Phase 6a
introduces, made visible rather than discovered.

**The editor page** shows the unit as read-only text. Changing which unit a fee belongs to
is delete-and-recreate, per decision 3, and an input that looks editable but is not would be
worse than no input.

**The list view** is unchanged — it already renders `feeStructure.classOrCourse`, which
still exists on the DTO.

---

## 10. Migration

**No data migration, but an index migration.** There is no production fee data, so
`academicUnitId` is required from the first write and no backfill is needed. The
collection's *indexes* are a different matter: Mongoose creates the new unique key but
never drops the Phase 4 one, so `scripts/sync-fee-indexes.ts` must run against any
environment where Phase 4 was ever deployed, before this phase's code serves traffic.
Without it the second fee structure per institution per academic year is refused.

The script reports and exits by default; **it only writes with `--apply`**:
`npm run sync:fee-indexes` to see what is stale, then
`npm run sync:fee-indexes -- --apply` to drop it and build the current set. It is
idempotent and a no-op on a database that already matches the schema.

**A substantial test migration.** Roughly sixty existing fee tests construct fee structures
with `classOrCourse: "Grade 10"`. Each must instead create an academic unit and pass its id.
This is mechanical but it is most of the work, and it touches all eight fee test files.

Two rules for that migration, because it is where a silent loss of coverage would hide:

1. **A test's assertion may not be weakened to make it pass.** If a test asserted on
   `classOrCourse` and still can, it must — the label is still there, it just comes from the
   unit now.
2. **Test counts per file may not drop.** The plan states the count for each file before and
   after; a file that loses a test has lost coverage, and that is a finding, not a tidy-up.

---

## 11. Testing

**Unit — model:** `academicUnitId` is required; the unique key is
`(institutionId, academicUnitId, academicYear)`; two institutions may hold fees for
same-named units independently; the same unit may hold fees for two different years.

**Unit — validation:** `academicUnitId` is required and must be a valid object id shape;
`updateFeeStructureSchema` **strips** it, asserted the same way `status` is.

**Unit — projection:** unchanged and unedited. Its existing tests already prove the
allow-list; that they still pass is the evidence the contract held.

**Integration — the delete guard**, which is the highest-value new coverage in this phase:
- deleting a unit that carries a fee structure is refused;
- deleting an **ancestor** of a unit that carries one is refused — the subtree case;
- deleting a unit whose fee structure was itself deleted first succeeds;
- another institution's fee structure does not block a delete (the guard is tenant-scoped).

**Integration — CRUD:** create against a unit; a foreign `academicUnitId` reads
`NOT_FOUND`; a malformed one reads `NOT_FOUND`; the duplicate key is refused by the index;
a PATCH carrying `academicUnitId` leaves it unchanged.

**Integration — enrichment:** a fee structure's `classOrCourse` reflects the unit's current
`pathLabel`; **renaming the unit changes it on the next read** — the payoff of decision 1,
and the test that would fail under a snapshot design; the admin list sorts by the derived
label, not by id.

**Integration — public:** the published payload is byte-identical in shape to Phase 4's; a
renamed unit is reflected publicly; nothing new is exposed.

Every guard added in this phase is mutation-checked: delete the guard, confirm the named
test fails, restore, confirm green.

---

## 12. Definition of done

- `FeeStructure.academicUnitId` required and indexed; `classOrCourse` gone from the model;
  the unique key moved.
- `objectIdString` lifted into `src/lib/validation/common.ts` and used by both validators.
- The enrichment helper is the only place a unit's `pathLabel` is read into a label. No
  read path (`list`, `get`, `listPublic`) reaches a DTO or a projection without going
  through it — checkable by confirming each of the three calls it, and that nothing else in
  `src/` reads `pathLabel` off a fee structure.
- `AcademicStructureService.remove` refuses a subtree carrying fee structures, and the
  Phase 6 obligation comment is gone.
- The unit picker, the `/fees/new` empty state, and the read-only unit on the editor page.
- `src/lib/api/openapi.ts` untouched; `api-contract.test.ts` still counts 9 public paths.
- `tests/unit/fee-structure-projection.test.ts` and `tests/unit/openapi-fee-structure.test.ts`
  pass **unedited**.
- No fee test file has fewer tests than it started with.
- `npx tsc --noEmit` clean, `npm run lint` clean at 2 warnings / 0 errors, full suite green.

---

## 13. Known limitations

**A fee structure cannot be moved between units.** Decision 3. Delete and recreate. If this
proves annoying in practice it is additive to fix, and the unique key is the reason it is
not free.

**The enrichment helper adds one query per fee list.** Behind the public route's existing
300-second cache and per-IP rate limit, and one `$in` regardless of row count. Phase 5's
whole-branch review made the same trade and reached the same conclusion.

**Deleting a unit with fees is refused rather than cascaded.** An institution restructuring
its tree must delete the fees first. Refusing is the right default for something that
publishes prices, but it is friction, and Phase 6b's bulk tooling should consider a bulk
delete to match.

**Inactive units are hidden from the picker but keep their existing fees.** A fee structure
already attached to a unit that is later deactivated continues to exist and, if published,
continues to publish. Whether deactivating a unit should unpublish its fees is a real
question and deliberately not answered here.

**The delete guard is not atomic.** `countDocuments` and `deleteMany` are separate
operations, so a fee structure created against a unit in the window between them is
orphaned. Its label then derives to an empty string, which the public projection drops,
publishing a priced structure with no `classOrCourse` key. The window is narrow, the
outcome is survivable and contract-valid, and a transaction is disproportionate to it —
but the failure is silent, which is why it is written down.

---

## 14. What Phase 6b owes this phase

1. **Bulk assignment**: select N units → one `POST /api/settings/fees/bulk` → N independent
   DRAFT structures, each editable afterward. Units that already hold a structure for that
   academic year are skipped and reported, never overwritten.
2. **Configurable fee heads**: a per-institution list (Tuition, Registration, Transport, …)
   that the line-item label input suggests from while still accepting free text.
3. **Consider a bulk delete for fee structures**, so that the delete guard in §6 does not
   make restructuring an academic tree tedious.
