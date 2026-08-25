# Bulk Fee Assignment and Fee Heads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an institution define its standard charges once, price many classes in one action, and delete fee structures in bulk.

**Architecture:** Three additions, no restructuring. Fee heads are a `{_id:false}` array on `Institution`, shaped like `facilities`. Bulk assignment is one service method doing three round trips regardless of batch size. Bulk delete is one more. The line-item editor is lifted out of the single fee form so both forms share it.

**Tech Stack:** Next.js 16 App Router, Mongoose 8, Zod 4, TypeScript, Vitest 3, react-hook-form, Radix/shadcn UI.

**Spec:** `docs/superpowers/specs/2026-08-25-fee-bulk-and-heads-design.md`

## Global Constraints

- **No public API change.** `src/lib/api/openapi.ts` is untouched; `tests/unit/api-contract.test.ts` still counts **9** public paths; `src/lib/fee-structure/public-projection.ts` and `tests/unit/fee-structure-projection.test.ts` must pass **unedited**.
- **404-never-403, and the distinction that is easy to blur:** a **foreign id fails the whole batch** with `NOT_FOUND` and changes nothing; an **already-priced unit is skipped and reported**. The first is a caller bug, the second is the normal outcome of bulk work.
- **A batch must never half-apply.** Every validation and ownership check runs before the first write.
- **Counts reported are counts the database produced**, never the length of an input list — the Phase 6a correction, which exists because an intended count hides a scoping regression.
- **`requireInstitution()` on every route; `assertSameOrigin(request)` first in every mutating handler.** No `ROLE_PERMISSIONS` entry, no new role.
- **Monochrome design system.** No hue-based colour outside `text-destructive` / `variant="destructive"`.
- **Baseline is 644 passing tests in 73 files.** Every task states its expected total; verify it.
- `npx tsc --noEmit` clean and `npm run lint` at **2 warnings, 0 errors** at the end of every task.
- Commit at the end of every task. This plan runs on `feat/fee-bulk-and-heads`; never commit to `main`.
- Several test files have a known mongodb-memory-server port-collision flake under load (`bearer-routes`, `rate-limit`, `profile-routes`, `staff-routes`, `academic-structure-profile`). A file-level FAIL with tests reported "skipped" is that — re-run once before investigating.

## Routing note, settled in advance

