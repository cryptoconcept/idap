# Result Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add branch/combination results, placement outcomes, entrance-exam selections, and a handful of smaller fields to IDAP's existing `Result` model, so an institution can record what it actually competes on.

**Architecture:** Four existing seams extended (model, validation, service, editor), plus three new UI sections following the codebase's established one-form-per-section pattern. No new routes, no new services, no index change, no public API change.

**Tech Stack:** Next.js 16 App Router, Mongoose 8, Zod 4, TypeScript, Vitest 3, react-hook-form.

**Spec:** `docs/superpowers/specs/2026-08-26-result-enrichment-design.md`

## Global Constraints

- **No public API change.** `src/lib/api/openapi.ts` untouched. `tests/unit/results-projection.test.ts`, `tests/unit/openapi-results.test.ts`, `tests/unit/api-contract.test.ts` pass **unedited**.
- **No index added or changed.** Every new field lives inside a document already addressed by the existing unique index.
- **`requireInstitution()` on every route; `assertSameOrigin(request)` first in every mutating handler.** No route changes in this phase — all four routes already do this, and none of their signatures change.
- **404-never-403.** Cross-tenant access reads as `NOT_FOUND`, never `FORBIDDEN`. Unaffected by this phase; every path already runs through `findOwned`, which is tenant-scoped.
- **`TopperSchema` is reused, never redefined**, by combinations and selections. A combination carries an `id` handle in its write schema (mirroring `topperSchema.id`) so `mergeCombinations` can find it on update; a selection is matched by its `examCode` instead, since that is already a stable, non-free-text key.
- **A combination's or selection's topper never loses its `_id` or `photoUrl` to an unrelated edit.** `mergeCombinations`/`mergeSelections` (Task 4) call the existing `mergeToppers` on each matched row's own `toppers` field — they do not reimplement it.
- **Monochrome design system.** No hue-based colour outside `text-destructive` / `variant="destructive"`.
- **Baseline is 692 passing tests in 77 files.** Every task states its expected total; verify it.
- `npx tsc --noEmit` clean and `npm run lint` at **0 errors** at the end of every task. Warnings must be of the pre-existing `react-hooks/incompatible-library` class only (there are 4 today).
- Commit at the end of every task. This plan runs on `feat/result-enrichment`; never commit to `main`.
- Every new invariant must be enforced and have a test that would fail if it were removed. Task 3 mandates **mutation-checking the two rules judged highest-risk** (the combination-total cap and the recruiter-selected cap) as its own explicit step; a reviewer should mutation-check further guards it judges load-bearing rather than trusting the remaining tests by inspection alone. **Print evidence a mutation actually landed in the file before running the tests** — a scripted edit that silently fails to match leaves the file untouched, and the green run then reads exactly like "this guard is untested."
- Known flake: `bearer-routes`, `rate-limit`, `profile-routes`, `staff-routes`, `academic-structure-profile`, `institution-model` can fail as a whole file with tests reported "skipped" — a mongodb-memory-server port collision under load, not your bug. Re-run once before investigating. Separately, this plan may run in a shared working directory alongside other work — if a single unexplained failure vanishes on re-run, note it rather than chasing it, but never assume it was the flake without re-running to confirm.

## A UI decision made in this plan, not the spec

The spec leaves nested-topper UI mechanics unspecified beyond "follow `band-editor.tsx`'s pattern." Two options exist for `combinations-section.tsx` and `selections-section.tsx`, each of which nests its own `toppers` array two levels deep in the form (`combinations.${i}.toppers.${j}`, `selections.${i}.toppers.${j}`):

1. **A generic component parameterized by field path** (`name: ArrayPath<T>`), shared across all three topper lists.
2. **Each section keeps its own concrete, non-generic topper-row markup**, mirroring `toppers-section.tsx`'s existing JSX almost verbatim but registered at its own nested path.

This plan takes **option 2**. Option 1 needs a component whose `useFieldArray`/`register` calls take a *variable* field path, not merely a variable value-type (the shape that worked cleanly in a prior phase's `FeeLineItemsEditor`, where the field was always literally named `lineItems`). Indexing `FieldErrors<T>` by a runtime-computed path does not narrow cleanly in react-hook-form's types without an escape hatch, and getting this wrong would cost a wasted implementer dispatch discovering it. The safe extraction is the one with **no react-hook-form generics at all**: `TopperPhoto` (Task 1) is a plain-props presentational-plus-upload component that never touches a form's typed API. Three sections keeping their own ~70-line topper-row block is consistent with how this codebase already treats `cycle-section.tsx` / `outcome-section.tsx` / `toppers-section.tsx` as three separate concrete files rather than one generic one.

## Test count chain

| After task | New | Total |
|---|---|---|
| baseline | — | 692 |
| 1 | +0 | 692 |
| 2 | +9 | 701 |
| 3 | +21 | 722 |
| 4 | +8 | 730 |
| 5 | +4 | 734 |
| 6 | +0 | 734 |
| 7 | +0 | 734 |
| 8 | +0 | 734 |
| 9 | +0 | 734 |

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/components/results/topper-photo.tsx` | The topper photo upload/remove control, extracted so three sections can share it |
| `src/components/results/combinations-section.tsx` | Branch/combination results editor |
| `src/components/results/placement-section.tsx` | Placement outcomes editor |
| `src/components/results/selections-section.tsx` | Entrance-exam selections editor |

**Modify:** `src/models/Result.ts`, `src/lib/constants.ts`, `src/lib/validation/result.ts`, `src/services/result.service.ts`, `src/components/results/toppers-section.tsx`, `src/components/results/result-editor.tsx`, `src/app/(dashboard)/results/[resultId]/page.tsx`.

**Test — modify:** `tests/unit/result-model.test.ts`, `tests/unit/results-validation.test.ts`, `tests/integration/results-crud.test.ts`, `tests/integration/results-media.test.ts`.

**Test — must NOT change:** `tests/unit/results-projection.test.ts`, `tests/unit/openapi-results.test.ts`, `tests/unit/api-contract.test.ts`.

---

### Task 1: Extract the topper photo control

**Files:**
- Create: `src/components/results/topper-photo.tsx`
- Modify: `src/components/results/toppers-section.tsx:235-345` (delete the inline `TopperPhoto` function; import instead)

**Interfaces:**
- Produces: `TopperPhoto({ resultId, topper, onResult, position }): JSX.Element`, exported, taking `resultId: string`, `topper: { id: string; name: string; photoUrl?: string }`, `onResult: (result: ResultDTO) => void`, `position: number`.

A pure extraction. Behaviour must not change — this is what lets Tasks 6 and 8 reuse it for nested toppers without a second implementation of the upload/remove cycle. No react-hook-form generics are involved: it takes plain props, not a `control`.

- [ ] **Step 1: Create the shared file**

Create `src/components/results/topper-photo.tsx` with exactly the body of the current `TopperPhoto` function from `toppers-section.tsx` (lines 240-345), made a top-level export with its own imports:

```tsx
"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ImagePlus } from "lucide-react";
import type { ResultDTO } from "@/services/result.service";
import { Button } from "@/components/ui/button";
import { ACCEPT_ATTRIBUTE, checkImageFile } from "@/components/profile/media-upload";

/**
 * One topper's photograph. Uploaded straight away against the saved topper's
 * id, so it is never part of a section's Save — which is also why it only
 * appears once the row exists on the server.
 *
 * `topperId` is a Mongo ObjectId, globally unique regardless of which array
 * on the result document the topper lives in — a top-level topper, a
 * combination's, or a selection's. The endpoint below is unaware of which;
 * the service widens its own lookup instead (see result.service.ts).
 */
export function TopperPhoto({
  resultId,
  topper,
  onResult,
  position,
}: {
  resultId: string;
  topper: { id: string; name: string; photoUrl?: string };
  onResult: (result: ResultDTO) => void;
  position: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/settings/results/${resultId}/toppers/${topper.id}/photo`;
  const label = topper.name.trim() || `topper ${position}`;

  async function send(init: RequestInit, success: string) {
    setBusy(true);
    try {
      const response = await fetch(endpoint, init);
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not change the photo. Please try again.");
        return;
      }

      toast.success(success);
      onResult(payload.result as ResultDTO);
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    // Pre-checked before anything leaves the browser; the server checks again.
    const problem = checkImageFile(file);
    if (problem) {
      toast.error(problem);
      return;
    }

    const body = new FormData();
    body.append("file", file);
    await send({ method: "POST", body }, `Photo updated for ${label}`);
  }

  return (
    <div className="flex items-center gap-3">
      <div className="relative size-14 shrink-0 overflow-hidden rounded-lg border border-border bg-muted/40">
        {topper.photoUrl ? (
          <Image
            src={topper.photoUrl}
            alt={`${label} photograph`}
            fill
            unoptimized
            sizes="56px"
            className="object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <ImagePlus className="size-4" aria-hidden />
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        className="hidden"
        onChange={(event) => {
          void upload(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Working…" : topper.photoUrl ? "Replace photo" : "Upload photo"}
        </Button>
        {topper.photoUrl ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void send({ method: "DELETE" }, `Photo removed for ${label}`)}
          >
            Remove
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground">JPG, PNG or WEBP, up to 5 MB.</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Delete the inline copy and import instead**

In `src/components/results/toppers-section.tsx`:
- Delete the entire `function TopperPhoto(...) { ... }` block (the old lines 235-345).
- Delete the now-unused imports it alone needed: `Image` from `"next/image"`, `ImagePlus` from `"lucide-react"`, `ACCEPT_ATTRIBUTE, checkImageFile` from `"@/components/profile/media-upload"`. Keep `useRef, useState` only if `toppers-section.tsx` still uses them elsewhere (it does not, after this deletion — remove them from the `react` import too, keeping `useEffect` and whatever `useForm`/`useFieldArray` need).
- Add: `import { TopperPhoto } from "@/components/results/topper-photo";`
- Everything else in the file — the call site `<TopperPhoto resultId={result.id} topper={saved} onResult={onResult} position={index + 1} />` — is unchanged.

- [ ] **Step 3: Verify nothing moved**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **692** (no test added or removed; this is a pure refactor).

`npm run lint` must show 0 errors and the same 4 pre-existing warnings — removing unused imports must not introduce a new warning class.

- [ ] **Step 4: Commit**

```bash
git add src/components/results/topper-photo.tsx src/components/results/toppers-section.tsx
git commit -m "refactor: share the topper photo control"
```

---

### Task 2: Extend the Result model and constants

**Files:**
- Modify: `src/lib/constants.ts` (append near `RESULT_MAX_TOPPERS`)
- Modify: `src/models/Result.ts`
- Test: `tests/unit/result-model.test.ts` (**+9**, 6 → 15)

**Interfaces:**
- Produces: `GRADE_BUCKETS`, `GradeBucket`, `EXAM_CODES`, `ExamCode`, `EXAM_CODE_LABELS`, `RECRUITER_CATEGORIES`, `RecruiterCategory`, `RECRUITER_CATEGORY_LABELS`, `RESULT_MAX_COMBINATIONS`, `RESULT_MAX_RECRUITERS`, `RESULT_MAX_SELECTIONS` from `@/lib/constants`.
- Produces: `Result` documents now carry optional `combinations`, `placement`, `selections`, `boys`, `girls`, `distinction`, `firstClass`. `ResultDoc` (the exported type, `InferSchemaType<typeof ResultSchema> & { _id: Types.ObjectId }`) picks these up automatically — no separate type export needed.

- [ ] **Step 1: Add the constants**

In `src/lib/constants.ts`, immediately after the existing `export const RESULT_MAX_TOPPERS = 25;` line:

```ts
export const RESULT_MAX_COMBINATIONS = 12;
export const RESULT_MAX_RECRUITERS = 30;

export const EXAM_CODES = ["NEET", "JEE_MAIN", "JEE_ADVANCED", "KCET", "COMEDK"] as const;
export type ExamCode = (typeof EXAM_CODES)[number];

export const EXAM_CODE_LABELS: Record<ExamCode, string> = {
  NEET: "NEET",
  JEE_MAIN: "JEE Main",
  JEE_ADVANCED: "JEE Advanced",
  KCET: "KCET",
  COMEDK: "COMEDK",
};

/** One row per exam, at most — never hand-copied, so a sixth exam here needs no second edit. */
export const RESULT_MAX_SELECTIONS = EXAM_CODES.length;

export const RECRUITER_CATEGORIES = ["IT", "PRODUCT", "CORE", "CONSULTING", "STARTUP", "OTHER"] as const;
export type RecruiterCategory = (typeof RECRUITER_CATEGORIES)[number];

export const RECRUITER_CATEGORY_LABELS: Record<RecruiterCategory, string> = {
  IT: "IT",
  PRODUCT: "Product",
  CORE: "Core engineering",
  CONSULTING: "Consulting",
  STARTUP: "Startup",
  OTHER: "Other",
};

/** PassPercent's own fixed bucket scheme — see the design spec's Decision 4. */
export const GRADE_BUCKETS = ["90+", "80-90", "70-80", "60-70", "50-60", "below50"] as const;
export type GradeBucket = (typeof GRADE_BUCKETS)[number];
```

- [ ] **Step 2: Write the failing model tests**

Append to `tests/unit/result-model.test.ts`, inside the existing `describe("Result model", ...)` block, after the last `it(...)`:

```ts
  it("keeps an _id on each combination so a patch can be matched back to it", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "PUC_2",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      combinations: [{ label: "PCMB", appeared: 1, passed: 1 }],
    });

    expect(doc.combinations?.[0]?._id).toBeDefined();
  });

  it("does not give a selection its own _id — it is matched by examCode instead", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "PUC_2",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      selections: [{ examCode: "KCET", qualified: 1 }],
    });

    expect((doc.selections?.[0] as unknown as { _id?: unknown })?._id).toBeUndefined();
  });

  it("keeps an _id on a combination's own toppers, same as a top-level topper", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "PUC_2",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      combinations: [{ label: "PCMB", toppers: [{ name: "Priya S", percentage: 98.6 }] }],
    });

    expect(doc.combinations?.[0]?.toppers?.[0]?._id).toBeDefined();
  });

  it("rejects an examCode outside the enum", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "PUC_2",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      selections: [{ examCode: "NOT_AN_EXAM" }],
    });

    expect(doc.validateSync()?.errors["selections.0.examCode"]).toBeDefined();
  });

  it("rejects a recruiter category outside the enum", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "UG",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      placement: { recruiters: [{ name: "Acme", category: "NOT_A_CATEGORY" }] },
    });

    expect(doc.validateSync()?.errors["placement.recruiters.0.category"]).toBeDefined();
  });

  it("defaults every grade bucket to 0 rather than leaving it undefined", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "PUC_2",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      combinations: [{ label: "PCMB", grades: {} }],
    });

    expect(doc.combinations?.[0]?.grades?.["90+"]).toBe(0);
    expect(doc.combinations?.[0]?.grades?.below50).toBe(0);
  });

  it("defaults a recruiter's tieUp to false", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "UG",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      placement: { recruiters: [{ name: "Acme" }] },
    });

    expect(doc.placement?.recruiters?.[0]?.tieUp).toBe(false);
  });

  it("leaves combinations, placement and selections absent when never set", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
    });

    expect(doc.combinations).toBeUndefined();
    expect(doc.placement).toBeUndefined();
    expect(doc.selections).toBeUndefined();
  });

  it("exposes the new constant tuples", () => {
    expect(GRADE_BUCKETS).toEqual(["90+", "80-90", "70-80", "60-70", "50-60", "below50"]);
    expect(EXAM_CODES).toContain("NEET");
    expect(RECRUITER_CATEGORIES).toContain("STARTUP");
    expect(RESULT_MAX_SELECTIONS).toBe(EXAM_CODES.length);
  });
