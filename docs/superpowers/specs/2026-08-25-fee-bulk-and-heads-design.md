# Phase 6b — Bulk Fee Assignment and Fee Heads

**Date:** 2026-08-25
**Status:** Approved for planning
**Prior specs:** `docs/superpowers/specs/2026-08-24-fee-structure-design.md` (Phase 4),
`docs/superpowers/specs/2026-08-25-academic-structure-design.md` (Phase 5),
`docs/superpowers/specs/2026-08-25-fee-structures-on-units-design.md` (Phase 6a)

---

## 1. What this is

Phase 6a made a fee structure point at an academic unit. Pricing a school one class at a
time still means filling the same form ten times, and every line item's label is typed from
memory each time. Phase 6b closes both gaps, and undoes the friction Phase 6a's delete guard
introduced.

Three capabilities, no restructuring:

- **Fee heads** — a per-institution list of the charges this institution levies (Tuition,
  Registration, Transport), each optionally carrying a default amount and frequency. A line
  item can be filled from one in a click.
- **Bulk assignment** — tick N academic units, define the line items once, get N independent
  draft fee structures.
- **Bulk delete** — select N fee structures and delete them together, so restructuring an
  academic tree is not gated behind deleting fees one at a time.

### What Phase 6b is not

**No bulk publish.** Nothing makes N fee structures public in one action. Bulk assignment
produces drafts; publishing stays a per-structure decision with its own confirmation, because
publishing is the irreversible-feeling step and the one a reviewer would want to take
deliberately.

**No fee-head enforcement.** A head is a suggestion, never a constraint. A line item may
carry any label, whether or not a head exists for it. Institutions whose charges do not fit
their own list must not be blocked by it.

**No change to the public API.** Every route here is admin-only. `src/lib/api/openapi.ts` is
untouched and the public-path count stays at **9**.

**No cross-institution templates.** Fee heads are per-institution, like everything else in
this platform. There is no shared catalogue of standard charges.

---

## 2. Decision register

| # | Decision | Chosen | Rejected alternative |
|---|---|---|---|
| 1 | What a fee head carries | Label **required**, `amount` and `frequency` **optional** | Label only (typing every amount); all three required (blocks a head whose price varies) |
| 2 | Where fee heads live | `Institution.feeHeads`, beside `facilities` | Under `academic` (fees are not academic information); a separate collection (a short list per tenant) |
| 3 | Bulk assignment against an already-priced unit | **Skip and report it by name** | Overwrite (destroys work); fail the whole batch (one collision blocks nine good units) |
| 4 | Status of bulk-created structures | **DRAFT**, always | Publishing them, which would make one click change public prices for N classes |
| 5 | Bulk delete guard | **None** — nothing references a fee structure | A confirmation-only guard, which is UI, not a service concern |
| 6 | The line-item editor | **Extracted to a shared component** | Duplicated into the bulk form, where fee-head prefill would then need building twice |
| 7 | Where fee heads are edited | `/fees/heads`, linked from the Fees header | An inline panel on the fees list (clutter); `/settings` (which is read-only account info) |
| 8 | Saving fee heads | **Replaces the list wholesale** | Per-item PATCH, which no other array in this codebase does |

---

## 3. Architecture

Nothing is restructured. Three additions, each following a pattern this codebase already has.

**Fee heads** are shaped exactly like `facilities`: a `{_id: false}` sub-document array on
`Institution`, replaced wholesale on save. They are read by the fee forms and by nothing else.

**Bulk assignment** is one service method, `FeeStructureService.createMany`, and one route.
It loads every referenced unit in one query (scoped by `institutionId`), finds which of them
already hold a structure for the target year in a second, and `insertMany`s the remainder.
Three round trips regardless of how many units are selected.

**Bulk delete** is one service method and one route, both trivial: a scoped `deleteMany` and
a count.

The one piece of refactoring is `FeeLineItemsEditor`, lifted out of `fee-structure-form.tsx`
so the bulk form uses the same editor rather than a copy. Fee-head prefill is then built once.

### A known risk, named up front

The extracted editor is used by two forms whose value types differ — the single form has
`academicUnitId: string`, the bulk form has `academicUnitIds: string[]` — while both carry
`lineItems` at the same path. It must therefore be generic over the form's values, and
react-hook-form's `Control<T>` / `UseFormRegister<T>` generics can be awkward to satisfy
through a component boundary.

**If that typing cannot be made to work without `any`,** the implementer must stop and report
rather than reaching for a cast. The fallback is to keep the editor in the single form and
duplicate it into the bulk form, accepting decision 6's rejected alternative and building
prefill twice — worse, but honest, and far better than an `any` at a form boundary that
silently stops checking every field path.

---

## 4. Data model