`/api/settings/fees/heads` and `/api/settings/fees/bulk` are static segments sitting beside the existing dynamic `[feeId]`. Next.js resolves static before dynamic, and **this codebase already proves it**: `src/app/api/public/` has `[institutionId]/` beside `institutions/`, and `/api/public/institutions/[slug]/fees` works and is tested. No workaround is needed. Task 3 adds a test that pins it anyway.

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/app/api/settings/fees/heads/route.ts` | `GET` / `PUT` the fee head list |
| `src/app/api/settings/fees/bulk/route.ts` | `POST` bulk create |
| `src/app/api/settings/fees/bulk/delete/route.ts` | `POST` bulk delete |
| `src/app/(dashboard)/fees/heads/page.tsx` | Fee head editor page |
| `src/app/(dashboard)/fees/bulk/page.tsx` | Bulk assignment page |
| `src/components/fees/fee-line-items-editor.tsx` | The shared editor, lifted out of the single form |
| `src/components/fees/fee-heads-editor.tsx` | Repeatable label / amount / frequency rows |
| `src/components/fees/bulk-fee-form.tsx` | Unit checkboxes + year + line items |

**Modify:** `src/lib/constants.ts`, `src/models/Institution.ts`, `src/lib/types.ts`, `src/lib/validation/fee-structure.ts`, `src/services/fee-structure.service.ts`, `src/components/fees/fee-structure-form.tsx`, `src/components/fees/fee-structures-list-view.tsx`, `src/app/(dashboard)/fees/page.tsx`.

**Test — create:** `tests/integration/fee-heads.test.ts`, `tests/integration/fee-bulk-create.test.ts`, `tests/integration/fee-bulk-delete.test.ts`.

**Test — modify:** `tests/unit/fee-structure-validation.test.ts`, `tests/unit/institution-model.test.ts`.

**Test — must NOT change:** `tests/unit/fee-structure-projection.test.ts`, `tests/unit/openapi-fee-structure.test.ts`, `tests/unit/api-contract.test.ts`.

## Test count chain

| After task | New | Total |
|---|---|---|
| baseline | — | 644 |
| 1 | +3 | 647 |
| 2 | +6 | 653 |
| 3 | +5 | 658 |
| 4 | +0 | 658 |
| 5 | +0 | 658 |
| 6 | +6 | 664 |
| 7 | +4 | 668 |
| 8 | +0 | 668 |
| 9 | +6 | 674 |
| 10 | +0 | 674 |

---

### Task 1: Fee heads on the Institution model

**Files:**
- Modify: `src/lib/constants.ts`, `src/models/Institution.ts`, `src/lib/types.ts`
- Test: `tests/unit/institution-model.test.ts` (**+3**)

**Interfaces:**
- Produces: `FEE_HEAD_MAX` from `@/lib/constants`; `Institution.feeHeads` as `{ label: string; amount?: number; frequency?: string }[] | undefined`.

- [ ] **Step 1: Write the failing tests**

They go in the existing `tests/unit/institution-model.test.ts` — verified present, so do not
create a new file.

Three tests. Adapt the surrounding file's fixture style rather than importing a new one:

```ts
  it("stores fee heads with optional defaults", async () => {
    const created = await Institution.create({
      institutionId: "INS0100",
      institutionName: "Test",
      institutionType: "SCHOOL",
      feeHeads: [
        { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
        // A charge whose amount varies by class still deserves a name.
        { label: "Transport" },
      ],
    });

    expect(created.feeHeads).toHaveLength(2);
    expect(created.feeHeads?.[0]?.amount).toBe(60000);
    expect(created.feeHeads?.[1]?.amount).toBeUndefined();
    expect(created.feeHeads?.[1]?.frequency).toBeUndefined();
  });

  it("leaves feeHeads absent when never configured", async () => {
    const created = await Institution.create({
      institutionId: "INS0101",
      institutionName: "Test",
      institutionType: "SCHOOL",
    });

    // `default: undefined` means "never configured" reads as absent, matching
    // `facilities` and `academic.segments`.
    expect(created.feeHeads).toBeUndefined();
  });

  it("rejects a fee head with an unknown frequency or a negative amount", async () => {
    const base = { institutionId: "INS0102", institutionName: "Test", institutionType: "SCHOOL" };

    await expect(
      Institution.create({ ...base, feeHeads: [{ label: "X", frequency: "WEEKLY" }] }),
    ).rejects.toBeDefined();
    await expect(
      Institution.create({ ...base, feeHeads: [{ label: "X", amount: -1 }] }),
    ).rejects.toBeDefined();
  });
```

- [ ] **Step 2: Run to confirm they fail**

Run the file. Expected: FAIL — `feeHeads` is not in the schema, so it is stripped and the
first test's length assertion fails.

- [ ] **Step 3: Add the constant**

Append to `src/lib/constants.ts`:

```ts
/**
 * An institution with thirty distinct charges has a different problem than this
 * feature solves.
 */
export const FEE_HEAD_MAX = 30;
```

- [ ] **Step 4: Add the schema**

In `src/models/Institution.ts`, add `FEE_FREQUENCIES` to the existing `@/lib/constants`
import, then define this beside `FacilitySchema`:

```ts
/**
 * What this institution charges for. A head is a suggestion the line-item editor
 * fills from, never a constraint — a line item may carry any label. Defaults are
 * optional because a charge whose amount genuinely varies by class still deserves
 * a name.
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

and add this field beside `facilities` on `InstitutionSchema`:

```ts
    feeHeads: { type: [FeeHeadSchema], default: undefined },
```

In `src/lib/types.ts`, add to the profile type beside `facilities`:

```ts
  feeHeads?: { label: string; amount?: number; frequency?: string }[];
```

- [ ] **Step 5: Run the tests**

Expected: PASS, 3 new tests.

- [ ] **Step 6: Mutation-check the enum**

Remove `enum: FEE_FREQUENCIES` from the `frequency` field. The third test MUST fail.
Restore, re-run: PASS.

- [ ] **Step 7: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **647 tests passing**.

```bash
git add src/lib/constants.ts src/models/Institution.ts src/lib/types.ts <your test file>
git commit -m "feat: let an institution define the charges it levies"
```

---

### Task 2: Validation for heads, bulk create and bulk delete

**Files:**
- Modify: `src/lib/validation/fee-structure.ts`
- Test: `tests/unit/fee-structure-validation.test.ts` (8 tests → **14**)

**Interfaces:**
- Consumes: `objectIdString` from `./common`, `FEE_HEAD_MAX` and `FEE_FREQUENCIES` from `@/lib/constants`.
- Produces: `feeHeadsSchema`, `bulkCreateFeeSchema`, `bulkDeleteFeeSchema` and their inferred types.

- [ ] **Step 1: Add the schemas**

Append to `src/lib/validation/fee-structure.ts`:

```ts
const BULK_MAX_IDS = 100;

/**
 * Duplicates are rejected rather than silently de-duplicated: a caller sending the
 * same id twice has a bug, and swallowing it hides the bug rather than the request.
 */
const distinctObjectIds = (label: string) =>
  z
    .array(objectIdString)
    .min(1, `Select at least one ${label}`)
    .max(BULK_MAX_IDS, `Cannot process more than ${BULK_MAX_IDS} at once`)
    .refine((values) => new Set(values).size === values.length, {
      message: `Each ${label} can appear only once`,
    });

const feeHeadSchema = z.object({
  label: requiredText("Fee head label", 60),
  amount: z.number().min(0, "Must be 0 or more").optional(),
  frequency: z.enum(FEE_FREQUENCIES).optional(),
});

export const feeHeadsSchema = z.object({
  feeHeads: z
    .array(feeHeadSchema)
    .max(FEE_HEAD_MAX, `At most ${FEE_HEAD_MAX} fee heads`)
    // Same rule and the same reason as line items: a picker with two "Tuition"
    // entries is a picker with a bug.
    .refine(
      (heads) => new Set(heads.map((head) => head.label)).size === heads.length,
      { message: "Each fee head needs a distinct label" },
    ),
});
export type FeeHeadsInput = z.infer<typeof feeHeadsSchema>;

export const bulkCreateFeeSchema = z.object({
  academicUnitIds: distinctObjectIds("class or course"),
  academicYear: requiredText("Academic year", 20),
  lineItems: z.array(feeLineItemSchema).max(FEE_STRUCTURE_MAX_LINE_ITEMS).optional(),
});
export type BulkCreateFeeInput = z.infer<typeof bulkCreateFeeSchema>;

export const bulkDeleteFeeSchema = z.object({
  feeStructureIds: distinctObjectIds("fee structure"),
});
export type BulkDeleteFeeInput = z.infer<typeof bulkDeleteFeeSchema>;
```

Add `FEE_HEAD_MAX` and `FEE_FREQUENCIES` to the existing `@/lib/constants` import, and
`objectIdString` to the existing `./common` import. `feeLineItemSchema` and
`FEE_STRUCTURE_MAX_LINE_ITEMS` already exist in this file — reuse them, do not redefine.

- [ ] **Step 2: Write the tests**

Append six tests to `tests/unit/fee-structure-validation.test.ts`:

```ts
describe("fee heads validation", () => {
  it("accepts a label-only head and one with defaults", () => {
    expect(
      feeHeadsSchema.safeParse({
        feeHeads: [{ label: "Transport" }, { label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate labels", () => {
    expect(
      feeHeadsSchema.safeParse({ feeHeads: [{ label: "Tuition" }, { label: "Tuition" }] }).success,
    ).toBe(false);
  });

  it("rejects more than the maximum", () => {
    const heads = Array.from({ length: 31 }, (_, index) => ({ label: `Head ${index}` }));
    expect(feeHeadsSchema.safeParse({ feeHeads: heads }).success).toBe(false);
    expect(feeHeadsSchema.safeParse({ feeHeads: heads.slice(0, 30) }).success).toBe(true);
  });
});

describe("bulk fee validation", () => {
  it("requires at least one id and rejects duplicates", () => {
    expect(bulkCreateFeeSchema.safeParse({ academicUnitIds: [], academicYear: "2026-27" }).success)
      .toBe(false);
    expect(
      bulkCreateFeeSchema.safeParse({
        academicUnitIds: [OID, OID],
        academicYear: "2026-27",
      }).success,
    ).toBe(false);
  });

  it("caps the batch at 100 and accepts exactly 100", () => {
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        index.toString(16).padStart(24, "0"),
      );
    expect(
      bulkCreateFeeSchema.safeParse({ academicUnitIds: ids(101), academicYear: "2026-27" }).success,
    ).toBe(false);
    expect(
      bulkCreateFeeSchema.safeParse({ academicUnitIds: ids(100), academicYear: "2026-27" }).success,
    ).toBe(true);
  });

  it("applies the same id rules to bulk delete", () => {
    expect(bulkDeleteFeeSchema.safeParse({ feeStructureIds: [] }).success).toBe(false);
    expect(bulkDeleteFeeSchema.safeParse({ feeStructureIds: [OID, OID] }).success).toBe(false);
    expect(bulkDeleteFeeSchema.safeParse({ feeStructureIds: [OID] }).success).toBe(true);
  });
});
```

`OID` is already declared at the top of that file from Phase 6a — check rather than
re-declaring it.

- [ ] **Step 3: Run, then mutation-check**

Run the file. Expected: **14 passing**.

**Mutation:** remove the `.refine` duplicate check from `distinctObjectIds`. "requires at
least one id and rejects duplicates" and "applies the same id rules to bulk delete" MUST both
fail. Restore.

- [ ] **Step 4: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **653 tests passing**.

```bash
git add src/lib/validation/fee-structure.ts tests/unit/fee-structure-validation.test.ts
git commit -m "feat: validate fee heads and bulk fee operations"
```

---

### Task 3: Fee head service and routes

**Files:**
- Modify: `src/services/fee-structure.service.ts`
- Create: `src/app/api/settings/fees/heads/route.ts`
- Test: `tests/integration/fee-heads.test.ts` (**5**)

**Interfaces:**
- Consumes: `Institution` from `@/models`, `feeHeadsSchema` from Task 2.
- Produces: `FeeStructureService.getFeeHeads`, `.setFeeHeads`; `FeeHeadDTO`.

Fee heads live on `Institution` but are a fee concern, so the fee service owns them — the
same arrangement as `AcademicStructureService.getSegments` / `setSegments`, which read and
write `Institution.academic.segments`.

- [ ] **Step 1: Add the service methods**

```ts
export type FeeHeadDTO = { label: string; amount?: number; frequency?: string };

  async getFeeHeads(institutionId: string): Promise<FeeHeadDTO[]> {
    await connectToDatabase();
    const institution = await Institution.findOne({ institutionId })
      .select("feeHeads")
      .lean();
    if (!institution) throw notFound("Institution not found");

    return (institution.feeHeads ?? []).map((head) => ({
      label: head.label,
      amount: head.amount ?? undefined,
      frequency: head.frequency ?? undefined,
    }));
  },

  async setFeeHeads(
    institutionId: string,
    feeHeads: FeeHeadDTO[],
    actor: { id: string; name: string },
  ): Promise<FeeHeadDTO[]> {
    await connectToDatabase();

    // Replaced wholesale, like every other array on this document.
    const updated = await Institution.findOneAndUpdate(
      { institutionId },
      { $set: { feeHeads } },
      { new: true },
    )
      .select("feeHeads")
      .lean();
    if (!updated) throw notFound("Institution not found");

    await ActivityService.record({
      institutionId,
      entityType: "FEE_HEAD",
      entityRef: institutionId,
      action: "Fee heads updated",
      description: `${feeHeads.length} head(s)`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return (updated.feeHeads ?? []).map((head) => ({
      label: head.label,
      amount: head.amount ?? undefined,
      frequency: head.frequency ?? undefined,
    }));
  },
```

- [ ] **Step 2: Add the route**

Create `src/app/api/settings/fees/heads/route.ts`, matching
`src/app/api/settings/fees/route.ts` exactly in shape:

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { feeHeadsSchema } from "@/lib/validation/fee-structure";
import { FeeStructureService } from "@/services/fee-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const feeHeads = await FeeStructureService.getFeeHeads(institution.institutionId);
    return jsonSuccess({ feeHeads });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const { feeHeads } = feeHeadsSchema.parse(await request.json().catch(() => ({})));

    const saved = await FeeStructureService.setFeeHeads(institution.institutionId, feeHeads, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ feeHeads: saved });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 3: Write the tests**

Create `tests/integration/fee-heads.test.ts` with five tests, following
`tests/integration/fee-structure-routes.test.ts`'s harness for signing sessions and building
requests:

1. an admin can save heads and read them back;
2. a head with no amount round-trips with `amount` and `frequency` both undefined;
3. saving replaces the list wholesale — save three, then save one, and read back exactly one;
4. heads are per-institution: INS0002 saving does not change INS0001's;
5. **the static route resolves rather than being swallowed by `[feeId]`** — a `GET` to the
   heads route returns a `feeHeads` array, not a `NOT_FOUND` for a fee structure whose id is
   the literal string "heads". This pins the routing note in the plan header.

- [ ] **Step 4: Run, then mutation-check the tenant scope**

Run the file. Expected: **5 passing**.

**Mutation:** drop `institutionId` from `setFeeHeads`'s `findOneAndUpdate` filter. The
per-institution test MUST fail. Restore.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **658 tests passing**.

```bash
git add src/services/fee-structure.service.ts src/app/api/settings/fees/heads tests/integration/fee-heads.test.ts
git commit -m "feat: read and replace an institution's fee heads"
```

---

### Task 4: The fee heads page

**Files:**
- Create: `src/app/(dashboard)/fees/heads/page.tsx`, `src/components/fees/fee-heads-editor.tsx`
- Modify: `src/components/fees/fee-structures-list-view.tsx` (header link only)

No new tests: this is browser interaction and there is no browser here. Verify by curl and by
reading the diff. Suite stays at **658**.

- [ ] **Step 1: The editor component**

Create `src/components/fees/fee-heads-editor.tsx`, a client component. It takes
`initialFeeHeads: FeeHeadDTO[]` (`import type` — the service is `server-only`), holds them in
a `useFieldArray` over `feeHeadsSchema`, and `PUT`s the whole list.

Follow `fee-structure-form.tsx` for the fetch/toast/`router.refresh()` cycle, and
`create-staff-dialog.tsx` for driving a Radix `Select` with `watch`/`setValue` rather than
`register()` — a Radix Select is a button, not a native input.

Each row: a label `Input`, an optional amount `Input` (`type="number"`, `valueAsNumber`), an
optional frequency `Select` over `FEE_FREQUENCIES` **including a "no default" option**, and a
remove button. Below the rows: "Add fee head" and "Save".

The frequency Select needs an explicit empty choice, because a head may legitimately have no
default frequency and a Radix Select has no native "unset". Use a sentinel value and map it
back to `undefined` on submit — **do not** send an empty string, which would fail the enum.

- [ ] **Step 2: The page**

Create `src/app/(dashboard)/fees/heads/page.tsx` following
`src/app/(dashboard)/fees/new/page.tsx` exactly: `metadata`, `dynamic = "force-dynamic"`, the
four-step guard (no user → `/login`; `SUPER_ADMIN` → `/admin`; not `INSTITUTION_ADMIN` →
`/dashboard`; no institution → `/login`), a back link to `/fees`, and a `PageHeader`.

Load with `FeeStructureService.getFeeHeads(institution.institutionId)`.

Header description: explain that heads are shortcuts the line-item editor fills from, and that
a line item can still carry any label. That sentence is the whole mental model.

- [ ] **Step 3: Link it from the fees list**

In `fee-structures-list-view.tsx`, add a "Fee heads" button beside the existing "Add a fee
structure" action, linking to `/fees/heads`. Match the existing button's size and variant.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **658**.

Then start `npm run dev` and curl with a real signed session cookie: `/fees/heads` returns 200
with the editor; `/fees` returns 200 with the new link. **State plainly what curl could not
check** — Select open state, option clicks, save.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/fees/heads" src/components/fees/fee-heads-editor.tsx src/components/fees/fee-structures-list-view.tsx
git commit -m "feat: add the fee heads editor"
```

---

### Task 5: Extract the shared line-item editor

**Files:**
- Create: `src/components/fees/fee-line-items-editor.tsx`
- Modify: `src/components/fees/fee-structure-form.tsx`

**A pure refactor plus one addition.** Behaviour of the existing form must not change; the
suite stays at **658** with no test edited. If a fee-structure test needs changing, the
refactor changed behaviour — stop and report.

**Read the spec's §3 "A known risk, named up front" before starting.**

- [ ] **Step 1: Lift the block out**

Move the entire line-items section out of `fee-structure-form.tsx` into
`FeeLineItemsEditor`. It must be generic over the form's values, because Task 8's bulk form
has `academicUnitIds: string[]` where this one has `academicUnitId: string`, while both carry
`lineItems` at the same path:

```tsx
export function FeeLineItemsEditor<T extends FieldValues>({
  control,
  register,
  watch,
  setValue,
  errors,
  feeHeads,
}: {
  control: Control<T>;
  register: UseFormRegister<T>;
  watch: UseFormWatch<T>;
  setValue: UseFormSetValue<T>;
  errors: FieldErrors<T>;
  /** Empty means the institution has configured none; the prefill control is then absent. */
  feeHeads: FeeHeadDTO[];
})
```

Field paths become `` `lineItems.${index}.label` as Path<T> `` and similar. Keep every
existing comment about why the Radix `Select` and `Checkbox` are driven by `watch`/`setValue`
rather than `register()` — that reasoning is still true and still load-bearing.

**If this typing cannot be satisfied without `any`, stop and report.** Do not cast. The
sanctioned fallback is to leave the editor in the single form and let Task 8 duplicate it —
worse, but honest. An `any` at a form boundary silently stops checking every field path in
both forms, which is a far larger loss than the duplication.

- [ ] **Step 2: Add fee-head prefill**

Above the rows, when `feeHeads.length > 0`, render a control that appends a row from a head:

```tsx
              onClick={() =>
                append({
                  label: head.label,
                  // A head with no default leaves the amount at 0 for the admin to
                  // fill; picking one is a shortcut, never a mode.
                  amount: head.amount ?? 0,
                  frequency: head.frequency ?? "ANNUAL",
                  optional: false,
                } as never)
              }
```

When `feeHeads` is empty, render **nothing** — not a disabled control and not an empty
dropdown. There is nothing to pick from.

- [ ] **Step 3: Rewire the single form**

`fee-structure-form.tsx` renders `<FeeLineItemsEditor control={control} … feeHeads={feeHeads} />`
and takes a new `feeHeads: FeeHeadDTO[]` prop. Its two pages
(`/fees/new`, `/fees/[feeId]`) load heads with
`FeeStructureService.getFeeHeads(institution.institutionId)` and pass them down.

- [ ] **Step 4: Verify nothing moved**

Run: `npx vitest run tests/integration/fee-structure-crud.test.ts tests/integration/fee-structure-routes.test.ts`
Expected: **12 and 12**, both green, **neither file edited**. That is the evidence the
refactor changed no behaviour.

Then `npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **658**.

Curl `/fees/new` and an existing `/fees/{id}`: both 200, line-item rows present, and the
prefill control present only when heads exist. **State what curl could not check.**

- [ ] **Step 5: Commit**

```bash
git add src/components/fees/fee-line-items-editor.tsx src/components/fees/fee-structure-form.tsx "src/app/(dashboard)/fees/new/page.tsx" "src/app/(dashboard)/fees/[feeId]/page.tsx"
git commit -m "refactor: share the line-item editor and fill rows from fee heads"
```

---

### Task 6: Bulk create in the service

**Files:**
- Modify: `src/services/fee-structure.service.ts`
- Test: `tests/integration/fee-bulk-create.test.ts` (**6**)

**Interfaces:**
- Produces: `FeeStructureService.createMany(institutionId, input, actor)` returning
  `{ created: number; skipped: { academicUnitId: string; classOrCourse: string }[] }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/fee-bulk-create.test.ts`, following
`tests/integration/fee-structure-crud.test.ts`'s harness. Six tests:

1. creates a draft for every selected unit — `created` equals the count, `skipped` empty, and
   every structure is `DRAFT` with no `publishedAt`;
2. **skips an already-priced unit and names it** — `skipped[0].classOrCourse` is the unit's
   path label, not its id, because the admin has to read which classes were left alone;
3. all-already-priced returns `created: 0` with every unit in `skipped`;
4. **a foreign `academicUnitId` fails the whole batch with `NOT_FOUND`** — and, critically,
   `FeeStructure.countDocuments({})` afterwards is **unchanged**. A batch that half-applies
   before failing is the worst outcome here and only this assertion catches it;
5. a malformed id also fails with `NOT_FOUND`, never a 500;
6. duplicate line-item labels are refused before anything is written — assert both the throw
   and that nothing was created.

- [ ] **Step 2: Run to confirm they fail**

Expected: FAIL — `createMany` is not a function.

- [ ] **Step 3: Implement**

```ts
  async createMany(
    institutionId: string,
    input: BulkCreateFeeInput,
    actor: { id: string; name: string },
  ): Promise<{ created: number; skipped: { academicUnitId: string; classOrCourse: string }[] }> {
    await connectToDatabase();

    // Checked once on the shared set, before anything is written: every structure in
    // the batch gets identical line items, so a per-unit check would repeat the same
    // work N times and could half-apply the batch.
    assertFeeStructureInvariants({ lineItems: input.lineItems });

    const ids = input.academicUnitIds.map(unitObjectId);
    const units = await AcademicUnit.find({ _id: { $in: ids }, institutionId })
      .select("_id pathLabel")
      .lean<{ _id: Types.ObjectId; pathLabel: string }[]>();

    // A foreign or nonexistent unit fails the WHOLE batch, before any write. That is
    // deliberately different from an already-priced unit, which is skipped below: the
    // first is a caller bug, the second is the expected outcome of bulk work.
    if (units.length !== ids.length) throw notFound("Academic unit not found");

    const existing = await FeeStructure.find({
      institutionId,
      academicUnitId: { $in: ids },
      academicYear: input.academicYear,
    })
      .select("academicUnitId")
      .lean<{ academicUnitId: Types.ObjectId }[]>();
    const taken = new Set(existing.map((row) => String(row.academicUnitId)));

    const skipped = units
      .filter((unit) => taken.has(String(unit._id)))
      .map((unit) => ({ academicUnitId: String(unit._id), classOrCourse: unit.pathLabel }));
    const fresh = units.filter((unit) => !taken.has(String(unit._id)));

    if (fresh.length > 0) {
      await FeeStructure.insertMany(
        fresh.map((unit) => ({
          institutionId,
          academicUnitId: unit._id,
          academicYear: input.academicYear,
          lineItems: input.lineItems,
          status: "DRAFT",
        })),
      );
    }

    // One entry for the batch, not one per structure — an audit trail with sixty
    // identical lines is harder to read than one that says what happened.
    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityRef: institutionId,
      action: "Fee structures created in bulk",
      description: `${fresh.length} created, ${skipped.length} skipped for ${input.academicYear}`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return { created: fresh.length, skipped };
  },
```

`unitObjectId`, `assertFeeStructureInvariants`, `AcademicUnit` and `notFound` are already
imported in this file from Phase 6a — confirm rather than re-importing.

- [ ] **Step 4: Run, then mutation-check the two guards that matter**

Run the file. Expected: **6 passing**.

1. Delete `if (units.length !== ids.length) throw notFound(...)`. Test 4 MUST fail — and note
   whether it fails on the missing throw or on the count assertion, because the second means
   the batch half-applied.
2. Move `assertFeeStructureInvariants` to after the `insertMany`. Test 6 MUST fail on its
   "nothing was created" assertion, not on the throw.

Report both. If either does not fail, stop.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **664**.

```bash
git add src/services/fee-structure.service.ts tests/integration/fee-bulk-create.test.ts
git commit -m "feat: create fee structures for many units at once"
```

---

### Task 7: The bulk create route

**Files:**
- Create: `src/app/api/settings/fees/bulk/route.ts`
- Test: append to `tests/integration/fee-bulk-create.test.ts` (6 → **10**)

- [ ] **Step 1: Write the route**

Mirror `src/app/api/settings/fees/route.ts`'s `POST` exactly — `assertSameOrigin` first,
then `requireInstitution`, then parse, then call. Return `jsonSuccess({ created, skipped })`
with the default 200: this is not a single-resource creation, so 201 would be misleading when
`created` can be 0.

- [ ] **Step 2: Add four route tests**

1. an admin bulk-creates — 200, `created` correct;
2. an anonymous caller gets 401; a Counselor and a Front Desk get 403; a platform admin gets 403;
3. a foreign `academicUnitId` returns **404 with `error.code === "NOT_FOUND"`** — assert the
   code, not merely a 4xx, because "some error" would also pass against a 403 and 404-never-403
   is the rule being checked;
4. a cross-origin write is rejected with **403 and `FORBIDDEN`** — `assertSameOrigin` throws
   `forbidden("Cross-origin request rejected")`, so assert that specifically rather than
   `>= 400`.

- [ ] **Step 3: Run, then mutation-check**

Expected: **10 passing** in the file.

**Mutation:** comment out `assertSameOrigin(request)`. The cross-origin test MUST fail.
Restore.

- [ ] **Step 4: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **668**.

```bash
git add src/app/api/settings/fees/bulk/route.ts tests/integration/fee-bulk-create.test.ts
git commit -m "feat: expose bulk fee creation over HTTP"
```

---

### Task 8: The bulk assignment page

**Files:**
- Create: `src/app/(dashboard)/fees/bulk/page.tsx`, `src/components/fees/bulk-fee-form.tsx`
- Modify: `src/components/fees/fee-structures-list-view.tsx` (header action only)

No new tests. Suite stays at **668**. Verify by curl and by reading the diff.

- [ ] **Step 1: The form**

Create `src/components/fees/bulk-fee-form.tsx`, a client component taking
`units: AcademicUnitDTO[]` and `feeHeads: FeeHeadDTO[]` (both `import type`).

- A `Checkbox` per unit, rendered in tree order and indented by `depth`, reusing
  `flattenTree` from `@/lib/academic/tree`. Show `unit.name` with the indent conveying
  hierarchy — the full `pathLabel` on every row is noise when the tree is visible.
- "Select all" and "Clear" — the point of this screen is pricing ten classes at once, and
  ticking ten boxes by hand is most of the work it exists to remove.
- An academic year `Input`.
- `<FeeLineItemsEditor … feeHeads={feeHeads} />` from Task 5.
- On success, report **both numbers**: "Created 7, skipped 3", and list the skipped units by
  `classOrCourse` from the response. `created: 0` with a populated `skipped` means every
  selected class was already priced — say that in words rather than showing a bare zero.

Drive the checkboxes with `watch`/`setValue` over an `academicUnitIds` array, not
`register()` — a Radix `Checkbox` is a button with no native `onChange`.

- [ ] **Step 2: The page**

Create `src/app/(dashboard)/fees/bulk/page.tsx` following `/fees/new/page.tsx`: same guard
sequence, same back link, `PageHeader`.

Load units and heads, and **filter units exactly as `/fees/new` does** — `flattenTree` then
exclude `inactiveIds`, so effectively-inactive units (hidden themselves or under a hidden
branch) are not offered.

When no usable units exist, render the same empty state `/fees/new` uses, pointing at
`/academic-structure`. Read that page and reuse its shape rather than inventing a second one.

- [ ] **Step 3: Link it**

Add a "Bulk add" action to the fees list header, beside "Add a fee structure" and "Fee heads".

- [ ] **Step 4: Verify**

`npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **668**.

Curl `/fees/bulk` with a real session: 200, checkboxes present with unit names; and for an
institution with no units, the empty state. **State what curl could not check** — checkbox
clicks, select-all, submission, the result summary.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/fees/bulk" src/components/fees/bulk-fee-form.tsx src/components/fees/fee-structures-list-view.tsx
git commit -m "feat: price many classes in one action"
```

---

### Task 9: Bulk delete in the service and over HTTP

**Files:**
- Modify: `src/services/fee-structure.service.ts`
- Create: `src/app/api/settings/fees/bulk/delete/route.ts`
- Test: `tests/integration/fee-bulk-delete.test.ts` (**6**)

**Interfaces:**
- Produces: `FeeStructureService.removeMany(institutionId, feeStructureIds, actor)` returning `{ deleted: number }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/fee-bulk-delete.test.ts`. Six tests:

1. deletes every named structure and returns the count;
2. **a foreign id fails the whole batch with `NOT_FOUND` and deletes nothing** — assert
   `countDocuments` afterwards is unchanged;
3. a malformed id fails with `NOT_FOUND`, never a 500;
4. deleting a PUBLISHED structure removes it from the public API — create, publish, confirm
   `listPublic` returns it, bulk delete, confirm it is gone;
5. over HTTP: an admin gets 200 with the count; a Counselor gets 403; a platform admin gets 403;
6. over HTTP: a cross-origin write is rejected with **403 and `FORBIDDEN`**.

- [ ] **Step 2: Implement the service method**

```ts
  async removeMany(
    institutionId: string,
    feeStructureIds: string[],
    actor: { id: string; name: string },
  ): Promise<{ deleted: number }> {
    await connectToDatabase();
    const ids = feeStructureIds.map(toObjectId);

    // Ownership is verified BEFORE anything is deleted. A scoped `deleteMany` alone
    // would remove nothing for a foreign id and report a lower count — succeeding
    // silently where a foreign id must fail the batch.
    const owned = await FeeStructure.countDocuments({ _id: { $in: ids }, institutionId });
    if (owned !== ids.length) throw notFound("Fee structure not found");

    const result = await FeeStructure.deleteMany({ _id: { $in: ids }, institutionId });

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityRef: institutionId,
      action: "Fee structures deleted in bulk",
      description: `${result.deletedCount} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    // The count the database actually removed, never the length of the id list —
    // reporting an intended count is how a scoping regression hides.
    return { deleted: result.deletedCount };
  },
```

- [ ] **Step 3: The route**

Create `src/app/api/settings/fees/bulk/delete/route.ts` with a `POST`, mirroring the bulk
create route. A `POST` to a `/delete` sub-path rather than a `DELETE` with a body: a `DELETE`
carrying a body is poorly supported by intermediaries and this codebase has no precedent for
it.

- [ ] **Step 4: Run, then mutation-check the ownership gate**

Expected: **6 passing**.

**Mutation:** delete the `if (owned !== ids.length) throw notFound(...)` check. Test 2 MUST
fail — and note **which assertion** fails. If it fails on the missing throw but the count
assertion would have passed, the scoped `deleteMany` was silently protecting the data; if the
count assertion fails, it was not. Report which, because that distinction is the whole reason
the gate exists.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **674**.

```bash
git add src/services/fee-structure.service.ts src/app/api/settings/fees/bulk/delete tests/integration/fee-bulk-delete.test.ts
git commit -m "feat: delete fee structures in bulk"
```

---

### Task 10: Selection and bulk delete on the fees list

**Files:**
- Modify: `src/components/fees/fee-structures-list-view.tsx`, `src/app/(dashboard)/fees/page.tsx`

No new tests. Suite stays at **674**.

- [ ] **Step 1: Make the list a client component with selection**

`fee-structures-list-view.tsx` becomes `"use client"` and holds a `Set<string>` of selected
ids: a header checkbox toggling all, a checkbox per row, and a "Delete selected (N)" button
rendered **only when at least one row is selected** — a permanently visible destructive
control on a list is an invitation to a mistake.

Confirm with a `Dialog` naming the count, warning that any published structure disappears from
the public API immediately, and using `variant="destructive"` on the confirm. Follow
`fee-structure-actions.tsx` for the dialog and the fetch/toast/`router.refresh()` cycle.

On success, clear the selection before refreshing — stale ids in a `Set` after a refresh is
how a second click deletes the wrong thing.

- [ ] **Step 2: Check the page still works**

`/fees/page.tsx` is a server component rendering this list. Making the list a client component
is fine — it receives plain serialisable props. **Confirm it still passes `feeStructures`
without change**, and that nothing else imported the list expecting a server component.

- [ ] **Step 3: Verify**

`npx tsc --noEmit && npm run lint && npm test -- --run` — clean, **674**.

Curl `/fees`: 200, checkboxes present, and the delete button **absent** with nothing selected.
**State what curl could not check** — selection, the dialog, the delete itself.

- [ ] **Step 4: Commit**

```bash
git add src/components/fees/fee-structures-list-view.tsx "src/app/(dashboard)/fees/page.tsx"
git commit -m "feat: select and delete fee structures from the list"
```

---

## Definition of done

- `Institution.feeHeads` with optional defaults; `FEE_HEAD_MAX` enforced in validation.
- Three validation schemas reusing `objectIdString`, `feeLineItemSchema` and
  `assertFeeStructureInvariants` rather than redefining them.
- `getFeeHeads`, `setFeeHeads`, `createMany`, `removeMany` — all tenant-scoped, all reporting
  counts the database produced.
- Four routes, all `requireInstitution()`, all mutating handlers `assertSameOrigin` first.
- A foreign id fails its batch with `NOT_FOUND` and changes nothing; an already-priced unit is
  skipped and reported by path label. Both proven by a test that counts documents afterwards.
- `FeeLineItemsEditor` shared by both forms — **or** a reported and accepted duplication if the
  generic typing proves impossible without `any` (spec §3).
- `/fees/heads`, `/fees/bulk`, and selection plus bulk delete on `/fees`.
- `src/lib/api/openapi.ts` untouched: `git diff main --stat -- src/lib/api/openapi.ts` empty.
- `tests/unit/fee-structure-projection.test.ts`, `tests/unit/openapi-fee-structure.test.ts` and
  `tests/unit/api-contract.test.ts` pass **unedited**:
  `git diff main --stat --` on those three is empty.
- No existing fee test file lost a test.
- `npx tsc --noEmit` clean, `npm run lint` at 2 warnings / 0 errors, **674 passing**.
- Every guard added in this plan mutation-checked as its task specified.