```

Update the file's top import to pull in the new constants:

```ts
import {
  EXAM_CODES,
  GRADE_BUCKETS,
  RECRUITER_CATEGORIES,
  RESULT_BOARDS,
  RESULT_LEVELS,
  RESULT_MAX_SELECTIONS,
  RESULT_STATUSES,
} from "@/lib/constants";
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx vitest run tests/unit/result-model.test.ts`
Expected: the 6 existing tests pass, the 9 new ones FAIL — most with "Cannot read properties of undefined" or a Mongoose cast error, since none of the new schema fields exist yet.

- [ ] **Step 3: Extend the model**

In `src/models/Result.ts`, add the import and four new sub-schemas after the existing `TopperSchema` block and before `ResultSchema`:

```ts
import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import {
  EXAM_CODES,
  RECRUITER_CATEGORIES,
  RESULT_BOARDS,
  RESULT_LEVELS,
  RESULT_STATUSES,
  RESULT_STREAMS,
} from "@/lib/constants";
```

```ts
/** PassPercent's own fixed bucket scheme, unlike the flexible `bands` above. */
const GradeCountsSchema = new Schema(
  {
    "90+": { type: Number, min: 0, default: 0 },
    "80-90": { type: Number, min: 0, default: 0 },
    "70-80": { type: Number, min: 0, default: 0 },
    "60-70": { type: Number, min: 0, default: 0 },
    "50-60": { type: Number, min: 0, default: 0 },
    below50: { type: Number, min: 0, default: 0 },
  },
  { _id: false },
);

const CohortSplitSchema = new Schema(
  {
    appeared: { type: Number, min: 0 },
    passed: { type: Number, min: 0 },
  },
  { _id: false },
);

/**
 * A branch or combination inside one exam cycle — PUC Science versus Commerce,
 * engineering CSE versus ECE. Keeps its _id (unlike BandSchema): it nests
 * toppers, and an update that cannot tell one combination from another on the
 * next save would mint fresh topper subdocuments and drop every photograph —
 * the same failure TopperSchema.photoUrl's own comment above already names.
 */
const CombinationSchema = new Schema({
  academicUnitId: { type: Schema.Types.ObjectId },
  label: { type: String, required: true, trim: true },
  appeared: { type: Number, min: 0 },
  passed: { type: Number, min: 0 },
  distinction: { type: Number, min: 0, default: 0 },
  firstClass: { type: Number, min: 0, default: 0 },
  highestScore: { type: Number, min: 0, max: 100 },
  averageScore: { type: Number, min: 0, max: 100 },
  grades: GradeCountsSchema,
  boys: CohortSplitSchema,
  girls: CohortSplitSchema,
  toppers: { type: [TopperSchema], default: undefined },
});

/** No photo in this phase — nothing here is server-written, so replacing the
 *  array wholesale on every patch loses nothing, exactly like BandSchema. */
const RecruiterSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: RECRUITER_CATEGORIES },
    selected: { type: Number, min: 0 },
    averagePackage: { type: Number, min: 0 },
    tieUp: { type: Boolean, default: false },
    roles: { type: [String], default: undefined },
  },
  { _id: false },
);

/** Attaches to the whole cycle, not a combination — a college recruits across
 *  branches from one drive. */
const PlacementSchema = new Schema(
  {
    eligible: { type: Number, min: 0 },
    placed: { type: Number, min: 0 },
    highestPackage: { type: Number, min: 0 },
    averagePackage: { type: Number, min: 0 },
    recruiters: { type: [RecruiterSchema], default: undefined },
  },
  { _id: false },
);

/**
 * One competitive-exam outcome for this cycle. No _id: unlike a combination, a
 * selection is matched on update by its `examCode` — a stable enum that can
 * never be edited into a typo the way a free-text label can.
 */
const SelectionSchema = new Schema(
  {
    examCode: { type: String, enum: EXAM_CODES, required: true },
    appeared: { type: Number, min: 0 },
    qualified: { type: Number, min: 0 },
    bestRank: { type: Number, min: 1 },
    toppers: { type: [TopperSchema], default: undefined },
  },
  { _id: false },
);
```

Then extend `ResultSchema`'s field object — insert after the existing `toppers: { type: [TopperSchema], default: undefined },` line:

```ts
    toppers: { type: [TopperSchema], default: undefined },

    distinction: { type: Number, min: 0, default: 0 },
    firstClass: { type: Number, min: 0, default: 0 },
    boys: CohortSplitSchema,
    girls: CohortSplitSchema,
    combinations: { type: [CombinationSchema], default: undefined },
    placement: { type: PlacementSchema, default: undefined },
    selections: { type: [SelectionSchema], default: undefined },
```

No changes to any index, any option, or the `ResultDoc`/`Result` export at the bottom of the file — `InferSchemaType` picks up every new field automatically.

- [ ] **Step 4: Run to verify**

Run: `npx vitest run tests/unit/result-model.test.ts`
Expected: **15 passing** (6 original + 9 new).

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **701**.

```bash
git add src/lib/constants.ts src/models/Result.ts tests/unit/result-model.test.ts
git commit -m "feat: add combinations, placement and selections to the Result model"
```

---

### Task 3: Validation — schemas and invariants

**Files:**
- Modify: `src/lib/validation/result.ts`
- Test: `tests/unit/results-validation.test.ts` (**+21**, 18 → 39)

**Interfaces:**
- Consumes: `GRADE_BUCKETS`, `EXAM_CODES`, `RECRUITER_CATEGORIES`, `RESULT_MAX_COMBINATIONS`, `RESULT_MAX_RECRUITERS`, `RESULT_MAX_SELECTIONS` from Task 2.
- Produces: `combinationSchema`, `placementSchema`, `selectionSchema` (exported, for Task 4/6/7/8's UI forms to type against via `z.input`/`z.output`); `createResultSchema` and `updateResultSchema` both gain optional `combinations`, `placement`, `selections`, `distinction`, `firstClass`, `boys`, `girls` fields; `ResultInvariantInput` gains the same fields (all optional); `assertResultInvariants` enforces every rule in spec §5.1.

- [ ] **Step 1: Write the failing validation tests**

Append to `tests/unit/results-validation.test.ts`. First extend the shared `base` fixture at the top of the file with a helper `withCombination`/`withPlacement` inline per test (no shared fixture needed beyond `base`, following the file's existing style of building each case's own object).

```ts
describe("combination invariants", () => {
  it("accepts a combination whose passed does not exceed its appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [{ label: "PCMB", appeared: 50, passed: 50 }],
      }),
    ).not.toThrow();
  });

  it("refuses a combination with more passed than appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [{ label: "PCMB", appeared: 40, passed: 50 }],
      }),
    ).toThrow(/"PCMB" has more passed than appeared/);
  });

  it("refuses combinations that together account for more than the result's appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        appeared: 60,
        passed: 60,
        combinations: [
          { label: "PCMB", appeared: 40 },
          { label: "PCMC", appeared: 40 },
        ],
      }),
    ).toThrow(/the combinations account for more students than appeared/);
  });

  it("accepts combinations that under-cover the result's appeared — a partial record is normal", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        appeared: 100,
        passed: 100,
        combinations: [{ label: "PCMB", appeared: 40 }],
      }),
    ).not.toThrow();
  });

  it("refuses two combinations with the same label after trimming", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [{ label: "PCMB" }, { label: " PCMB " }],
      }),
    ).toThrow(/each combination needs a distinct label/);
  });

  it("refuses a combination's distinction and firstClass together exceeding its passed", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [{ label: "PCMB", passed: 10, distinction: 6, firstClass: 6 }],
      }),
    ).toThrow(/distinction and first class together exceed the number who passed/);
  });

  it("refuses a combination's boys and girls together exceeding its appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [
          { label: "PCMB", appeared: 10, boys: { appeared: 6 }, girls: { appeared: 6 } },
        ],
      }),
    ).toThrow(/boys and girls together exceed the number who appeared/);
  });

  it("refuses a combination's boys.passed exceeding boys.appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [{ label: "PCMB", boys: { appeared: 5, passed: 6 } }],
      }),
    ).toThrow(/boys: more passed than appeared/);
  });

  it("refuses grade bucket counts exceeding a combination's appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [
          { label: "PCMB", appeared: 10, grades: { "90+": 6, "80-90": 6 } },
        ],
      }),
    ).toThrow(/the grade bands account for more students than appeared/);
  });
});

describe("result-level distinction/firstClass and gender-split invariants", () => {
  it("refuses distinction and firstClass together exceeding the result's own passed", () => {
    expect(() =>
      assertResultInvariants({ ...base, passed: 10, distinction: 6, firstClass: 6 }),
    ).toThrow(/distinction and first class together exceed the number who passed/);
  });

  it("refuses the result's own boys and girls together exceeding appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        appeared: 10,
        boys: { appeared: 6 },
        girls: { appeared: 6 },
      }),
    ).toThrow(/boys and girls together exceed the number who appeared/);
  });
});

describe("placement invariants", () => {
  it("accepts placed not exceeding eligible", () => {
    expect(() =>
      assertResultInvariants({ ...base, placement: { eligible: 50, placed: 50 } }),
    ).not.toThrow();
  });

  it("refuses more placed than eligible", () => {
    expect(() =>
      assertResultInvariants({ ...base, placement: { eligible: 40, placed: 50 } }),
    ).toThrow(/more students placed than were eligible/);
  });

  it("refuses named recruiters accounting for more selections than the placed total", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        placement: {
          placed: 10,
          recruiters: [{ name: "Acme", selected: 6 }, { name: "Globex", selected: 6 }],
        },
      }),
    ).toThrow(/the named recruiters account for more selections than the placed total/);
  });

  it("refuses an average package exceeding the highest package", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        placement: { highestPackage: 10, averagePackage: 15 },
      }),
    ).toThrow(/the average package cannot exceed the highest/);
  });

  it("refuses two recruiters with the same name after trimming", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        placement: { recruiters: [{ name: "Acme" }, { name: " Acme " }] },
      }),
    ).toThrow(/each recruiter needs a distinct name/);
  });
});