```ts
/**
 * What this institution charges for. A head is a suggestion the line-item editor
 * fills from, never a constraint — see §1. Defaults are optional because a charge
 * whose amount genuinely varies by class still deserves a name.
 */
const FeeHeadSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    amount: { type: Number, min: 0 },
    frequency: { type: String, enum: FEE_FREQUENCIES },
  },
  { _id: false },
);
```

On `InstitutionSchema`, beside `facilities`:

```ts
    feeHeads: { type: [FeeHeadSchema], default: undefined },
```

`default: undefined` means "never configured" reads as absent, matching `facilities`,
`gallery` and `academic.segments`. No new index: the list is read only as part of an
institution already being fetched.

`FEE_HEAD_MAX = 30`. An institution with thirty distinct charges has a different problem than
this feature solves.

---

## 5. Validation

`src/lib/validation/fee-structure.ts` gains three schemas.

```
feeHeadsSchema          { feeHeads: [{ label, amount?, frequency? }] }   max 30, labels unique
bulkCreateFeeSchema     { academicUnitIds: string[], academicYear, lineItems? }
bulkDeleteFeeSchema     { feeStructureIds: string[] }
```

- `academicUnitIds` and `feeStructureIds` use the shared `objectIdString` from
  `src/lib/validation/common.ts`, 1–100 entries, **duplicates rejected** rather than silently
  de-duplicated — a caller sending the same id twice has a bug worth surfacing.
- `feeHeads` labels must be unique after trimming, the same rule and the same reason as fee
  structure line items: a picker with two "Tuition" entries is a picker with a bug.
- `lineItems` reuses the existing `feeLineItemSchema` and the existing
  `assertFeeStructureInvariants` for the duplicate-label check. Bulk does not get its own
  copy of a rule the single path already has. The invariant runs **once, on the shared set,
  before any unit is touched** — every structure in the batch gets identical line items, so
  checking per-unit would repeat the same work N times and could half-apply a batch.

---

## 6. API surface