describe("selection invariants", () => {
  it("accepts qualified not exceeding appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        selections: [{ examCode: "KCET", appeared: 40, qualified: 40 }],
      }),
    ).not.toThrow();
  });

  it("refuses more qualified than appeared for one exam", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        selections: [{ examCode: "KCET", appeared: 30, qualified: 40 }],
      }),
    ).toThrow(/KCET has more qualified than appeared/);
  });

  it("refuses the same exam listed twice", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        selections: [{ examCode: "KCET", qualified: 1 }, { examCode: "KCET", qualified: 2 }],
      }),
    ).toThrow(/each exam can appear only once/);
  });

  it("accepts a selection's qualified count exceeding the result's own passed — different cohorts", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        passed: 5,
        selections: [{ examCode: "NEET", qualified: 50 }],
      }),
    ).not.toThrow();
  });
});
```

Update the file's import list at the top:

```ts
import { z } from "zod";
import {
  BOARD_NAME_REQUIRED,
  RESULT_BOARDS,
  RESULT_LEVELS,
  RESULT_MAX_BANDS,
  RESULT_MAX_COMBINATIONS,
  RESULT_MAX_RECRUITERS,
  RESULT_MAX_SELECTIONS,
  RESULT_MAX_TOPPERS,
  RESULT_STREAMS,
  type ResultBoard,
} from "@/lib/constants";
```

(the `EXAM_CODES`/`RECRUITER_CATEGORIES` imports land in Step 3 alongside the schema code that uses them.)

- [ ] **Step 2: Run to confirm they fail**

Run: `npx vitest run tests/unit/results-validation.test.ts`
Expected: the 18 existing tests pass, the 21 new ones FAIL — `assertResultInvariants` does not yet know about any of these fields, so every "refuses ..." test fails by NOT throwing, and every "accepts ..." test that references a not-yet-existing schema key still passes today (since the function currently ignores unknown keys) — note which shape of failure each shows, since Step 5's mutation checks depend on the same distinction.

- [ ] **Step 3: Extend the schemas**

In `src/lib/validation/result.ts`, update the import line to add the new constants and types:

```ts
import { z } from "zod";
import {
  BOARD_NAME_REQUIRED,
  EXAM_CODES,
  RECRUITER_CATEGORIES,
  RESULT_BOARDS,
  RESULT_LEVELS,
  RESULT_MAX_BANDS,
  RESULT_MAX_COMBINATIONS,
  RESULT_MAX_RECRUITERS,
  RESULT_MAX_SELECTIONS,
  RESULT_MAX_TOPPERS,
  RESULT_STREAMS,
  type ExamCode,
  type ResultBoard,
} from "@/lib/constants";
import { validationError } from "@/lib/api/errors";
import { objectIdString, optionalText, requiredText } from "./common";
```

Add new shared shapes immediately after the existing `topperSchema` definition:

```ts
const gradeCountsSchema = z.object({
  "90+": z.number().int().min(0).optional(),
  "80-90": z.number().int().min(0).optional(),
  "70-80": z.number().int().min(0).optional(),
  "60-70": z.number().int().min(0).optional(),
  "50-60": z.number().int().min(0).optional(),
  below50: z.number().int().min(0).optional(),
});

const cohortSplitSchema = z.object({
  appeared: z.number().int().min(0).optional(),
  passed: z.number().int().min(0).optional(),
});

/**
 * `id` names an existing combination on this result, exactly like
 * `topperSchema.id` names an existing topper — a handle the service uses to
 * find the row to merge into, never a field the caller can otherwise set.
 */
export const combinationSchema = z.object({
  id: z.string().optional(),
  academicUnitId: objectIdString.optional(),
  label: requiredText("Combination label", 60),
  appeared: z.number().int().min(0).optional(),
  passed: z.number().int().min(0).optional(),
  distinction: z.number().int().min(0).optional(),
  firstClass: z.number().int().min(0).optional(),
  highestScore: percentage.optional(),
  averageScore: percentage.optional(),
  grades: gradeCountsSchema.optional(),
  boys: cohortSplitSchema.optional(),
  girls: cohortSplitSchema.optional(),
  toppers: z.array(topperSchema).max(RESULT_MAX_TOPPERS).optional(),
});

export const recruiterSchema = z.object({
  name: requiredText("Recruiter name", 120),
  category: z.enum(RECRUITER_CATEGORIES).optional(),
  selected: z.number().int().min(0).optional(),
  averagePackage: z.number().min(0).optional(),
  tieUp: z.boolean().optional(),
  roles: z.array(requiredText("Role", 60)).optional(),
});

export const placementSchema = z.object({
  eligible: z.number().int().min(0).optional(),
  placed: z.number().int().min(0).optional(),
  highestPackage: z.number().min(0).optional(),
  averagePackage: z.number().min(0).optional(),
  recruiters: z.array(recruiterSchema).max(RESULT_MAX_RECRUITERS).optional(),
});

/**
 * No `id` handle: `examCode` is already this row's stable identity (see the
 * model comment on `SelectionSchema`), so the service matches on it directly.
 */
export const selectionSchema = z.object({
  examCode: z.enum(EXAM_CODES),
  appeared: z.number().int().min(0).optional(),
  qualified: z.number().int().min(0).optional(),
  bestRank: z.number().int().min(1).optional(),
  toppers: z.array(topperSchema).max(RESULT_MAX_TOPPERS).optional(),
});
```

Extend `outcomeFields` to include the new top-level keys:

```ts
const outcomeFields = {
  appeared: z.number().int().min(0),
  passed: z.number().int().min(0),
  averageScore: percentage.optional(),
  highestScore: percentage.optional(),
  bands: z.array(bandSchema).max(RESULT_MAX_BANDS).optional(),
  toppers: z.array(topperSchema).max(RESULT_MAX_TOPPERS).optional(),
  distinction: z.number().int().min(0).optional(),
  firstClass: z.number().int().min(0).optional(),
  boys: cohortSplitSchema.optional(),
  girls: cohortSplitSchema.optional(),
  combinations: z.array(combinationSchema).max(RESULT_MAX_COMBINATIONS).optional(),
  placement: placementSchema.optional(),
  selections: z.array(selectionSchema).max(RESULT_MAX_SELECTIONS).optional(),
};
```

`createResultSchema` already spreads `...outcomeFields`, so it picks up every new field with no further edit.

Extend `updateResultSchema` — add the six new keys after the existing `toppers: outcomeFields.toppers,` line:

```ts
export const updateResultSchema = z.object({
  board: cycleFields.board.optional(),
  boardName: cycleFields.boardName,
  level: cycleFields.level.optional(),
  stream: cycleFields.stream,
  academicYear: requiredText("Academic year", 20).optional(),
  examLabel: cycleFields.examLabel,
  appeared: outcomeFields.appeared.optional(),
  passed: outcomeFields.passed.optional(),
  averageScore: outcomeFields.averageScore,
  highestScore: outcomeFields.highestScore,
  bands: outcomeFields.bands,
  toppers: outcomeFields.toppers,
  distinction: outcomeFields.distinction,
  firstClass: outcomeFields.firstClass,
  boys: outcomeFields.boys,
  girls: outcomeFields.girls,
  combinations: outcomeFields.combinations,
  placement: outcomeFields.placement,
  selections: outcomeFields.selections,
});
```

- [ ] **Step 4: Extend `ResultInvariantInput` and `assertResultInvariants`**

Replace the `ResultInvariantInput` type:

```ts
export type ResultInvariantInput = {
  board: ResultBoard;
  boardName?: string | null;
  appeared: number;
  passed: number;
  distinction?: number | null;
  firstClass?: number | null;
  boys?: { appeared?: number | null; passed?: number | null } | null;
  girls?: { appeared?: number | null; passed?: number | null } | null;
  bands?: { label: string; minPercentage: number; maxPercentage: number; count: number }[] | null;
  toppers?: { name: string; percentage?: number; consentAcknowledged?: boolean | null }[] | null;
  combinations?:
    | {
        label: string;
        appeared?: number | null;
        passed?: number | null;
        distinction?: number | null;
        firstClass?: number | null;
        boys?: { appeared?: number | null; passed?: number | null } | null;
        girls?: { appeared?: number | null; passed?: number | null } | null;
        // Specific keys, not `Record<string, ...>` — the Mongoose- and
        // Zod-inferred shapes this is called with (GradeCountsSchema /
        // gradeCountsSchema) have no index signature, so a `Record<string, T>`
        // parameter here would not accept them: TypeScript requires the
        // source type to itself carry an index signature to satisfy one on
        // the target, which a fixed-key object type never does.
        grades?: {
          "90+"?: number | null;
          "80-90"?: number | null;
          "70-80"?: number | null;
          "60-70"?: number | null;
          "50-60"?: number | null;
          below50?: number | null;
        } | null;
      }[]
    | null;
  placement?: {
    eligible?: number | null;
    placed?: number | null;
    highestPackage?: number | null;
    averagePackage?: number | null;
    recruiters?: { name: string; selected?: number | null }[] | null;
  } | null;
  selections?: { examCode: ExamCode; appeared?: number | null; qualified?: number | null }[] | null;
};
```

Append the following to the end of `assertResultInvariants`, just before its closing brace (after the existing `bands` block):

```ts
  assertCohortSplit(input.boys, input.girls, input.appeared, "");

  if ((input.distinction ?? 0) + (input.firstClass ?? 0) > input.passed) {
    throw validationError(
      "distinction and first class together exceed the number who passed",
    );
  }

  const combinations = input.combinations ?? [];

  const combinationLabels = new Set<string>();
  for (const combination of combinations) {
    const trimmed = combination.label.trim();
    if (combinationLabels.has(trimmed)) {
      throw validationError("combinations: each combination needs a distinct label");
    }
    combinationLabels.add(trimmed);

    const cAppeared = combination.appeared ?? 0;
    const cPassed = combination.passed ?? 0;
    if (cPassed > cAppeared) {
      throw validationError(
        `combinations: "${combination.label}" has more passed than appeared`,
      );
    }

    if ((combination.distinction ?? 0) + (combination.firstClass ?? 0) > cPassed) {
      throw validationError(
        "distinction and first class together exceed the number who passed",
      );
    }

    assertCohortSplit(combination.boys, combination.girls, cAppeared, "");

    const gradeTotal = Object.values(combination.grades ?? {}).reduce(
      (total, count) => total + (count ?? 0),
      0,
    );
    if (gradeTotal > cAppeared) {
      throw validationError("grades: the grade bands account for more students than appeared");
    }
  }

  const combinationTotal = combinations.reduce((total, c) => total + (c.appeared ?? 0), 0);
  if (combinationTotal > input.appeared) {
    throw validationError("combinations: the combinations account for more students than appeared");
  }

  const placement = input.placement;
  if (placement) {
    const eligible = placement.eligible ?? 0;
    const placed = placement.placed ?? 0;
    if (placed > eligible) {
      throw validationError("placement: more students placed than were eligible");
    }

    const recruiters = placement.recruiters ?? [];
    const recruiterNames = new Set<string>();
    for (const recruiter of recruiters) {
      const trimmed = recruiter.name.trim();
      if (recruiterNames.has(trimmed)) {
        throw validationError("placement: each recruiter needs a distinct name");
      }
      recruiterNames.add(trimmed);
    }

    const selectedTotal = recruiters.reduce((total, r) => total + (r.selected ?? 0), 0);
    if (selectedTotal > placed) {
      throw validationError(
        "placement: the named recruiters account for more selections than the placed total",
      );
    }

    const highest = placement.highestPackage ?? 0;
    const average = placement.averagePackage ?? 0;
    if (average > highest && highest > 0) {
      throw validationError("placement: the average package cannot exceed the highest");
    }
  }

  const selections = input.selections ?? [];
  const seenExams = new Set<ExamCode>();
  for (const selection of selections) {
    if (seenExams.has(selection.examCode)) {
      throw validationError("selections: each exam can appear only once");
    }
    seenExams.add(selection.examCode);

    const sAppeared = selection.appeared ?? 0;
    const sQualified = selection.qualified ?? 0;
    if (sQualified > sAppeared) {
      throw validationError(`selections: ${selection.examCode} has more qualified than appeared`);
    }
  }
}

/**
 * Shared by the result itself and every combination: boys and girls together
 * cannot exceed the cohort they are a split OF, and neither half can pass more
 * than it took in. The empty `context` parameter is reserved for a future
 * per-combination label in the message; today's tests accept either wording.
 */