Admin-only, cookie session only, `assertSameOrigin` first on every mutation.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/settings/fees/heads` | The institution's fee heads |
| `PUT` | `/api/settings/fees/heads` | Replace them wholesale |
| `POST` | `/api/settings/fees/bulk` | Create N drafts, skipping already-priced units |
| `POST` | `/api/settings/fees/bulk/delete` | Delete N fee structures |

Bulk delete is a `POST` to a `/delete` sub-path rather than a `DELETE` with a body: a `DELETE`
carrying a request body is poorly supported by intermediaries and awkward to test, and this
codebase has no precedent for it.

---

## 7. Authorization

`requireInstitution()` on all four routes. No `ROLE_PERMISSIONS` entry, no new role, no
public path. Every query scoped by `institutionId` from the session.

**404-never-403 applies to both id lists.** A bulk create naming another institution's
academic unit, and a bulk delete naming another institution's fee structure, both read as
`NOT_FOUND` — not `FORBIDDEN`, and not a partial success that quietly drops the foreign ids.
A batch containing a foreign id fails whole; it is a caller bug, not a routine skip.

That distinction matters and is easy to blur: **a foreign id fails the batch, an
already-priced unit is skipped.** The first is an error, the second is the expected outcome
of a bulk operation and the reason the response reports it.

---

## 8. Bulk assignment semantics

`POST /api/settings/fees/bulk` with `{ academicUnitIds, academicYear, lineItems }`:

1. Load every named unit scoped by `institutionId`. If any is missing, throw `NOT_FOUND` —
   the whole batch fails.
2. Find existing structures for `(institutionId, academicUnitIds, academicYear)`.
3. `insertMany` a DRAFT structure for every unit **not** in that set.
4. Record one activity entry summarising the batch, not one per structure.

Response:

```ts
{ created: number, skipped: { academicUnitId: string, classOrCourse: string }[] }
```

`skipped` carries the unit's **path label**, not just its id, because the admin needs to read
which classes were left alone without cross-referencing ids.

`created: 0` with an empty `skipped` cannot happen: validation requires at least one id, and
an id that is neither created nor skipped does not exist. So `created: 0` always means every
selected unit was already priced, and `skipped` names all of them. The UI says that plainly
rather than reporting a bare zero.

---

## 9. Bulk delete

`POST /api/settings/fees/bulk/delete` with `{ feeStructureIds }`.

**Ownership must be verified before anything is deleted.** A scoped `deleteMany` alone would
not satisfy §7: given a foreign id it removes nothing for that id and reports a lower count,
silently succeeding where the spec promises the batch fails. So `removeMany` first counts
matching owned structures and throws `NOT_FOUND` unless the count equals the id list's
length. Only then does it delete.

It returns `{ deleted: number }` — the count the **database actually removed**, not the length
of the id list, for the same reason Phase 6a's `remove` was corrected to do so: reporting an
intended count hides a scoping regression.

Any id not belonging to the institution fails the batch with `NOT_FOUND`, per §7. Nothing
references a fee structure, so there is no dependency guard to write.

---

## 10. The shared line-item editor

`FeeLineItemsEditor` lifts the existing block out of `fee-structure-form.tsx` unchanged in
behaviour, plus one addition: a control that appends a row prefilled from a fee head.

- Heads with a default amount prefill amount and frequency; heads without prefill the label
  only, leaving amount at 0 for the admin to fill.
- The label field stays free text. Picking a head is a shortcut, not a mode.
- When an institution has no fee heads configured, the control is absent — not disabled, and
  not an empty dropdown. There is nothing to pick from and saying so with a link to
  `/fees/heads` is more useful than a dead control.

---

## 11. Dashboard

**`/fees`** gains a checkbox per row, a "Delete selected" action appearing only when at least
one row is selected, and a header link to `/fees/heads`. The delete confirms with the count
and warns that published structures disappear from the public API immediately.

**`/fees/bulk`**, reached from a "Bulk add" action on the Fees header: the academic tree with
a checkbox per unit (effectively-inactive units excluded, per Phase 6a §9), an academic year
field, and the shared line-item editor. Submitting reports "Created 7, skipped 3" and lists
the skipped units by path label.

**`/fees/heads`**: a repeatable row editor — label, optional amount, optional frequency —
saved wholesale. Empty state explains what heads are for.

All three follow the monochrome design system: no hue outside `text-destructive`.

---

## 12. Testing

**Unit — validation:** `feeHeads` rejects >30, rejects duplicate labels after trimming,
accepts a label-only head; `bulkCreateFeeSchema` rejects an empty id list, >100, and
duplicate ids; `bulkDeleteFeeSchema` the same.

**Integration — bulk create:** creates N drafts against N units; **skips an already-priced
unit and names it in `skipped`**; a foreign `academicUnitId` fails the whole batch with
`NOT_FOUND` and creates nothing; all-already-priced returns `created: 0` with a full
`skipped`; created structures are DRAFT with no `publishedAt`.

**Integration — bulk delete:** deletes N; returns the **actual** removed count; a foreign id
fails the batch and deletes nothing; deleting a published structure removes it from the
public API.

**Integration — fee heads:** PUT replaces wholesale; a head with no amount round-trips; the
list is per-institution and never leaks across tenants.

**Integration — routes:** each of the four rejects anonymous, Counselor, Front Desk and
platform-admin sessions, and a cross-origin write.

**The partial-failure test that matters most:** a bulk create whose id list mixes a valid unit
and a foreign one must leave the database **completely unchanged**. A batch that half-applies
before failing is the worst outcome here, and only a test that counts structures afterwards
catches it.

Every guard is mutation-checked: delete the guard, confirm the named test fails, restore.

---

## 13. Definition of done

- `Institution.feeHeads` with the optional-defaults shape; `FEE_HEAD_MAX` enforced.
- Three validation schemas, reusing `objectIdString` and `feeLineItemSchema` rather than
  redefining them.
- `createMany` and `removeMany` service methods, both tenant-scoped, both reporting counts the
  database actually produced.
- Four routes, all `requireInstitution()`, all `assertSameOrigin` first.
- `FeeLineItemsEditor` shared by both forms — **or**, if the generic typing proves impossible
  without `any`, a reported and accepted duplication (§3).
- `/fees` selection and bulk delete; `/fees/bulk`; `/fees/heads`.
- `src/lib/api/openapi.ts` untouched; public-path count still 9; the public projection and its
  tests untouched.
- `npx tsc --noEmit` clean, `npm run lint` at 2 warnings / 0 errors, full suite green.

---

## 14. Known limitations

**No bulk edit.** Having created ten structures, changing all their tuition means opening ten.
Bulk *assignment* is a creation tool. Bulk editing is a larger feature with a genuine
question — does it overwrite line items or merge them — that this phase does not answer.

**Fee heads do not propagate.** Changing a head's default amount does not touch structures
already created from it. They are a starting point, not a link. This is deliberate: a fee
already published should never change because someone edited a template.

**Bulk assignment applies one line-item set to every selected unit.** Different prices for
different groups means running it once per group, which is what the original request
described. The alternative — per-unit amounts in one form — is a spreadsheet, and a worse fit
for a settings screen.

**Skipped units are reported but not actionable.** The response names them; it does not offer
to update them. Updating is the bulk-edit feature above.

---

## 15. What a later phase might owe this one

1. **Bulk edit**, if bulk assignment proves popular enough that ten-structure corrections
   become routine.
2. **Bulk publish**, deliberately excluded here. If it is ever added it needs the same
   confirmation weight as a single publish, not less.
3. **Fee head usage reporting** — which heads are actually used, so a stale list can be
   pruned. Cheap once heads exist, and only worth building once a list has grown stale.