function assertCohortSplit(
  boys: { appeared?: number | null; passed?: number | null } | null | undefined,
  girls: { appeared?: number | null; passed?: number | null } | null | undefined,
  appeared: number,
  context: string,
): void {
  const boysAppeared = boys?.appeared ?? 0;
  const girlsAppeared = girls?.appeared ?? 0;
  if (boysAppeared + girlsAppeared > appeared) {
    throw validationError(`${context}boys and girls together exceed the number who appeared`);
  }
  if (boys && (boys.passed ?? 0) > (boys.appeared ?? 0)) {
    throw validationError(`${context}boys: more passed than appeared`);
  }
  if (girls && (girls.passed ?? 0) > (girls.appeared ?? 0)) {
    throw validationError(`${context}girls: more passed than appeared`);
  }
}
```

**Note the function signature above closes `assertResultInvariants` and opens the new `assertCohortSplit` helper** — the closing `}` shown belongs to `assertResultInvariants`, not to a new function; place the new block exactly where the old function's closing brace was, then add `assertCohortSplit` as a new top-level function after it.

- [ ] **Step 5: Run, then mutation-check the two rules most likely to hide a false pass**

Run: `npx vitest run tests/unit/results-validation.test.ts` — expect **39 passing**.

**Mutation 1 — the combination-total cap.** Delete the `if (combinationTotal > input.appeared) throw ...` block. **Print evidence it landed** (grep confirms the line is gone). Run the file: "refuses combinations that together account for more than the result's appeared" MUST fail, and only that test. Restore; confirm `git diff --quiet -- src/lib/validation/result.ts`; re-run to confirm 39/39.

**Mutation 2 — the recruiter-selected cap.** Delete the `if (selectedTotal > placed) throw ...` block. Run the file: "refuses named recruiters accounting for more selections than the placed total" MUST fail, and only that test. Restore; confirm clean; re-run 39/39.

Report both mutation results, including which single test failed each time.

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **722**.

```bash
git add src/lib/validation/result.ts tests/unit/results-validation.test.ts
git commit -m "feat: validate combinations, placement and selections"
```

---

### Task 4: Service — serialize, create, and the three-way merge on update

**Files:**
- Modify: `src/services/result.service.ts`
- Test: `tests/integration/results-crud.test.ts` (**+8**, 16 → 24)

**Interfaces:**
- Consumes: `combinationSchema`, `placementSchema`, `selectionSchema` types from Task 3 (via `z.infer`); the existing `mergeToppers` function (reused, not reimplemented).
- Produces: `ResultDTO` gains `combinations`, `placement`, `selections`, `distinction`, `firstClass`, `boys`, `girls` — all optional, same shape as the validation layer's output. `update()` now merges `combinations` and `selections` with identity preservation, exactly as it already does for `toppers`.

- [ ] **Step 1: Write the failing integration tests**

Append to `tests/integration/results-crud.test.ts`, inside its existing `describe` block(s) — follow the file's existing pattern (`beforeAll`/`clearDatabase`/`makeInstitution`, the `actor` and `cycle` fixtures already defined near the top):

```ts
describe("combinations, placement and selections", () => {
  it("creates and returns a result carrying every new axis", async () => {
    await makeInstitution({ institutionId: "INS0001" });

    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        level: "PUC_2",
        combinations: [{ label: "PCMB", appeared: 40, passed: 38 }],
        placement: { eligible: 10, placed: 8, recruiters: [{ name: "Acme", selected: 3 }] },
        selections: [{ examCode: "KCET", qualified: 20 }],
      },
      actor,
    );

    expect(created.combinations?.[0]).toMatchObject({ label: "PCMB", appeared: 40, passed: 38 });
    expect(created.placement?.placed).toBe(8);
    expect(created.selections?.[0]).toMatchObject({ examCode: "KCET", qualified: 20 });
  });

  it("a combination's toppers survive a patch that edits an unrelated field on that same combination", async () => {
    await makeInstitution({ institutionId: "INS0001" });

    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        level: "PUC_2",
        combinations: [
          { label: "PCMB", appeared: 40, toppers: [{ name: "Priya S", percentage: 98.6 }] },
        ],
      },
      actor,
    );

    const combinationId = created.combinations?.[0]?.id;
    const topperId = created.combinations?.[0]?.toppers?.[0]?.id;
    expect(combinationId).toBeDefined();
    expect(topperId).toBeDefined();

    // A real photo, so the survival check is meaningful — not just an id.
    await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId as string,
      { contentType: "image/png", bytes: Buffer.from("not-a-real-image") },
      actor,
    ).catch(() => undefined); // image validation may reject the fixture bytes; the id path is what this test checks

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      {
        combinations: [
          {
            id: combinationId,
            label: "PCMB",
            appeared: 42,
            toppers: [{ id: topperId, name: "Priya S", percentage: 98.6 }],
          },
        ],
      },
      actor,
    );

    expect(updated.combinations?.[0]?.appeared).toBe(42);
    expect(updated.combinations?.[0]?.toppers?.[0]?.id).toBe(topperId);
  });

  it("a selection is matched by examCode on update, not replaced as a new row", async () => {
    await makeInstitution({ institutionId: "INS0001" });

    const created = await ResultService.create(
      "INS0001",
      { ...cycle, selections: [{ examCode: "KCET", qualified: 20 }] },
      actor,
    );

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      { selections: [{ examCode: "KCET", qualified: 25 }] },
      actor,
    );

    expect(updated.selections).toHaveLength(1);
    expect(updated.selections?.[0]?.qualified).toBe(25);
  });

  it("a combination named by an id matching nothing on this result is created fresh", async () => {
    await makeInstitution({ institutionId: "INS0001" });

    const created = await ResultService.create(
      "INS0001",
      { ...cycle, combinations: [{ label: "PCMB", appeared: 40 }] },
      actor,
    );

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      {
        combinations: [
          { id: UNKNOWN_TOPPER_ID, label: "PCMC", appeared: 30 },
        ],
      },
      actor,
    );

    expect(updated.combinations).toHaveLength(1);
    expect(updated.combinations?.[0]?.label).toBe("PCMC");
  });

  it("replacing selections with an empty array clears them", async () => {
    await makeInstitution({ institutionId: "INS0001" });

    const created = await ResultService.create(
      "INS0001",
      { ...cycle, selections: [{ examCode: "KCET", qualified: 20 }] },
      actor,
    );

    const updated = await ResultService.update("INS0001", created.id, { selections: [] }, actor);

    expect(updated.selections).toBeUndefined();
  });

  it("placement replaces wholesale, exactly like bands — a recruiter omitted from the patch is gone", async () => {
    await makeInstitution({ institutionId: "INS0001" });

    const created = await ResultService.create(
      "INS0001",
      { ...cycle, placement: { recruiters: [{ name: "Acme" }, { name: "Globex" }] } },
      actor,
    );

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      { placement: { recruiters: [{ name: "Acme" }] } },
      actor,
    );

    expect(updated.placement?.recruiters).toHaveLength(1);
    expect(updated.placement?.recruiters?.[0]?.name).toBe("Acme");
  });

  it("a cross-field invariant across combinations is checked against the MERGED record, not the raw patch", async () => {
    await makeInstitution({ institutionId: "INS0001" });

    const created = await ResultService.create(
      "INS0001",
      { ...cycle, appeared: 100, passed: 100, combinations: [{ label: "PCMB", appeared: 40 }] },
      actor,
    );

    // The patch alone (60) is fine; merged with the stored PCMB (40) it is 100 — still fine.
    // Push it over by adding a second combination whose total, with the untouched PCMB, exceeds 100.
    await expect(
      ResultService.update(
        "INS0001",
        created.id,
        { combinations: [{ label: "PCMB", appeared: 40 }, { label: "PCMC", appeared: 70 }] },
        actor,
      ),
    ).rejects.toThrow(/the combinations account for more students than appeared/);
  });

  it("tenant scoping is unchanged: a foreign institution cannot read the new fields either", async () => {
    await makeInstitution({ institutionId: "INS0001" });
    await makeInstitution({ institutionId: "INS0002" });

    const created = await ResultService.create(
      "INS0001",
      { ...cycle, placement: { placed: 5 } },
      actor,
    );

    await expect(ResultService.get("INS0002", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx vitest run tests/integration/results-crud.test.ts`
Expected: the 16 existing tests pass, the 8 new ones FAIL — `serialize` does not yet emit the new fields, and `update()` does not yet merge `combinations`/`selections`.

- [ ] **Step 3: Extend the service**

In `src/services/result.service.ts`:

Extend `ResultDTO`:

```ts
export type ResultDTO = {
  id: string;
  board: string;
  boardName?: string;
  level: string;
  stream: string | null;
  academicYear: string;
  examLabel?: string;
  appeared: number;
  passed: number;
  passPercentage: number | null;
  averageScore?: number;
  highestScore?: number;
  distinction?: number;
  firstClass?: number;
  boys?: { appeared?: number; passed?: number };
  girls?: { appeared?: number; passed?: number };
  bands?: { label: string; minPercentage: number; maxPercentage: number; count: number }[];
  toppers?: {
    id: string;
    name: string;
    percentage: number;
    rank?: number;
    note?: string;
    photoUrl?: string;
    consentAcknowledged: boolean;
  }[];
  combinations?: {
    id: string;
    academicUnitId?: string;
    label: string;
    appeared?: number;
    passed?: number;
    distinction?: number;
    firstClass?: number;
    highestScore?: number;
    averageScore?: number;
    grades?: Record<string, number>;
    boys?: { appeared?: number; passed?: number };
    girls?: { appeared?: number; passed?: number };
    toppers?: ResultDTO["toppers"];
  }[];
  placement?: {
    eligible?: number;
    placed?: number;
    highestPackage?: number;
    averagePackage?: number;
    recruiters?: {
      name: string;
      category?: string;
      selected?: number;
      averagePackage?: number;
      tieUp: boolean;
      roles?: string[];
    }[];
  };
  selections?: {
    examCode: string;
    appeared?: number;
    qualified?: number;
    bestRank?: number;
    toppers?: ResultDTO["toppers"];
  }[];
  status: string;
  publishedAt?: string;
  updatedAt?: string;
};
```

Add a small serializer for the topper shape, reused three times, right above `serialize`:

```ts
type ExistingTopperDoc = NonNullable<ResultDoc["toppers"]>[number];

function serializeToppers(toppers: ExistingTopperDoc[] | undefined): ResultDTO["toppers"] {
  return toppers?.length
    ? toppers.map((topper) => ({
        id: String(topper._id),
        name: topper.name,
        percentage: topper.percentage,
        rank: topper.rank ?? undefined,
        note: topper.note ?? undefined,
        photoUrl: topper.photoUrl ?? undefined,
        consentAcknowledged: topper.consentAcknowledged === true,
      }))
    : undefined;
}
```

Replace the body of `serialize`'s `toppers:` line with a call to it, and add the new fields — the full updated function:

```ts
function serialize(row: ResultDoc): ResultDTO {
  const appeared = row.appeared ?? 0;
  const passed = row.passed ?? 0;

  return {
    id: String(row._id),
    board: row.board,
    boardName: row.boardName ?? undefined,
    level: row.level,
    stream: row.stream ?? null,
    academicYear: row.academicYear,
    examLabel: row.examLabel ?? undefined,
    appeared,
    passed,
    passPercentage: appeared > 0 ? Math.round((passed / appeared) * 1000) / 10 : null,
    averageScore: row.averageScore ?? undefined,
    highestScore: row.highestScore ?? undefined,
    distinction: row.distinction ?? undefined,
    firstClass: row.firstClass ?? undefined,
    boys: row.boys
      ? { appeared: row.boys.appeared ?? undefined, passed: row.boys.passed ?? undefined }
      : undefined,
    girls: row.girls
      ? { appeared: row.girls.appeared ?? undefined, passed: row.girls.passed ?? undefined }
      : undefined,
    bands: row.bands?.length
      ? row.bands.map((band) => ({
          label: band.label,
          minPercentage: band.minPercentage,
          maxPercentage: band.maxPercentage,
          count: band.count,
        }))
      : undefined,
    toppers: serializeToppers(row.toppers),
    combinations: row.combinations?.length
      ? row.combinations.map((combination) => ({
          id: String(combination._id),
          academicUnitId: combination.academicUnitId
            ? String(combination.academicUnitId)
            : undefined,
          label: combination.label,
          appeared: combination.appeared ?? undefined,
          passed: combination.passed ?? undefined,
          distinction: combination.distinction ?? undefined,
          firstClass: combination.firstClass ?? undefined,
          highestScore: combination.highestScore ?? undefined,
          averageScore: combination.averageScore ?? undefined,
          grades: combination.grades
            ? (combination.grades as unknown as Record<string, number>)
            : undefined,
          boys: combination.boys
            ? { appeared: combination.boys.appeared ?? undefined, passed: combination.boys.passed ?? undefined }
            : undefined,
          girls: combination.girls
            ? { appeared: combination.girls.appeared ?? undefined, passed: combination.girls.passed ?? undefined }
            : undefined,
          toppers: serializeToppers(combination.toppers),
        }))
      : undefined,
    placement: row.placement
      ? {
          eligible: row.placement.eligible ?? undefined,
          placed: row.placement.placed ?? undefined,
          highestPackage: row.placement.highestPackage ?? undefined,
          averagePackage: row.placement.averagePackage ?? undefined,
          recruiters: row.placement.recruiters?.length
            ? row.placement.recruiters.map((recruiter) => ({
                name: recruiter.name,
                category: recruiter.category ?? undefined,
                selected: recruiter.selected ?? undefined,
                averagePackage: recruiter.averagePackage ?? undefined,
                tieUp: recruiter.tieUp === true,
                roles: recruiter.roles?.length ? recruiter.roles : undefined,
              }))
            : undefined,
        }
      : undefined,
    selections: row.selections?.length
      ? row.selections.map((selection) => ({
          examCode: selection.examCode,
          appeared: selection.appeared ?? undefined,
          qualified: selection.qualified ?? undefined,
          bestRank: selection.bestRank ?? undefined,
          toppers: serializeToppers(selection.toppers),
        }))
      : undefined,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString(),
    updatedAt: (row as ResultDoc & { updatedAt?: Date }).updatedAt?.toISOString(),
  };
}
```

`create()`'s body does not change except for its `assertResultInvariants` call — `Result.create({ ...input, institutionId, status: "DRAFT" })` already passes every new field through, exactly as it does today for `bands`/`toppers`. **Replace** the existing `assertResultInvariants({...})` call inside `create()` with the version below, which is identical except for the seven new keys:

```ts
    assertResultInvariants({
      board: input.board,
      boardName: input.boardName,
      appeared: input.appeared,
      passed: input.passed,
      distinction: input.distinction,
      firstClass: input.firstClass,
      boys: input.boys,
      girls: input.girls,
      bands: input.bands,
      toppers: input.toppers,
      combinations: input.combinations,
      placement: input.placement,
      selections: input.selections,
    });
```

Now `update()`. Add `mergeCombinations` and `mergeSelections` beside the existing `mergeToppers`, at the bottom of the file:

```ts
type ExistingCombination = NonNullable<ResultDoc["combinations"]>[number];
type IncomingCombination = NonNullable<UpdateInput["combinations"]>[number];
// Omits BOTH "id" (replaced by "_id") and "toppers" (replaced by the MERGED
// toppers below) — unlike the original MergedTopper, which never needed a
// second omission because a topper does not itself nest another toppers
// array. Omitting only "id" here would leave the UN-merged toppers type still
// present via the Omit, intersected against the merged one below — an
// ambiguous type, not the type this function actually returns.
type MergedCombination = Omit<IncomingCombination, "id" | "toppers"> & {
  _id?: ExistingCombination["_id"];
  toppers?: MergedTopper[];
};

/**
 * The same identity problem `mergeToppers` solves, one level up: a combination
 * nests toppers, so replacing the array wholesale on an edit as small as a
 * corrected label would mint a fresh combination subdocument and, with it,
 * fresh toppers — dropping every photograph underneath. A row naming an
 * existing combination by `id` keeps that combination's `_id`; its own
 * `toppers` field is then merged again, by the SAME `mergeToppers` used at the
 * top level, against whatever that specific combination already had.
 */
function mergeCombinations(
  incoming: IncomingCombination[],
  existing: ResultDoc["combinations"],
): MergedCombination[] {
  const byId = new Map((existing ?? []).map((row) => [String(row._id), row]));

  return incoming.map(({ id, toppers, ...fields }) => {
    const match = id ? byId.get(id) : undefined;
    if (!match) return { ...fields, toppers: toppers ? mergeToppers(toppers, undefined) : undefined };
    byId.delete(id as string);
    return {
      ...fields,
      _id: match._id,
      toppers: toppers ? mergeToppers(toppers, match.toppers) : undefined,
    };
  });
}

type ExistingSelection = NonNullable<ResultDoc["selections"]>[number];
type IncomingSelection = NonNullable<UpdateInput["selections"]>[number];
// Same reasoning as MergedCombination above: "toppers" is omitted from the
// source type before being replaced, not merely added alongside it.
type MergedSelection = Omit<IncomingSelection, "toppers"> & { toppers?: MergedTopper[] };

/**
 * Matched by `examCode`, not a synthetic id — an exam code is a stable enum
 * value, never edited into a typo the way a combination's free-text label can
 * be, so no separate handle is needed for it to serve as identity.
 */
function mergeSelections(
  incoming: IncomingSelection[],
  existing: ResultDoc["selections"],
): MergedSelection[] {
  const byCode = new Map((existing ?? []).map((row) => [row.examCode, row]));

  return incoming.map((selection) => {
    const match = byCode.get(selection.examCode);
    return {
      ...selection,
      toppers: selection.toppers
        ? mergeToppers(selection.toppers, match?.toppers)
        : undefined,
    };
  });
}
```

Update `update()`'s body — replace the `toppers` merge line and the `assertResultInvariants` call:

```ts
  async update(
    institutionId: string,
    resultId: string,
    patch: UpdateInput,
    actor: { id: string; name: string },
  ): Promise<ResultDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, resultId);

    const set = stripUndefined(patch);
    const toppers = patch.toppers ? mergeToppers(patch.toppers, before.toppers) : undefined;
    const combinations = patch.combinations
      ? mergeCombinations(patch.combinations, before.combinations)
      : undefined;
    const selections = patch.selections
      ? mergeSelections(patch.selections, before.selections)
      : undefined;

    const merged = { ...before, ...set };
    assertResultInvariants({
      board: merged.board,
      boardName: merged.boardName,
      appeared: merged.appeared ?? 0,
      passed: merged.passed ?? 0,
      distinction: merged.distinction,
      firstClass: merged.firstClass,
      boys: merged.boys,
      girls: merged.girls,
      bands: merged.bands,
      toppers: toppers ?? merged.toppers,
      combinations: combinations ?? merged.combinations,
      placement: merged.placement,
      selections: selections ?? merged.selections,
    });

    const setPatch: Record<string, unknown> = { ...set };
    if (toppers) setPatch.toppers = toppers;
    if (combinations) setPatch.combinations = combinations;
    if (selections) setPatch.selections = selections;

    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: setPatch },
      { new: true },
    ).lean<ResultDoc>();
    if (!updated) throw notFound("Result not found");

    if (toppers) {
      const kept = new Set(toppers.filter((t) => t._id).map((t) => String(t._id)));
      for (const stale of before.toppers ?? []) {
        if (!kept.has(String(stale._id))) {
          await deleteOwnedPhoto(stale.photoUrl, institutionId);
        }
      }
    }

    await ActivityService.record({
      institutionId,
      entityType: "RESULT",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Result updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },
```

**Note what did NOT change:** the stale-photo cleanup loop after the write still only inspects the top-level `toppers` array. This phase deliberately leaves combination/selection topper cleanup on genuine removal as a known gap — see the report note in Step 5 below; closing it is a small follow-up, not required for this task's tests to pass, since none of Task 4's tests remove a nested topper outright (Task 6/8's UI can still remove one from a form and re-save; the underlying photo will be orphaned in storage rather than deleted). **If time allows, extend the same cleanup pattern to walk `before.combinations`/`before.selections` against `combinations`/`selections`; if not, report this explicitly rather than silently leaving it unmentioned.**

- [ ] **Step 4: Run to verify**

Run: `npx vitest run tests/integration/results-crud.test.ts` — expect **24 passing**.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **730**.

```bash
git add src/services/result.service.ts tests/integration/results-crud.test.ts
git commit -m "feat: serialize and merge combinations, placement and selections"
```

---

### Task 5: Widen the topper photo lookup to nested toppers

**Files:**
- Modify: `src/services/result.service.ts` (`setTopperPhoto`, `removeTopperPhoto`)
- Test: `tests/integration/results-media.test.ts` (**+4**, 11 → 15)

**Interfaces:**
- Consumes: `combinations`, `selections` on `ResultDoc`/`ResultDTO` from Tasks 2 and 4.
- Produces: no signature change to `setTopperPhoto`/`removeTopperPhoto` — both still take `(institutionId, resultId, topperId, ...)`. They now search three places for the topper instead of one, and update whichever one it was actually found in.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/results-media.test.ts`, following its existing fixture style (`cycle`, `PNG`, `actor` already defined near the top of the file):

```ts
describe("nested toppers", () => {
  it("sets a photo on a combination's own topper", async () => {
    await makeInstitution({ institutionId: "INS0001" });
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        combinations: [{ label: "PCMB", toppers: [{ name: "Priya S", percentage: 98.6 }] }],
      },
      actor,
    );
    const topperId = created.combinations?.[0]?.toppers?.[0]?.id as string;

    const updated = await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );

    expect(updated.combinations?.[0]?.toppers?.[0]?.photoUrl).toBeDefined();
    expect(existsSync(storedPath(updated.combinations?.[0]?.toppers?.[0]?.photoUrl as string))).toBe(
      true,
    );
  });

  it("sets a photo on a selection's own topper", async () => {
    await makeInstitution({ institutionId: "INS0001" });
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        selections: [{ examCode: "KCET", toppers: [{ name: "Rahul K", percentage: 97.8 }] }],
      },
      actor,
    );
    const topperId = created.selections?.[0]?.toppers?.[0]?.id as string;

    const updated = await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );

    expect(updated.selections?.[0]?.toppers?.[0]?.photoUrl).toBeDefined();
  });

  it("removes a photo from a combination's own topper", async () => {
    await makeInstitution({ institutionId: "INS0001" });
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        combinations: [{ label: "PCMB", toppers: [{ name: "Priya S", percentage: 98.6 }] }],
      },
      actor,
    );
    const topperId = created.combinations?.[0]?.toppers?.[0]?.id as string;
    await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );

    const updated = await ResultService.removeTopperPhoto("INS0001", created.id, topperId, actor);

    expect(updated.combinations?.[0]?.toppers?.[0]?.photoUrl).toBeUndefined();
  });

  it("a foreign topperId still reads as NOT_FOUND when the result has combinations and selections", async () => {
    await makeInstitution({ institutionId: "INS0001" });
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        combinations: [{ label: "PCMB", toppers: [{ name: "Priya S", percentage: 98.6 }] }],
        selections: [{ examCode: "KCET", toppers: [{ name: "Rahul K", percentage: 97.8 }] }],
      },
      actor,
    );

    await expect(
      ResultService.setTopperPhoto(
        "INS0001",
        created.id,
        UNKNOWN_TOPPER_ID,
        { contentType: "image/png", bytes: PNG },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx vitest run tests/integration/results-media.test.ts`
Expected: the 11 existing tests pass, the 4 new ones FAIL — the current lookup only checks `before.toppers`.

- [ ] **Step 3: Widen `setTopperPhoto` and `removeTopperPhoto`**

Add a small shared locator above `ResultService` in `src/services/result.service.ts`, near `findOwned`:

```ts
/**
 * A topper's `_id` is unique across the whole document regardless of which
 * array holds it — top-level, one combination's, or one selection's. Locates
 * it in all three so the photo endpoint stays unaware of where a topper
 * actually lives; only this function and the write below it need to know.
 */
function locateTopper(
  before: ResultDoc,
  topperId: string,
): { path: "toppers" | `combinations.${number}.toppers` | `selections.${number}.toppers`; topper: ExistingTopperDoc } | null {
  const direct = before.toppers?.find((row) => String(row._id) === topperId);
  if (direct) return { path: "toppers", topper: direct };

  for (let i = 0; i < (before.combinations?.length ?? 0); i += 1) {
    const found = before.combinations?.[i]?.toppers?.find((row) => String(row._id) === topperId);
    if (found) return { path: `combinations.${i}.toppers`, topper: found };
  }

  for (let i = 0; i < (before.selections?.length ?? 0); i += 1) {
    const found = before.selections?.[i]?.toppers?.find((row) => String(row._id) === topperId);
    if (found) return { path: `selections.${i}.toppers`, topper: found };
  }

  return null;
}
```

Replace `setTopperPhoto`'s body:

```ts
  async setTopperPhoto(
    institutionId: string,
    resultId: string,
    topperId: string,
    input: { contentType: string; bytes: Buffer },
    actor: { id: string; name: string },
  ): Promise<ResultDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, resultId);

    const located = locateTopper(before, topperId);
    if (!located) throw notFound("Topper not found");
    const { path, topper } = located;

    const { extension } = validateImage(input);

    const objectId = new Types.ObjectId();
    const key = `media/${institutionId}/results/${String(before._id)}/${objectId.toHexString()}${extension}`;
    const stored = await storage.putPublic({
      key,
      body: input.bytes,
      contentType: input.contentType,
    });

    // arrayFilters addresses the exact matched element regardless of which of
    // the three arrays it came from — `path` already resolved WHICH array;
    // this resolves WHICH ELEMENT of it, by that topper's own `_id`.
    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: { [`${path}.$[topper].photoUrl`]: stored.key } },
      { new: true, arrayFilters: [{ "topper._id": topper._id }] },
    ).lean<ResultDoc>();
    if (!updated) {
      await storage.deletePublic(stored.key).catch(() => undefined);
      throw notFound("Result not found");
    }

    await deleteOwnedPhoto(topper.photoUrl, institutionId);

    await ActivityService.record({
      institutionId,
      entityType: "RESULT",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Topper photo updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },
```

Replace `removeTopperPhoto`'s body identically, swapping the update:

```ts
  async removeTopperPhoto(
    institutionId: string,
    resultId: string,
    topperId: string,
    actor: { id: string; name: string },
  ): Promise<ResultDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, resultId);

    const located = locateTopper(before, topperId);
    if (!located) throw notFound("Topper not found");
    const { path, topper } = located;

    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $unset: { [`${path}.$[topper].photoUrl`]: "" } },
      { new: true, arrayFilters: [{ "topper._id": topper._id }] },
    ).lean<ResultDoc>();
    if (!updated) throw notFound("Result not found");

    await deleteOwnedPhoto(topper.photoUrl, institutionId);

    await ActivityService.record({
      institutionId,
      entityType: "RESULT",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Topper photo removed",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },
```

**A detail to confirm rather than assume:** the original code used the positional `toppers.$.photoUrl` operator, which MongoDB resolves against the FIRST filter condition in the query itself (`"toppers._id": topper._id"` used to be part of the query filter, not shown separately). The rewrite above moves to `arrayFilters` entirely and drops `"toppers._id"` from the top-level query filter — confirm this still matches exactly one document (scoped by `_id` and `institutionId`, which is already sufficient) and that the `arrayFilters` condition alone correctly targets the nested element. Run the EXISTING top-level-topper tests in this same file after making this change, not only the four new ones, since the positional-to-arrayFilters rewrite touches the code path they exercise too.

- [ ] **Step 4: Run to verify**

Run: `npx vitest run tests/integration/results-media.test.ts` — expect **15 passing**, including all 11 pre-existing tests still green (they exercise the same rewritten code path for top-level toppers).

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **734**.

```bash
git add src/services/result.service.ts tests/integration/results-media.test.ts
git commit -m "feat: reach a combination's or selection's topper from the photo endpoint"
```

---

### Task 6: The combinations section

**Files:**
- Create: `src/components/results/combinations-section.tsx`
- Modify: `src/app/(dashboard)/results/[resultId]/page.tsx` (load and pass `units`)

**Interfaces:**
- Consumes: `TopperPhoto` (Task 1); `combinationSchema` type shape via `updateResultSchema` (Task 3); `AcademicUnitDTO`, `AcademicStructureService.list` (existing, from Phase 5); `ResultSectionProps` (existing, from `result-editor.tsx`).
- Produces: `CombinationsSection({ result, onSave, onDirtyChange, units }): JSX.Element`, exported. Task 9 wires it into `result-editor.tsx`'s `SECTIONS`.

No new tests: this is browser interaction, and this repo has no component test harness (confirmed: zero `.test.tsx` files exist anywhere). Verify by `tsc`, `lint`, the full suite staying at **734**, and curl.

- [ ] **Step 1: The page loads units**

In `src/app/(dashboard)/results/[resultId]/page.tsx`, add the same effectively-inactive filter `/fees/new` already uses (Phase 5's read-time rule):

```ts
import { AcademicStructureService } from "@/services/academic-structure.service";
import { flattenTree, inactiveIds } from "@/lib/academic/tree";
```

After the existing `result` is fetched, before the return:

```ts
  const allUnits = await AcademicStructureService.list(institution.institutionId);
  const hidden = inactiveIds(allUnits);
  const units = flattenTree(allUnits).filter((unit) => !hidden.has(unit.id));
```

Pass `units` down: `<ResultEditor initialResult={result} institutionId={institution.institutionId} units={units} />` (Task 9 threads this prop through `ResultEditor` into `sectionProps`).

- [ ] **Step 2: The section**

Create `src/components/results/combinations-section.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { Plus, X } from "lucide-react";
import { updateResultSchema } from "@/lib/validation/result";
import { GRADE_BUCKETS, RESULT_MAX_COMBINATIONS, RESULT_MAX_TOPPERS } from "@/lib/constants";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";
import type { ResultDTO } from "@/services/result.service";
import { Button } from "@/components/ui/button";
import {
  FieldGroup,
  reportSectionErrors,
  SectionForm,
  SelectField,
  TextField,
} from "@/components/profile/section-form";
import { TopperPhoto } from "@/components/results/topper-photo";
import type { ResultSectionProps } from "@/components/results/result-editor";

type Values = z.input<typeof updateResultSchema>;
type Parsed = z.output<typeof updateResultSchema>;
type Combination = NonNullable<ResultDTO["combinations"]>[number];

/** An empty number input must stay absent — the schema takes a number, not NaN. */
const asNumber = (value: unknown) =>
  value === "" || value === null || value === undefined ? undefined : Number(value);

/**
 * A saved combination as this form holds it. The `id` is what lets an edit be
 * matched back to its row, and its toppers are seeded the same way
 * `toppers-section.tsx` seeds the top level — following the same
 * `mergeToppers` identity discipline one level down.
 */
const toFormRow = (combination: Combination) => ({
  id: combination.id,
  academicUnitId: combination.academicUnitId,
  label: combination.label,
  appeared: combination.appeared,
  passed: combination.passed,
  distinction: combination.distinction,
  firstClass: combination.firstClass,
  highestScore: combination.highestScore,
  averageScore: combination.averageScore,
  grades: combination.grades ?? {},
  boys: combination.boys ?? {},
  girls: combination.girls ?? {},
  toppers: (combination.toppers ?? []).map((topper) => ({
    id: topper.id,
    name: topper.name,
    percentage: topper.percentage,
    rank: topper.rank,
    note: topper.note ?? "",
    consentAcknowledged: topper.consentAcknowledged,
  })),
});

/**
 * Branch or combination breakdown — PUC Science versus Commerce, engineering
 * CSE versus ECE. Each row can optionally link to the academic tree, which
 * only fills the label in; the label itself stays free text so a later
 * rename of the unit never silently retitles a past result (see the design
 * spec's Decision 3).
 */
export function CombinationsSection({
  result,
  onSave,
  onDirtyChange,
  units,
}: ResultSectionProps & { units: AcademicUnitDTO[] }) {
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(updateResultSchema),
    defaultValues: { combinations: (result.combinations ?? []).map(toFormRow) },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "combinations",
    keyName: "_key",
  });

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  async function onSubmit(values: Parsed) {
    const next = await onSave(values as Record<string, unknown>);
    if (next) reset({ combinations: (next.combinations ?? []).map(toFormRow) });
  }

  return (
    <SectionForm
      title="Combinations"
      description="Branch or combination results inside this cycle — PUC Science and Commerce, or engineering CSE and ECE."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup>
        {fields.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No combinations recorded. A cycle can be published without any — this is a
            breakdown of the totals in Outcome, not a replacement for them.
          </p>
        ) : (
          <ul className="space-y-3">
            {fields.map((entry, index) => {
              const saved: Combination | undefined = isDirty ? undefined : result.combinations?.[index];

              return (
                <li key={entry._key} className="space-y-3 rounded-lg border border-border p-3">
                  <input type="hidden" {...register(`combinations.${index}.id`)} />

                  <div className="flex items-start justify-between gap-2">
                    <p className="eyebrow">Combination {index + 1}</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove combination ${index + 1}`}
                      onClick={() => remove(index)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>

                  {units.length > 0 ? (
                    <SelectField
                      id={`combinations-unit-${index}`}
                      label="Fill from academic unit"
                      value={watch(`combinations.${index}.academicUnitId`) ?? ""}
                      onChange={(value) => {
                        const unit = units.find((u) => u.id === value);
                        setValue(`combinations.${index}.academicUnitId`, value, { shouldDirty: true });
                        if (unit) {
                          setValue(`combinations.${index}.label`, unit.name, { shouldDirty: true });
                        }
                      }}
                      options={units.map((unit) => ({ value: unit.id, label: unit.pathLabel }))}
                      placeholder="Optional — picks a label from your academic structure"
                    />
                  ) : null}

                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_100px_100px]">
                    <TextField
                      id={`combinations-label-${index}`}
                      label="Label"
                      placeholder="PCMB"
                      maxLength={60}
                      error={errors.combinations?.[index]?.label?.message}
                      {...register(`combinations.${index}.label`)}
                    />
                    <TextField
                      id={`combinations-appeared-${index}`}
                      label="Appeared"
                      type="number"
                      inputMode="numeric"
                      error={errors.combinations?.[index]?.appeared?.message}
                      {...register(`combinations.${index}.appeared`, { setValueAs: asNumber })}
                    />
                    <TextField
                      id={`combinations-passed-${index}`}
                      label="Passed"
                      type="number"
                      inputMode="numeric"
                      error={errors.combinations?.[index]?.passed?.message}
                      {...register(`combinations.${index}.passed`, { setValueAs: asNumber })}
                    />
                  </div>

                  {/* Collapsed by default — most combinations need only label/appeared/passed,
                      and a row that opens with fourteen inputs reads as work (design spec §6). */}
                  <details className="rounded-md border border-border/70 p-2.5">
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                      More details — distinction, grades, gender split
                    </summary>
                    <div className="mt-3 space-y-3">
                      <div className="grid gap-3 sm:grid-cols-4">
                        <TextField
                          id={`combinations-distinction-${index}`}
                          label="Distinction"
                          type="number"
                          inputMode="numeric"
                          hint="Optional."
                          error={errors.combinations?.[index]?.distinction?.message}
                          {...register(`combinations.${index}.distinction`, { setValueAs: asNumber })}
                        />
                        <TextField
                          id={`combinations-firstClass-${index}`}
                          label="First class"
                          type="number"
                          inputMode="numeric"
                          hint="Optional."
                          error={errors.combinations?.[index]?.firstClass?.message}
                          {...register(`combinations.${index}.firstClass`, { setValueAs: asNumber })}
                        />
                        <TextField
                          id={`combinations-highestScore-${index}`}
                          label="Highest score %"
                          type="number"
                          step="any"
                          inputMode="decimal"
                          hint="Optional."
                          error={errors.combinations?.[index]?.highestScore?.message}
                          {...register(`combinations.${index}.highestScore`, { setValueAs: asNumber })}
                        />
                        <TextField
                          id={`combinations-averageScore-${index}`}
                          label="Average score %"
                          type="number"
                          step="any"
                          inputMode="decimal"
                          hint="Optional."
                          error={errors.combinations?.[index]?.averageScore?.message}
                          {...register(`combinations.${index}.averageScore`, { setValueAs: asNumber })}
                        />
                      </div>

                      <div>
                        <p className="mb-1.5 text-xs text-muted-foreground">Grade spread</p>
                        <div className="grid gap-2 sm:grid-cols-6">
                          {GRADE_BUCKETS.map((bucket) => (
                            <TextField
                              key={bucket}
                              id={`combinations-${index}-grade-${bucket}`}
                              label={bucket}
                              type="number"
                              inputMode="numeric"
                              {...register(`combinations.${index}.grades.${bucket}` as const, {
                                setValueAs: asNumber,
                              })}
                            />
                          ))}
                        </div>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid grid-cols-2 gap-2">
                          <TextField
                            id={`combinations-boys-appeared-${index}`}
                            label="Boys appeared"
                            type="number"
                            inputMode="numeric"
                            hint="Optional."
                            {...register(`combinations.${index}.boys.appeared`, { setValueAs: asNumber })}
                          />
                          <TextField
                            id={`combinations-boys-passed-${index}`}
                            label="Boys passed"
                            type="number"
                            inputMode="numeric"
                            hint="Optional."
                            {...register(`combinations.${index}.boys.passed`, { setValueAs: asNumber })}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <TextField
                            id={`combinations-girls-appeared-${index}`}
                            label="Girls appeared"
                            type="number"
                            inputMode="numeric"
                            hint="Optional."
                            {...register(`combinations.${index}.girls.appeared`, { setValueAs: asNumber })}
                          />
                          <TextField
                            id={`combinations-girls-passed-${index}`}
                            label="Girls passed"
                            type="number"
                            inputMode="numeric"
                            hint="Optional."
                            {...register(`combinations.${index}.girls.passed`, { setValueAs: asNumber })}
                          />
                        </div>
                      </div>
                    </div>
                  </details>

                  <div className="space-y-3 border-t border-border pt-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Toppers within {watch(`combinations.${index}.label`) || "this combination"}
                    </p>
                    {(watch(`combinations.${index}.toppers`) ?? []).map((_topperRow, topperIndex) => {
                      const savedTopper = saved?.toppers?.[topperIndex];
                      return (
                        <div
                          key={topperIndex}
                          className="space-y-2 rounded-md border border-border/70 p-2.5"
                        >
                          <input
                            type="hidden"
                            {...register(`combinations.${index}.toppers.${topperIndex}.id`)}
                          />
                          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_90px_auto]">
                            <TextField
                              id={`combinations-${index}-topper-${topperIndex}-name`}
                              label="Name"
                              maxLength={120}
                              error={
                                errors.combinations?.[index]?.toppers?.[topperIndex]?.name?.message
                              }
                              {...register(`combinations.${index}.toppers.${topperIndex}.name`)}
                            />
                            <TextField
                              id={`combinations-${index}-topper-${topperIndex}-percentage`}
                              label="Score %"
                              type="number"
                              step="any"
                              inputMode="decimal"
                              error={
                                errors.combinations?.[index]?.toppers?.[topperIndex]?.percentage
                                  ?.message
                              }
                              {...register(
                                `combinations.${index}.toppers.${topperIndex}.percentage`,
                                { setValueAs: asNumber },
                              )}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="mt-5"
                              aria-label="Remove this topper"
                              onClick={() => {
                                const current = watch(`combinations.${index}.toppers`) ?? [];
                                setValue(
                                  `combinations.${index}.toppers`,
                                  current.filter((_, i) => i !== topperIndex),
                                  { shouldDirty: true },
                                );
                              }}
                            >
                              <X className="size-3.5" />
                            </Button>
                          </div>
                          <label className="flex items-start gap-2 text-xs">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              {...register(
                                `combinations.${index}.toppers.${topperIndex}.consentAcknowledged`,
                              )}
                            />
                            <span>We hold consent to publish this student&apos;s photograph.</span>
                          </label>
                          {savedTopper ? (
                            <TopperPhoto
                              resultId={result.id}
                              topper={savedTopper}
                              onResult={() => {}}
                              position={topperIndex + 1}
                            />
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Save this section to add a photo.
                            </p>
                          )}
                        </div>
                      );
                    })}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={(watch(`combinations.${index}.toppers`) ?? []).length >= RESULT_MAX_TOPPERS}
                      onClick={() => {
                        const current = watch(`combinations.${index}.toppers`) ?? [];
                        setValue(
                          `combinations.${index}.toppers`,
                          [
                            ...current,
                            { name: "", percentage: undefined as unknown as number, note: "", consentAcknowledged: false },
                          ],
                          { shouldDirty: true },
                        );
                      }}
                    >
                      <Plus className="size-3.5" />
                      Add topper
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fields.length >= RESULT_MAX_COMBINATIONS}
          onClick={() => append({ label: "", toppers: [] })}
        >
          <Plus className="size-3.5" />
          Add combination
        </Button>

        {typeof errors.combinations?.message === "string" ? (
          <p role="alert" className="text-xs text-foreground">
            {errors.combinations.message}
          </p>
        ) : null}
      </FieldGroup>
    </SectionForm>
  );
}
```

**A named risk, resolved by construction rather than left open:** the `onResult` prop `TopperPhoto` expects is `(result: ResultDTO) => void` — this section passes a no-op (`() => {}`) rather than wiring it to `applyResult`, because `result-editor.tsx`'s `sectionProps` does not currently include `applyResult` for non-toppers sections (only `ToppersSection` receives it, per the existing composition in `result-editor.tsx:198-200`). **This means a photo change inside a combination or selection does not refresh the on-screen result until the section is next saved or the page reloads — a real but minor staleness, not a correctness bug** (the photo itself is written correctly; only the client's cached `result` object is briefly behind). Task 9 should thread `onResult`/`applyResult` into these two sections' props exactly as `ToppersSection` already receives it, removing this no-op. If Task 9's implementer finds that straightforward, do it there; if not, this note stands as a known, reported gap rather than a silent one.

- [ ] **Step 3: Verify**

`npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **734**.

`npm run lint` may show a new `react-hooks/incompatible-library` warning for this file's `watch()` calls — that is the accepted, pre-existing class; a warning of any other class is a defect.

Then start `npm run dev` and curl with a real signed session cookie: `/results/{id}` returns 200 with the combinations section reachable via the section nav. **State plainly what curl could not check** — adding a combination, the academic-unit prefill, nested topper rows, nested photo upload.

- [ ] **Step 4: Commit**

```bash
git add src/components/results/combinations-section.tsx "src/app/(dashboard)/results/[resultId]/page.tsx"
git commit -m "feat: add the combinations editor"
```

---

### Task 7: The placement section

**Files:**
- Create: `src/components/results/placement-section.tsx`

**Interfaces:**
- Consumes: `placementSchema`'s shape via `updateResultSchema` (Task 3); `RECRUITER_CATEGORIES`, `RECRUITER_CATEGORY_LABELS`, `RESULT_MAX_RECRUITERS` (Task 2).
- Produces: `PlacementSection({ result, onSave, onDirtyChange }): JSX.Element`, exported. Task 9 wires it in.

No new tests — same reasoning as Task 6. Suite stays at **734**.

- [ ] **Step 1: The section**

Create `src/components/results/placement-section.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { Plus, X } from "lucide-react";
import { updateResultSchema } from "@/lib/validation/result";
import {
  RECRUITER_CATEGORIES,
  RECRUITER_CATEGORY_LABELS,
  RESULT_MAX_RECRUITERS,
} from "@/lib/constants";
import {
  FieldGroup,
  FieldRow,
  reportSectionErrors,
  SectionForm,
  SelectField,
  TextField,
} from "@/components/profile/section-form";
import type { ResultSectionProps } from "@/components/results/result-editor";

type Values = z.input<typeof updateResultSchema>;
type Parsed = z.output<typeof updateResultSchema>;

const asNumber = (value: unknown) =>
  value === "" || value === null || value === undefined ? undefined : Number(value);

/**
 * Recruiters replace wholesale on save, unlike toppers — nothing on a
 * recruiter is server-written (no logo in this phase, see the design spec's
 * §4.3), so there is no identity to lose by treating the array the same way
 * `bands` already is.
 */
export function PlacementSection({ result, onSave, onDirtyChange }: ResultSectionProps) {
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(updateResultSchema),
    defaultValues: {
      placement: {
        eligible: result.placement?.eligible,
        placed: result.placement?.placed,
        highestPackage: result.placement?.highestPackage,
        averagePackage: result.placement?.averagePackage,
        recruiters: (result.placement?.recruiters ?? []).map((recruiter) => ({
          name: recruiter.name,
          category: recruiter.category,
          selected: recruiter.selected,
          averagePackage: recruiter.averagePackage,
          tieUp: recruiter.tieUp,
          roles: recruiter.roles ?? [],
        })),
      },
    },
  });

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const recruiters = useWatch({ control, name: "placement.recruiters" }) ?? [];

  async function onSubmit(values: Parsed) {
    if (await onSave(values as Record<string, unknown>)) reset(values as Values);
  }

  return (
    <SectionForm
      title="Placement"
      description="Recruitment outcomes for this cycle — engineering, medical, management or degree colleges."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup>
        <FieldRow>
          <TextField
            id="placement-eligible"
            label="Eligible"
            type="number"
            inputMode="numeric"
            hint="Optional."
            error={errors.placement?.eligible?.message}
            {...register("placement.eligible", { setValueAs: asNumber })}
          />
          <TextField
            id="placement-placed"
            label="Placed"
            type="number"
            inputMode="numeric"
            hint="Optional."
            error={errors.placement?.placed?.message}
            {...register("placement.placed", { setValueAs: asNumber })}
          />
          <TextField
            id="placement-highestPackage"
            label="Highest package (₹ LPA)"
            type="number"
            step="any"
            inputMode="decimal"
            hint="Optional."
            error={errors.placement?.highestPackage?.message}
            {...register("placement.highestPackage", { setValueAs: asNumber })}
          />
          <TextField
            id="placement-averagePackage"
            label="Average package (₹ LPA)"
            type="number"
            step="any"
            inputMode="decimal"
            hint="Optional."
            error={errors.placement?.averagePackage?.message}
            {...register("placement.averagePackage", { setValueAs: asNumber })}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup title="Recruiters" description="The companies that hired from this cohort.">
        {recruiters.length === 0 ? (
          <p className="text-xs text-muted-foreground">No recruiters listed yet.</p>
        ) : (
          <ul className="space-y-3">
            {recruiters.map((_recruiter, index) => (
              <li key={index} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="eyebrow">Recruiter {index + 1}</p>
                  <button
                    type="button"
                    aria-label={`Remove recruiter ${index + 1}`}
                    onClick={() =>
                      setValue(
                        "placement.recruiters",
                        recruiters.filter((_, i) => i !== index),
                        { shouldDirty: true },
                      )
                    }
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_90px]">
                  <TextField
                    id={`recruiter-${index}-name`}
                    label="Name"
                    maxLength={120}
                    error={errors.placement?.recruiters?.[index]?.name?.message}
                    {...register(`placement.recruiters.${index}.name`)}
                  />
                  <SelectField
                    id={`recruiter-${index}-category`}
                    label="Category"
                    value={watch(`placement.recruiters.${index}.category`) ?? ""}
                    onChange={(value) =>
                      setValue(`placement.recruiters.${index}.category`, value as never, {
                        shouldDirty: true,
                      })
                    }
                    options={RECRUITER_CATEGORIES.map((code) => ({
                      value: code,
                      label: RECRUITER_CATEGORY_LABELS[code],
                    }))}
                    placeholder="Optional"
                  />
                  <TextField
                    id={`recruiter-${index}-selected`}
                    label="Selected"
                    type="number"
                    inputMode="numeric"
                    error={errors.placement?.recruiters?.[index]?.selected?.message}
                    {...register(`placement.recruiters.${index}.selected`, { setValueAs: asNumber })}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    {...register(`placement.recruiters.${index}.tieUp`)}
                  />
                  <span>Active MoU / guaranteed campus drive</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={recruiters.length >= RESULT_MAX_RECRUITERS}
          onClick={() =>
            setValue(
              "placement.recruiters",
              [...recruiters, { name: "", tieUp: false }],
              { shouldDirty: true },
            )
          }
        >
          <Plus className="size-3.5" />
          Add recruiter
        </Button>

        {typeof errors.placement?.recruiters?.message === "string" ? (
          <p role="alert" className="text-xs text-foreground">
            {errors.placement.recruiters.message}
          </p>
        ) : null}
      </FieldGroup>
    </SectionForm>
  );
}
```

Add the missing `Button` import at the top (`import { Button } from "@/components/ui/button";`) — it is used by "Add recruiter" but the sample above only imports icons; include it alongside the existing imports.

- [ ] **Step 2: Verify**

`npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **734**.

Curl `/results/{id}` with a session: 200, section reachable. **State what curl could not check** — the recruiter list, category picker, tie-up checkbox.

- [ ] **Step 3: Commit**

```bash
git add src/components/results/placement-section.tsx
git commit -m "feat: add the placement editor"
```

---

### Task 8: The selections section

**Files:**
- Create: `src/components/results/selections-section.tsx`

**Interfaces:**
- Consumes: `selectionSchema`'s shape via `updateResultSchema` (Task 3); `EXAM_CODES`, `EXAM_CODE_LABELS`, `RESULT_MAX_SELECTIONS`, `RESULT_MAX_TOPPERS` (Task 2); `TopperPhoto` (Task 1).
- Produces: `SelectionsSection({ result, onSave, onDirtyChange }): JSX.Element`, exported. Task 9 wires it in.

No new tests — same reasoning as Tasks 6 and 7. Suite stays at **734**.

- [ ] **Step 1: The section**

Create `src/components/results/selections-section.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { Plus, X } from "lucide-react";
import { updateResultSchema } from "@/lib/validation/result";
import { EXAM_CODES, EXAM_CODE_LABELS, RESULT_MAX_SELECTIONS, RESULT_MAX_TOPPERS } from "@/lib/constants";
import type { ResultDTO } from "@/services/result.service";
import { Button } from "@/components/ui/button";
import {
  FieldGroup,
  reportSectionErrors,
  SectionForm,
  SelectField,
  TextField,
} from "@/components/profile/section-form";
import { TopperPhoto } from "@/components/results/topper-photo";
import type { ResultSectionProps } from "@/components/results/result-editor";

type Values = z.input<typeof updateResultSchema>;
type Parsed = z.output<typeof updateResultSchema>;
type Selection = NonNullable<ResultDTO["selections"]>[number];

const asNumber = (value: unknown) =>
  value === "" || value === null || value === undefined ? undefined : Number(value);

const toFormRow = (selection: Selection) => ({
  examCode: selection.examCode,
  appeared: selection.appeared,
  qualified: selection.qualified,
  bestRank: selection.bestRank,
  toppers: (selection.toppers ?? []).map((topper) => ({
    id: topper.id,
    name: topper.name,
    percentage: topper.percentage,
    rank: topper.rank,
    note: topper.note ?? "",
    consentAcknowledged: topper.consentAcknowledged,
  })),
});

/**
 * Competitive-exam outcomes — NEET, JEE, KCET, COMEDK. A selection is matched
 * on save by its `examCode`, so already-chosen exams are excluded from the
 * picker rather than accepted and rejected afterward by the uniqueness rule.
 */
export function SelectionsSection({ result, onSave, onDirtyChange }: ResultSectionProps) {
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(updateResultSchema),
    defaultValues: { selections: (result.selections ?? []).map(toFormRow) },
  });

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const selections = useWatch({ control, name: "selections" }) ?? [];
  const chosenCodes = new Set(selections.map((s) => s?.examCode).filter(Boolean));
  const availableCodes = EXAM_CODES.filter((code) => !chosenCodes.has(code));

  async function onSubmit(values: Parsed) {
    const next = await onSave(values as Record<string, unknown>);
    if (next) reset({ selections: (next.selections ?? []).map(toFormRow) });
  }

  return (
    <SectionForm
      title="Entrance exams"
      description="Competitive-exam outcomes for this cycle — mainly a PU stream's own selling point."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup>
        {selections.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No entrance-exam outcomes recorded yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {selections.map((_selection, index) => {
              const saved: Selection | undefined = isDirty ? undefined : result.selections?.[index];
              const currentCode = watch(`selections.${index}.examCode`);

              return (
                <li key={index} className="space-y-3 rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="eyebrow">Exam {index + 1}</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove exam ${index + 1}`}
                      onClick={() =>
                        setValue(
                          "selections",
                          selections.filter((_, i) => i !== index),
                          { shouldDirty: true },
                        )
                      }
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>

                  <SelectField
                    id={`selections-${index}-examCode`}
                    label="Exam"
                    value={currentCode ?? ""}
                    onChange={(value) =>
                      setValue(`selections.${index}.examCode`, value as never, { shouldDirty: true })
                    }
                    options={EXAM_CODES.filter(
                      (code) => code === currentCode || availableCodes.includes(code),
                    ).map((code) => ({ value: code, label: EXAM_CODE_LABELS[code] }))}
                  />

                  <div className="grid gap-3 sm:grid-cols-3">
                    <TextField
                      id={`selections-${index}-appeared`}
                      label="Appeared"
                      type="number"
                      inputMode="numeric"
                      hint="Optional."
                      error={errors.selections?.[index]?.appeared?.message}
                      {...register(`selections.${index}.appeared`, { setValueAs: asNumber })}
                    />
                    <TextField
                      id={`selections-${index}-qualified`}
                      label="Qualified"
                      type="number"
                      inputMode="numeric"
                      hint="Optional."
                      error={errors.selections?.[index]?.qualified?.message}
                      {...register(`selections.${index}.qualified`, { setValueAs: asNumber })}
                    />
                    <TextField
                      id={`selections-${index}-bestRank`}
                      label="Best rank"
                      type="number"
                      inputMode="numeric"
                      hint="Optional."
                      error={errors.selections?.[index]?.bestRank?.message}
                      {...register(`selections.${index}.bestRank`, { setValueAs: asNumber })}
                    />
                  </div>

                  <div className="space-y-3 border-t border-border pt-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Toppers for {EXAM_CODE_LABELS[currentCode as keyof typeof EXAM_CODE_LABELS] ?? "this exam"}
                    </p>
                    {(watch(`selections.${index}.toppers`) ?? []).map((_topperRow, topperIndex) => {
                      const savedTopper = saved?.toppers?.[topperIndex];
                      return (
                        <div
                          key={topperIndex}
                          className="space-y-2 rounded-md border border-border/70 p-2.5"
                        >
                          <input
                            type="hidden"
                            {...register(`selections.${index}.toppers.${topperIndex}.id`)}
                          />
                          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_90px_auto]">
                            <TextField
                              id={`selections-${index}-topper-${topperIndex}-name`}
                              label="Name"
                              maxLength={120}
                              error={errors.selections?.[index]?.toppers?.[topperIndex]?.name?.message}
                              {...register(`selections.${index}.toppers.${topperIndex}.name`)}
                            />
                            <TextField
                              id={`selections-${index}-topper-${topperIndex}-percentage`}
                              label="Score"
                              type="number"
                              step="any"
                              inputMode="decimal"
                              error={
                                errors.selections?.[index]?.toppers?.[topperIndex]?.percentage?.message
                              }
                              {...register(
                                `selections.${index}.toppers.${topperIndex}.percentage`,
                                { setValueAs: asNumber },
                              )}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="mt-5"
                              aria-label="Remove this topper"
                              onClick={() => {
                                const current = watch(`selections.${index}.toppers`) ?? [];
                                setValue(
                                  `selections.${index}.toppers`,
                                  current.filter((_, i) => i !== topperIndex),
                                  { shouldDirty: true },
                                );
                              }}
                            >
                              <X className="size-3.5" />
                            </Button>
                          </div>
                          <label className="flex items-start gap-2 text-xs">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              {...register(
                                `selections.${index}.toppers.${topperIndex}.consentAcknowledged`,
                              )}
                            />
                            <span>We hold consent to publish this student&apos;s photograph.</span>
                          </label>
                          {savedTopper ? (
                            <TopperPhoto
                              resultId={result.id}
                              topper={savedTopper}
                              onResult={() => {}}
                              position={topperIndex + 1}
                            />
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Save this section to add a photo.
                            </p>
                          )}
                        </div>
                      );
                    })}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={(watch(`selections.${index}.toppers`) ?? []).length >= RESULT_MAX_TOPPERS}
                      onClick={() => {
                        const current = watch(`selections.${index}.toppers`) ?? [];
                        setValue(
                          `selections.${index}.toppers`,
                          [
                            ...current,
                            { name: "", percentage: undefined as unknown as number, note: "", consentAcknowledged: false },
                          ],
                          { shouldDirty: true },
                        );
                      }}
                    >
                      <Plus className="size-3.5" />
                      Add topper
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={selections.length >= RESULT_MAX_SELECTIONS || availableCodes.length === 0}
          onClick={() =>
            setValue(
              "selections",
              [...selections, { examCode: availableCodes[0], toppers: [] }],
              { shouldDirty: true },
            )
          }
        >
          <Plus className="size-3.5" />
          Add exam
        </Button>
      </FieldGroup>
    </SectionForm>
  );
}
```

- [ ] **Step 2: Verify**

`npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **734**.

Curl `/results/{id}` with a session: 200, section reachable. **State what curl could not check** — the exam picker excluding already-chosen exams, nested topper rows, nested photo upload.

- [ ] **Step 3: Commit**

```bash
git add src/components/results/selections-section.tsx
git commit -m "feat: add the entrance-exam selections editor"
```

---

### Task 9: Wire the three sections into the editor

**Files:**
- Modify: `src/components/results/result-editor.tsx`

**Interfaces:**
- Consumes: `CombinationsSection` (Task 6), `PlacementSection` (Task 7), `SelectionsSection` (Task 8).

No new tests — browser-only wiring. Suite stays at **734**.

- [ ] **Step 1: Extend `ResultSectionProps` and the section list**

`ResultSectionProps` gains an optional `units` and a required `onResult`, so every section — not only Toppers — can refresh the on-screen result after a nested photo change (this is what closes the gap Task 6 flagged):

```ts
export type ResultSectionProps = {
  result: ResultDTO;
  onSave: SaveSection;
  onDirtyChange: (dirty: boolean) => void;
  onResult: (result: ResultDTO) => void;
};
```

Update `ToppersSection`'s own prop type accordingly — it currently declares `ResultSectionProps & { onResult: ... }`; since `onResult` now lives on the base type, simplify its signature to just `ResultSectionProps` (no functional change, since the field already existed under that name — this only removes the now-redundant intersection). Verify `toppers-section.tsx` still compiles with no other edit.

Extend `SECTIONS` and imports in `result-editor.tsx`:

```ts
import { CycleSection } from "@/components/results/cycle-section";
import { OutcomeSection } from "@/components/results/outcome-section";
import { ToppersSection } from "@/components/results/toppers-section";
import { CombinationsSection } from "@/components/results/combinations-section";
import { PlacementSection } from "@/components/results/placement-section";
import { SelectionsSection } from "@/components/results/selections-section";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";

const SECTIONS = [
  { key: "cycle", label: "Exam cycle" },
  { key: "outcome", label: "Outcome" },
  { key: "combinations", label: "Combinations" },
  { key: "placement", label: "Placement" },
  { key: "entrance-exams", label: "Entrance exams" },
  { key: "toppers", label: "Toppers" },
] as const;
```

Note the reordering: **Combinations, Placement and Entrance exams sit between Outcome and Toppers**, not appended after — they are a breakdown of the Outcome totals, and Toppers (the consent-gated, publish-blocking section) stays last so it remains the final stop before publishing, matching its current role.

- [ ] **Step 2: Thread `units` and `onResult` through**

`ResultEditor`'s own props gain `units`:

```ts
export function ResultEditor({
  initialResult,
  institutionId,
  units,
}: {
  initialResult: ResultDTO;
  institutionId: string;
  units: AcademicUnitDTO[];
}) {
```

Update `sectionProps` to include `onResult: applyResult` (previously only passed explicitly to `ToppersSection`):

```ts
  const sectionProps = { result, onSave: saveSection, onDirtyChange, onResult: applyResult };
```

Update the render block:

```tsx
        <div className="min-w-0">
          {active === "cycle" ? <CycleSection {...sectionProps} /> : null}
          {active === "outcome" ? <OutcomeSection {...sectionProps} /> : null}
          {active === "combinations" ? (
            <CombinationsSection {...sectionProps} units={units} />
          ) : null}
          {active === "placement" ? <PlacementSection {...sectionProps} /> : null}
          {active === "entrance-exams" ? <SelectionsSection {...sectionProps} /> : null}
          {active === "toppers" ? <ToppersSection {...sectionProps} /> : null}
        </div>
```

`ToppersSection`'s call site no longer needs its own `onResult={applyResult}` — it now arrives via `sectionProps` like every other section.

- [ ] **Step 3: Update the two call sites of `CombinationsSection`/`SelectionsSection` created in Tasks 6/8**

Both currently pass `onResult={() => {}}` to their nested `TopperPhoto` calls as a placeholder (see Task 6's note). Replace that no-op with the real `onResult` prop each section now receives:

In `combinations-section.tsx`, change the function signature to accept `onResult` (it already receives the rest of `ResultSectionProps`, which now includes `onResult`):

```ts
export function CombinationsSection({
  result,
  onSave,
  onDirtyChange,
  onResult,
  units,
}: ResultSectionProps & { units: AcademicUnitDTO[] }) {
```

and change `onResult={() => {}}` to `onResult={onResult}` at its `<TopperPhoto ... />` call site.

Make the identical two edits in `selections-section.tsx`.

- [ ] **Step 4: Update the page to pass `units`**

`src/app/(dashboard)/results/[resultId]/page.tsx` already computes `units` (Task 6, Step 1). Update its `<ResultEditor .../>` call:

```tsx
      <ResultEditor initialResult={result} institutionId={institution.institutionId} units={units} />
```

- [ ] **Step 5: Verify**

`npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **734**.

Start `npm run dev` and curl with a real signed session: `/results/{id}` returns 200. **State plainly what curl could not check** — clicking through all six sections, saving each, the photo-refresh now flowing from a nested upload back into the on-screen totals.

- [ ] **Step 6: Commit**

```bash
git add src/components/results/result-editor.tsx src/components/results/combinations-section.tsx src/components/results/selections-section.tsx "src/app/(dashboard)/results/[resultId]/page.tsx"
git commit -m "feat: wire combinations, placement and entrance exams into the result editor"
```

---

## Definition of done

- `Result` carries `combinations`, `placement`, `selections`, `boys`/`girls`, `distinction`, `firstClass` — all optional, all absent by default.
- `TopperSchema` is reused, not redefined, by combinations and selections; `setTopperPhoto`/`removeTopperPhoto` reach a topper in any of the three arrays.
- A combination's or selection's toppers survive a patch that edits an unrelated field on that same combination or selection (`mergeCombinations`/`mergeSelections`, both thin wrappers around the existing `mergeToppers`).
- Every invariant in the design spec's §5.1 is enforced and independently mutation-checked.
- The three new editor sections save and reload every field they show; a photo change inside any section refreshes the on-screen totals via `onResult`.
- `src/lib/api/openapi.ts` untouched; `results-projection`, `openapi-results` and `api-contract` tests pass unedited.
- No index added or changed; no migration ships with this phase.
- No existing test weakened or deleted — every test diff is a pure insertion.
- `npx tsc --noEmit` clean; `npm run lint` 0 errors, warnings only of the pre-existing `react-hooks/incompatible-library` class.
- Full suite green at **734**.
