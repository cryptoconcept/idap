# Fee Structures on Academic Units — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-key fee structures from a free-text class name onto an academic unit, deriving the display label live from the unit, and give `AcademicStructureService.remove` the fee-reference guard Phase 5 deferred.

**Architecture:** One column becomes a foreign key and one string becomes a join. A single enrichment helper in `FeeStructureService` batch-fetches referenced units and attaches `classOrCourse` from the unit's current `pathLabel`; every read path goes through it, so the DTO and the public projection keep exactly the shape they have today.

**Tech Stack:** Next.js 16 App Router, Mongoose 8, Zod 4, TypeScript, Vitest 3, Radix/shadcn UI.

**Spec:** `docs/superpowers/specs/2026-08-25-fee-structures-on-units-design.md`

## Global Constraints

- **The public fee contract must not move.** `src/lib/api/openapi.ts` is untouched; `tests/unit/api-contract.test.ts` still counts **9** public paths; and `tests/unit/fee-structure-projection.test.ts` and `tests/unit/openapi-fee-structure.test.ts` must pass **unedited**. If either needs a change, the contract moved — stop and report.
- **No fee test file may end with fewer tests than it started with.** Each task states the before/after count for the files it touches. A file that loses a test has lost coverage; that is a finding, not a tidy-up.
- **A test's assertion may not be weakened to make it pass.** If a test asserted on `classOrCourse` and still can, it must — the label still exists, it is just derived now.
- **404-never-403.** A foreign or malformed `academicUnitId` reads as `NOT_FOUND`, never `FORBIDDEN`. Every query is scoped by `institutionId` from the session.
- **`assertSameOrigin(request)` stays first in every mutating route handler.**
- **No `ROLE_PERMISSIONS` entry, no new route, no new role.** Phase 6a adds no authorization surface.
- **Monochrome design system.** No hue-based colour outside `text-destructive` / `variant="destructive"`.
- **Baseline is 634 passing tests in 72 files.** Every task states its expected total; verify it.
- `npx tsc --noEmit` clean and `npm run lint` at **2 warnings, 0 errors** at the end of every task.
- Commit at the end of every task. This plan runs on `feat/fee-structure-units`; never commit to `main`.
- Four test files have a known mongodb-memory-server port-collision flake under load: `bearer-routes`, `rate-limit`, `profile-routes`, `staff-routes`. A file-level FAIL with tests reported "skipped" is that — re-run once before investigating.

---

## File Structure

**Modify:**

| File | Change |
|---|---|
| `src/lib/validation/common.ts` | gains the shared `objectIdString` |
| `src/lib/validation/academic-structure.ts` | imports it instead of defining it |
| `src/lib/validation/fee-structure.ts` | `academicUnitId` replaces `classOrCourse` |
| `src/models/FeeStructure.ts` | `academicUnitId` required + indexed; `classOrCourse` gone; unique key moved |
| `src/services/fee-structure.service.ts` | the enrichment helper; every read and write path |
| `src/services/academic-structure.service.ts` | the fee-reference delete guard |
| `src/components/fees/fee-structure-form.tsx` | free-text input becomes a unit picker |
| `src/app/(dashboard)/fees/new/page.tsx` | loads units; empty state when there are none |
| `src/app/(dashboard)/fees/[feeId]/page.tsx` | shows the unit read-only |

**Test — migrate:** `tests/unit/fee-structure-model.test.ts`, `tests/unit/fee-structure-validation.test.ts`, `tests/integration/fee-structure-crud.test.ts`, `tests/integration/fee-structure-routes.test.ts`, `tests/integration/fee-structure-publish.test.ts`, `tests/integration/fee-structure-public.test.ts`.

**Test — create:** `tests/integration/fee-structure-enrichment.test.ts`.

**Test — must NOT change:** `tests/unit/fee-structure-projection.test.ts`, `tests/unit/openapi-fee-structure.test.ts`, `tests/unit/api-contract.test.ts`, and every `academic-structure-*` test except where Task 5 adds to one.

## Test count chain

| After task | New | Total |
|---|---|---|
| baseline | — | 634 |
| 1 | +0 | 634 |
| 2 | +1 | 635 |
| 3 | +1 | 636 |
| 4 | +0 | 636 |
| 5 | +4 | 640 |
| 6 | +0 | 640 |
| 7 | +3 | 643 |
| 8 | +0 | 643 |

---

### Task 1: Lift `objectIdString` into the shared validation module

**Files:**
- Modify: `src/lib/validation/common.ts`, `src/lib/validation/academic-structure.ts`

**Interfaces:**
- Produces: `objectIdString` exported from `@/lib/validation/common`.

Two validation modules now need the same object-id shape check. Defining it twice invites them to drift.

- [ ] **Step 1: Add it to `common.ts`**

Append to `src/lib/validation/common.ts`:

```ts
/**
 * A 24-character hex object id, as a string. Shape only — whether the id
 * refers to anything is a service concern, and a malformed one is turned into
 * NOT_FOUND there rather than a 500.
 */
export const objectIdString = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");
```

- [ ] **Step 2: Repoint the academic-structure module**

In `src/lib/validation/academic-structure.ts`, delete the local `const objectIdString = …`
block and add `objectIdString` to the existing import from `./common`, keeping it
alphabetical:

```ts
import { objectIdString, requiredText } from "./common";
```

- [ ] **Step 3: Verify nothing moved**

Run: `npx vitest run tests/unit/academic-structure-validation.test.ts`
Expected: **7 passing, file unedited.** That the existing tests pass untouched is the
evidence the lift changed no behaviour. If any of them needs a change, stop and report.

- [ ] **Step 4: Verify the suite and the types**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **634 tests passing** — unchanged, this task adds none.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/common.ts src/lib/validation/academic-structure.ts
git commit -m "refactor: share the object id shape check between validators"
```

---

### Task 2: Re-key the FeeStructure model

**Files:**
- Modify: `src/models/FeeStructure.ts`
- Test: `tests/unit/fee-structure-model.test.ts` (3 tests → **4**)

**Interfaces:**
- Produces: `FeeStructureDoc` with `academicUnitId: Types.ObjectId` and no `classOrCourse`.

- [ ] **Step 1: Rewrite the test file**

Replace the whole of `tests/unit/fee-structure-model.test.ts` with:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { FeeStructure } from "@/models";

const UNIT_A = new Types.ObjectId();
const UNIT_B = new Types.ObjectId();

beforeAll(async () => {
  await startTestDatabase("fee-structure-model");
  // Mongoose builds indexes in the background; without waiting the very first
  // duplicate write can race ahead of the unique index existing on the server.
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

const base = {
  institutionId: "INS0001",
  academicUnitId: UNIT_A,
  academicYear: "2026-27",
};

describe("FeeStructure model", () => {
  it("creates a document with DRAFT status by default and no publishedAt", async () => {
    const created = await FeeStructure.create(base);

    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();
    expect(String(created.academicUnitId)).toBe(String(UNIT_A));
  });

  it("requires an academic unit", async () => {
    await expect(
      FeeStructure.create({ institutionId: "INS0001", academicYear: "2026-27" }),
    ).rejects.toBeDefined();
  });

  it("enforces one record per institution, unit and academic year", async () => {
    await FeeStructure.create(base);

    await expect(FeeStructure.create(base)).rejects.toMatchObject({ code: 11000 });
  });

  it("allows the same unit in a second year, and the same year for a second unit", async () => {
    await FeeStructure.create(base);

    await expect(
      FeeStructure.create({ ...base, academicYear: "2027-28" }),
    ).resolves.toBeDefined();
    await expect(FeeStructure.create({ ...base, academicUnitId: UNIT_B })).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/unit/fee-structure-model.test.ts`
Expected: FAIL — `academicUnitId` is not in the schema and `classOrCourse` is still required.

- [ ] **Step 3: Change the model**

In `src/models/FeeStructure.ts`, replace the `classOrCourse` field with:

```ts
    /**
     * The academic unit this prices. No `ref`: nothing here uses Mongoose
     * `populate`, and the service's enrichment helper queries the model
     * directly — a `ref` would imply an access pattern that does not exist.
     */
    academicUnitId: { type: Schema.Types.ObjectId, required: true, index: true },
```

and replace the unique index with:

```ts
/** One fee structure per unit per academic year. Refused by the index, not a pre-read. */
FeeStructureSchema.index(
  { institutionId: 1, academicUnitId: 1, academicYear: 1 },
  { unique: true },
);
```

Leave the other two indexes alone. `Schema` is already imported.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/fee-structure-model.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation-check the unique key**

Remove `{ unique: true }` from the new index, re-run the file. "enforces one record per
institution, unit and academic year" MUST fail. Restore, re-run: PASS.

- [ ] **Step 6: Expect broad breakage, and leave it**

`npx tsc --noEmit` will now fail across the service, validation, and several test files —
they still reference `classOrCourse`. **That is expected at this point.** Tasks 3–7 clear it.
Do not attempt to fix those files here. Report the failure count so the next task knows
the starting point.

- [ ] **Step 7: Commit**

```bash
git add src/models/FeeStructure.ts tests/unit/fee-structure-model.test.ts
git commit -m "feat: key fee structures by academic unit"
```

---

### Task 3: Re-key fee validation

**Files:**
- Modify: `src/lib/validation/fee-structure.ts`
- Test: `tests/unit/fee-structure-validation.test.ts` (7 tests → **8**)

**Interfaces:**
- Consumes: `objectIdString` from `@/lib/validation/common` (Task 1).
- Produces: `createFeeStructureSchema` with `academicUnitId`; `updateFeeStructureSchema` with neither `academicUnitId` nor `status`.

- [ ] **Step 1: Change the schemas**

In `src/lib/validation/fee-structure.ts`, add `objectIdString` to the import from
`./common`, then replace the `identityFields` block and the update schema:

```ts
const identityFields = {
  academicUnitId: objectIdString,
  academicYear: requiredText("Academic year", 20),
};

export const createFeeStructureSchema = z.object({
  ...identityFields,
  lineItems: z.array(feeLineItemSchema).max(FEE_STRUCTURE_MAX_LINE_ITEMS).optional(),
});

/**
 * `status` is absent so a PATCH can never smuggle a structure into PUBLISHED and
 * skip the publish gate. `academicUnitId` is absent for the same mechanism and a
 * different reason: moving a fee structure to another unit would carry its unique
 * key with it. Both are stripped by Zod, the codebase's established way of making
 * a field immutable.
 */
export const updateFeeStructureSchema = z.object({
  academicYear: identityFields.academicYear.optional(),
  lineItems: z.array(feeLineItemSchema).max(FEE_STRUCTURE_MAX_LINE_ITEMS).optional(),
});
```

- [ ] **Step 2: Migrate the tests and add one**

In `tests/unit/fee-structure-validation.test.ts`, replace every `classOrCourse: "…"` in a
create payload with `academicUnitId: OID`, declaring `const OID = "6a887abd755db527bea51204";`
at the top. Any test asserting that `classOrCourse` is required becomes the same assertion
about `academicUnitId`, plus a rejection of a non-hex value.

**Keep all 7 existing tests** — none of them becomes meaningless. Then add:

```ts
  it("strips academicUnitId from a patch instead of applying it", () => {
    // Same mechanism as `status`: moving a fee structure to another unit would
    // take its unique key with it, so the field is simply absent from the schema.
    const parsed = updateFeeStructureSchema.parse({
      academicYear: "2027-28",
      academicUnitId: OID,
      status: "PUBLISHED",
    }) as Record<string, unknown>;

    expect(parsed.academicYear).toBe("2027-28");
    expect(parsed.academicUnitId).toBeUndefined();
    expect(parsed.status).toBeUndefined();
  });
```

- [ ] **Step 3: Run the file**

Run: `npx vitest run tests/unit/fee-structure-validation.test.ts`
Expected: PASS, **8 tests**.

- [ ] **Step 4: Mutation-check the immutability**

Add `academicUnitId: objectIdString.optional(),` to `updateFeeStructureSchema`, re-run.
The new test MUST fail. Restore, re-run: PASS.

- [ ] **Step 5: Commit**

`tsc` still fails on the service and remaining test files — expected until Task 7.

```bash
git add src/lib/validation/fee-structure.ts tests/unit/fee-structure-validation.test.ts
git commit -m "feat: validate fee structures against an academic unit"
```

---

### Task 4: The service — enrichment, and every path through it

**Files:**
- Modify: `src/services/fee-structure.service.ts`
- Test: `tests/integration/fee-structure-crud.test.ts` (12 tests → **12**, migrated)

**Interfaces:**
- Consumes: `AcademicUnit` from `@/models`; `createFeeStructureSchema`/`updateFeeStructureSchema` types (Task 3).
- Produces: `FeeStructureDTO` gaining `academicUnitId: string` and keeping `classOrCourse: string`; every read path returning enriched rows.

This is the core of the phase. After it, `tsc` should be clean again except for the UI and the not-yet-migrated test files.

- [ ] **Step 1: Add the enrichment helper and its types**

In `src/services/fee-structure.service.ts`, add `AcademicUnit` to the `@/models` import,
then add these at module scope, after the existing `toObjectId`:

```ts
/** A row with its label attached. The label is never stored — see `withLabels`. */
type FeeStructureRow = FeeStructureDoc & { classOrCourse: string };

/** A malformed unit id must read as "no such unit", not as a 500. */
function unitObjectId(academicUnitId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(academicUnitId)) throw notFound("Academic unit not found");
  return new Types.ObjectId(academicUnitId);
}

/**
 * Fee structures store a unit id, not a label. Every read path passes its rows
 * through here, which fetches the referenced units in ONE query and attaches each
 * row's `classOrCourse` from the unit's current `pathLabel`.
 *
 * Deriving rather than storing is what makes renaming a branch fix every fee
 * structure beneath it on the next read, with no cascade to maintain.
 */
async function withLabels(
  institutionId: string,
  rows: FeeStructureDoc[],
): Promise<FeeStructureRow[]> {
  if (rows.length === 0) return [];

  const units = await AcademicUnit.find({
    _id: { $in: rows.map((row) => row.academicUnitId) },
    institutionId,
  })
    .select("_id pathLabel")
    .lean<{ _id: Types.ObjectId; pathLabel: string }[]>();

  const labelById = new Map(units.map((unit) => [String(unit._id), unit.pathLabel]));

  return rows.map((row) => ({
    ...row,
    // A referenced unit cannot be missing while the delete guard holds. An empty
    // string keeps the DTO honest, and the public projection's `text()` drops an
    // empty value rather than publishing one.
    classOrCourse: labelById.get(String(row.academicUnitId)) ?? "",
  }));
}

/** Newest year first, then by the label a reader actually sees. */
function byYearThenLabel(a: FeeStructureRow, b: FeeStructureRow): number {
  if (a.academicYear !== b.academicYear) return b.academicYear.localeCompare(a.academicYear);
  return a.classOrCourse.localeCompare(b.classOrCourse);
}
```

- [ ] **Step 2: Widen the DTO and retype `serialize`**

```ts
export type FeeStructureDTO = {
  id: string;
  academicUnitId: string;
  classOrCourse: string;
  academicYear: string;
  lineItems?: { label: string; amount: number; frequency: string; optional: boolean }[];
  status: string;
  publishedAt?: string;
  updatedAt?: string;
};
```

In `serialize`, change the parameter type to `FeeStructureRow` and the identity fields to:

```ts
    id: String(row._id),
    academicUnitId: String(row.academicUnitId),
    classOrCourse: row.classOrCourse,
    academicYear: row.academicYear,
```

Leave the rest of `serialize` exactly as it is.

- [ ] **Step 3: Route every read through the helper**

`list`:

```ts
  async list(institutionId: string): Promise<FeeStructureDTO[]> {
    await connectToDatabase();
    const rows = await FeeStructure.find({ institutionId }).lean<FeeStructureDoc[]>();
    // Sorted in memory: the database cannot sort by a label that lives on another
    // collection, and a $lookup is disproportionate for tens of rows.
    return (await withLabels(institutionId, rows)).sort(byYearThenLabel).map(serialize);
  },
```

`get`:

```ts
  async get(institutionId: string, feeStructureId: string): Promise<FeeStructureDTO> {
    await connectToDatabase();
    const row = await findOwned(institutionId, feeStructureId);
    const [enriched] = await withLabels(institutionId, [row]);
    return serialize(enriched);
  },
```

`listPublic` — keep the institution visibility gate exactly as it is, and change only the
query and the tail:

```ts
    const rows = await FeeStructure.find(filter).lean<FeeStructureDoc[]>();

    // The projection is the allow-list; it also re-checks PUBLISHED, so a filter
    // mistake here cannot leak an unpublished record.
    return (await withLabels(institution.institutionId, rows))
      .sort(byYearThenLabel)
      .map((row) => toPublicFeeStructure(row as unknown as Record<string, unknown>))
      .filter((row): row is PublicFeeStructure => row !== null);
```

Remove the `.sort({ academicYear: -1, classOrCourse: 1 })` from both queries — that column
no longer exists.

- [ ] **Step 4: Load the unit on create**

In `create`, before `FeeStructure.create`:

```ts
    // Scoped by institutionId, so another institution's unit is "no such unit" —
    // NOT_FOUND, never FORBIDDEN.
    const unit = await AcademicUnit.findOne({
      _id: unitObjectId(input.academicUnitId),
      institutionId,
    })
      .select("_id pathLabel")
      .lean();
    if (!unit) throw notFound("Academic unit not found");
```

Then use `unit.pathLabel` in the activity description in place of `input.classOrCourse`, and
return:

```ts
    return serialize({
      ...(created.toObject() as FeeStructureDoc),
      classOrCourse: unit.pathLabel,
    });
```

- [ ] **Step 5: Fix the three remaining audit descriptions**

`update`, `setStatus` and `remove` each interpolate `classOrCourse` into an
`ActivityService.record` description and each already holds exactly one row. Enrich that one
row and use its label. For example, in `setStatus` after the `findOneAndUpdate`:

```ts
    const [enriched] = await withLabels(institutionId, [updated]);
```

then use `enriched.classOrCourse` in the description and `serialize(enriched)` as the
return. Apply the same shape in `update`. In `remove`, enrich `before` before recording.

- [ ] **Step 6: Migrate the CRUD tests**

In `tests/integration/fee-structure-crud.test.ts`, add `AcademicUnit` to the `@/models`
import and `AcademicStructureService` from `@/services/academic-structure.service`, then
replace the module-level `input` with a per-test unit. Add to `beforeEach`, after the
institutions are made:

```ts
  await AcademicUnit.syncIndexes();
  unitA = await AcademicStructureService.create(
    "INS0001",
    { segment: "SCHOOL", name: "Grade 10" },
    actor,
  );
  unitB = await AcademicStructureService.create(
    "INS0001",
    { segment: "SCHOOL", name: "Grade 9" },
    actor,
  );
  foreignUnit = await AcademicStructureService.create(
    "INS0002",
    { segment: "SCHOOL", name: "Grade 10" },
    actor,
  );
```

with `let unitA: AcademicUnitDTO; let unitB: AcademicUnitDTO; let foreignUnit: AcademicUnitDTO;`
declared above, and build inputs as
`{ academicUnitId: unitA.id, academicYear: "2026-27", lineItems: [...] }`.

**Keep all 12 tests.** Every one still means something:
- the test that asserted a duplicate `(classOrCourse, academicYear)` is refused now asserts
  a duplicate `(academicUnitId, academicYear)` is;
- the test that two institutions may hold the same class independently now uses `unitA` and
  `foreignUnit`, which is a stronger version of the same claim;
- the test asserting a partial patch does not erase untouched fields keeps its
  `academicYear` patch;
- any test asserting on `created.classOrCourse` keeps that assertion — the label is still
  there, now equal to the unit's `pathLabel` (`"Grade 10"`).

Add no tests here; Task 7 covers enrichment behaviour in its own file.

- [ ] **Step 7: Run the file, then the suite**

Run: `npx vitest run tests/integration/fee-structure-crud.test.ts` — **12 passing**.
Then `npx tsc --noEmit`: it should now fail **only** in the UI files and the four
not-yet-migrated test files. Report exactly which. If it fails anywhere else, stop.

- [ ] **Step 8: Mutation-check the tenant boundary on the unit lookup**

Drop `institutionId` from the `AcademicUnit.findOne` filter in `create`. Re-run the crud
file — the test creating against `foreignUnit` MUST fail. Restore, re-run: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/services/fee-structure.service.ts tests/integration/fee-structure-crud.test.ts
git commit -m "feat: derive the fee structure label from its academic unit"
```

---

### Task 5: The delete guard Phase 5 deferred

**Files:**
- Modify: `src/services/academic-structure.service.ts`
- Test: `tests/integration/academic-structure-crud.test.ts` (13 tests → **17**)

**Interfaces:**
- Consumes: `FeeStructure` from `@/models`.
- Produces: `AcademicStructureService.remove` refusing a subtree that carries fee structures.

This is the highest-value carry-forward from the Phase 5 spec. Until now, deleting a unit
silently orphaned any fee structure pointing at it.

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/academic-structure-crud.test.ts`, importing `FeeStructureService`
from `@/services/fee-structure.service` and `FeeStructure` from `@/models`, and calling
`await FeeStructure.syncIndexes()` in `beforeAll` alongside the existing `AcademicUnit` one:

```ts
describe("AcademicStructureService delete guard", () => {
  const fee = (academicUnitId: string) => ({
    academicUnitId,
    academicYear: "2026-27",
    lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" as const }],
  });

  it("refuses to delete a unit that carries a fee structure", async () => {
    const grade = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 10" },
      actor,
    );
    await FeeStructureService.create("INS0001", fee(grade.id), actor);

    await expect(AcademicStructureService.remove("INS0001", grade.id, actor)).rejects.toMatchObject(
      { code: "VALIDATION_ERROR" },
    );
    expect(await AcademicStructureService.list("INS0001")).toHaveLength(1);
  });

  it("refuses to delete an ANCESTOR of a unit that carries one", async () => {
    // The guard counts across the whole subtree: deleting a programme must be
    // refused when a fee hangs off a branch below it.
    await AcademicStructureService.setSegments("INS0004", ["ENGINEERING"], actor);
    const programme = await AcademicStructureService.create(
      "INS0004",
      { segment: "ENGINEERING", name: "B.E." },
      actor,
    );
    const branch = await AcademicStructureService.create(
      "INS0004",
      { segment: "ENGINEERING", parentId: programme.id, name: "Computer Science" },
      actor,
    );
    await FeeStructureService.create("INS0004", fee(branch.id), actor);

    await expect(
      AcademicStructureService.remove("INS0004", programme.id, actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("allows the delete once the fee structure is gone", async () => {
    const grade = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 10" },
      actor,
    );
    const created = await FeeStructureService.create("INS0001", fee(grade.id), actor);
    await FeeStructureService.remove("INS0001", created.id, actor);

    await expect(AcademicStructureService.remove("INS0001", grade.id, actor)).resolves.toEqual({
      deleted: 1,
    });
  });

  it("is not blocked by another institution's fee structure", async () => {
    // The guard is tenant-scoped. INS0002's fees are not INS0001's problem.
    const mine = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 10" },
      actor,
    );
    const theirs = await AcademicStructureService.create(
      "INS0002",
      { segment: "SCHOOL", name: "Grade 10" },
      actor,
    );
    await FeeStructureService.create("INS0002", fee(theirs.id), actor);

    await expect(AcademicStructureService.remove("INS0001", mine.id, actor)).resolves.toEqual({
      deleted: 1,
    });
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx vitest run tests/integration/academic-structure-crud.test.ts`
Expected: the first, second and fourth fail (deletes that should be refused succeed).

- [ ] **Step 3: Add the guard**

In `src/services/academic-structure.service.ts`, add `FeeStructure` to the `@/models`
import. In `remove`, **replace** the Phase 6 obligation comment with the guard itself —
the obligation is discharged, so the comment must go with it:

```ts
    const ids = await subtreeIds(institutionId, before);

    // Counted across the whole subtree, not just this unit: deleting a programme
    // must be refused when a fee hangs off a branch three levels below it.
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

- [ ] **Step 4: Run the file**

Run: `npx vitest run tests/integration/academic-structure-crud.test.ts` — **17 passing**.

- [ ] **Step 5: Mutation-check the guard, twice**

1. Delete the `if (referenced > 0)` throw. "refuses to delete a unit that carries a fee
   structure" MUST fail. Restore.
2. Narrow the count to `academicUnitId: before._id` instead of `{ $in: ids }`. "refuses to
   delete an ANCESTOR" MUST fail while the others still pass — that is the subtree case,
   and it is the one a naive implementation gets wrong. Restore.

Report both. If either does not fail, stop.

- [ ] **Step 6: Verify the obligation comment is gone**

Run: `grep -n "Phase 6 obligation" src/services/academic-structure.service.ts`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/services/academic-structure.service.ts tests/integration/academic-structure-crud.test.ts
git commit -m "feat: refuse deleting an academic unit that still carries fees"
```

---

### Task 6: Migrate the route and publish tests

**Files:**
- Test: `tests/integration/fee-structure-routes.test.ts` (12 → **12**), `tests/integration/fee-structure-publish.test.ts` (5 → **5**)

No production code changes. Both files construct fee structures with `classOrCourse` and
must construct them against a real academic unit instead.

- [ ] **Step 1: Migrate both files**

In each, import `AcademicStructureService` from `@/services/academic-structure.service` and
`AcademicUnit` from `@/models`, add `await AcademicUnit.syncIndexes()` to `beforeAll`, and
create the units the tests need in `beforeEach` after the institutions exist — the same
shape Task 4 used in the CRUD file.

Replace every `classOrCourse: "Grade 10"` in a request body with `academicUnitId: unitA.id`.
Where a test asserts on a response's `classOrCourse`, **keep that assertion** and expect the
unit's name (`"Grade 10"`) — the field still exists and still carries a label.

**Both files keep every test.** In particular:
- the routes file's cross-tenant test still uses another institution's fee structure id;
- its 201-on-create test still asserts the created payload;
- the publish file's gate tests (publishing with no line items is refused, `publishedAt` is
  stamped once and never moved) are untouched in substance.

- [ ] **Step 2: Add one route-level case to the routes file — WITHOUT raising the count**

The routes file's existing create test asserts a 201. Extend **that same test** (do not add a
new `it`) with the foreign-unit case, since it is a route-level expression of the boundary
Task 4 checked at the service:

```ts
    // A unit belonging to another institution is "no such unit" — NOT_FOUND, never
    // FORBIDDEN, and never a 500.
    const foreign = await createFee(
      cookieRequest({
        body: { academicUnitId: foreignUnit.id, academicYear: "2026-27" },
        origin: "http://localhost",
      }),
    );
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.code).toBe("NOT_FOUND");
```

- [ ] **Step 3: Run both files**

Run: `npx vitest run tests/integration/fee-structure-routes.test.ts tests/integration/fee-structure-publish.test.ts`
Expected: **12 and 5 passing**. If either count differs from its start, you have added or
lost a test — reconcile before moving on.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/fee-structure-routes.test.ts tests/integration/fee-structure-publish.test.ts
git commit -m "test: build fee structures from academic units in the route tests"
```

---

### Task 7: Migrate the public tests, and prove the derivation

**Files:**
- Test: `tests/integration/fee-structure-public.test.ts` (10 → **10**), create `tests/integration/fee-structure-enrichment.test.ts` (**3**)

**Interfaces:** none new. This task is the evidence that decision 1 works and that §8's
contract held.

- [ ] **Step 1: Migrate the public tests**

Same migration as Task 6. **`tests/unit/fee-structure-projection.test.ts` and
`tests/unit/openapi-fee-structure.test.ts` must not be touched** — they are the proof the
public shape did not move. If either fails, stop and report; the contract moved.

- [ ] **Step 2: Write the enrichment tests**

Create `tests/integration/fee-structure-enrichment.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit, FeeStructure } from "@/models";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { FeeStructureService } from "@/services/fee-structure.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(async () => {
  await startTestDatabase("fee-structure-enrichment");
  await AcademicUnit.syncIndexes();
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001", { active: true, profileStatus: "PUBLISHED" });
});

const fee = (academicUnitId: string, academicYear = "2026-27") => ({
  academicUnitId,
  academicYear,
  lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" as const }],
});

describe("fee structure labels are derived, not stored", () => {
  it("reads the unit's full path, not just its name", async () => {
    await AcademicStructureService.setSegments("INS0001", ["PRE_UNIVERSITY"], actor);
    const year = await AcademicStructureService.create(
      "INS0001",
      { segment: "PRE_UNIVERSITY", name: "PUC 1st Year" },
      actor,
    );
    const combination = await AcademicStructureService.create(
      "INS0001",
      { segment: "PRE_UNIVERSITY", parentId: year.id, name: "PCMB" },
      actor,
    );
    const created = await FeeStructureService.create("INS0001", fee(combination.id), actor);

    expect(created.classOrCourse).toBe("PUC 1st Year › PCMB");
  });

  it("reflects a rename on the next read, admin and public alike", async () => {
    // The whole point of deriving rather than storing: no cascade, no staleness.
    const grade = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 10" },
      actor,
    );
    const created = await FeeStructureService.create("INS0001", fee(grade.id), actor);
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    await AcademicStructureService.update("INS0001", grade.id, { name: "Class 10" }, actor);

    expect((await FeeStructureService.get("INS0001", created.id)).classOrCourse).toBe("Class 10");
    const published = await FeeStructureService.listPublic({ institutionId: "INS0001" });
    expect(published?.[0]?.classOrCourse).toBe("Class 10");
  });

  it("sorts the admin list by the derived label within a year", async () => {
    const b = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Beta" },
      actor,
    );
    const a = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Alpha" },
      actor,
    );
    await FeeStructureService.create("INS0001", fee(b.id), actor);
    await FeeStructureService.create("INS0001", fee(a.id), actor);

    const listed = await FeeStructureService.list("INS0001");
    expect(listed.map((row) => row.classOrCourse)).toEqual(["Alpha", "Beta"]);
  });
});
```

- [ ] **Step 3: Run, then mutation-check the derivation**

Run: `npx vitest run tests/integration/fee-structure-enrichment.test.ts` — **3 passing**.

**Mutation:** in `withLabels`, return the rows unchanged with a hardcoded
`classOrCourse: "x"`. All three MUST fail. Restore.

**Mutation:** change `byYearThenLabel` to sort by `academicYear` only. The sorting test MUST
fail. Restore.

- [ ] **Step 4: Full suite**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: `tsc` now fails **only** in the three UI files (Task 8). Report the count.
Tests: **643 passing**, with `fee-structure-projection` and `openapi-fee-structure` green
and unedited.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/fee-structure-public.test.ts tests/integration/fee-structure-enrichment.test.ts
git commit -m "test: prove fee labels follow the unit, including after a rename"
```

---

### Task 8: The unit picker

**Files:**
- Modify: `src/components/fees/fee-structure-form.tsx`, `src/app/(dashboard)/fees/new/page.tsx`, `src/app/(dashboard)/fees/[feeId]/page.tsx`

**Interfaces:**
- Consumes: `AcademicUnitDTO` (type-only — the service is `server-only`), `flattenTree` and `inactiveIds` from `@/lib/academic/tree`.
- Produces: `FeeStructureForm` taking a `units` prop.

No new tests: this is browser interaction and there is no browser here. Verify by curl and
by reading the diff. The suite must stay at **643**.

- [ ] **Step 1: Give the form a unit picker**

In `src/components/fees/fee-structure-form.tsx`:

- Add `units: AcademicUnitDTO[]` to the props (import the type with `import type`).
- Change `Values` to come from `createFeeStructureSchema` as before — it now carries
  `academicUnitId` instead of `classOrCourse`.
- In `defaultValues`, replace `classOrCourse` with
  `academicUnitId: initialFeeStructure?.academicUnitId ?? ""`.
- Replace the "Class or course" `Input` block with: when `isEditing`, a read-only line
  showing `initialFeeStructure.classOrCourse`; otherwise a `Select` over `units`.

```tsx
        <div className="space-y-1.5">
          <Label htmlFor="academicUnitId">Class or course</Label>
          {isEditing ? (
            <>
              <p className="pt-1.5 text-sm">{initialFeeStructure.classOrCourse}</p>
              {/*
                Not editable: moving a fee structure to another unit would carry its
                unique key with it, so the API strips the field. Delete and recreate
                instead — an input that looks editable but is not would be worse.
              */}
              <p className="text-xs text-muted-foreground">
                To price a different class or course, create a new fee structure.
              </p>
            </>
          ) : (
            <>
              {/*
                A Radix Select is a button, not a native input, so it is driven by
                watch/setValue rather than register() — the same way
                `create-staff-dialog.tsx` and this form's own frequency Select do.
              */}
              <Select
                value={watch("academicUnitId")}
                onValueChange={(value) =>
                  setValue("academicUnitId", value, { shouldDirty: true })
                }
              >
                <SelectTrigger id="academicUnitId" aria-invalid={Boolean(errors.academicUnitId)}>
                  <SelectValue placeholder="Pick a class or course" />
                </SelectTrigger>
                <SelectContent>
                  {units.map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.pathLabel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.academicUnitId ? (
                <p className="text-xs text-destructive">{errors.academicUnitId.message}</p>
              ) : null}
            </>
          )}
        </div>
```

The full `pathLabel` is shown, not the bare name, so "B.E. › CSE › Year 1" is unambiguous
against "B.Tech › CSE › Year 1".

One consequence worth knowing rather than discovering: `Values` is inferred from the create
schema, so when editing, the submitted body still carries `academicUnitId`. The PATCH schema
omits the field, so Zod strips it server-side and it cannot move the record — Task 3's
"strips academicUnitId from a patch" test is exactly that guarantee. Harmless, and not a bug
to fix.

- [ ] **Step 2: Load units on the create page, with an empty state**

In `src/app/(dashboard)/fees/new/page.tsx`, after the institution guard:

```tsx
  const allUnits = await AcademicStructureService.list(institution.institutionId);
  // Effectively-inactive units are excluded — Phase 5's read-time rule, where a unit
  // counts as inactive when it or any ancestor is. Pricing something you have hidden,
  // or something under a branch you have hidden, is not a thing to offer.
  const hidden = inactiveIds(allUnits);
  const units = flattenTree(allUnits).filter((unit) => !hidden.has(unit.id));
```

and render the empty state in place of the form when `units.length === 0`:

```tsx
      {units.length === 0 ? (
        <EmptyState
          title="No classes or courses yet"
          description="Fees attach to a class or course from your academic structure. Add one first, then come back to price it."
          action={
            <Button asChild size="sm">
              <Link href="/academic-structure">Go to academic structure</Link>
            </Button>
          }
        />
      ) : (
        <FeeStructureForm initialFeeStructure={null} units={units} />
      )}
```

**Read `src/components/shared/empty-state.tsx` before writing this** — match its real props
rather than the shape guessed above. If it takes no `action`, render the button beneath it.

Also soften the page's `description`, which currently says "Name the class or course" — it is
now picked, not named.

- [ ] **Step 3: Pass an empty list from the editor page**

`src/app/(dashboard)/fees/[feeId]/page.tsx` renders the same form for editing, where the
picker is not shown. Pass `units={[]}` and leave the rest of the page alone.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: **clean at last**, lint 2 warnings / 0 errors, **643 passing in 73 files**.

Then start `npm run dev` and curl with a real signed session cookie:
- `/fees/new` for an institution with units → 200, the picker present with `pathLabel`s;
- `/fees/new` for one with none → 200, the empty state and the academic-structure link;
- an existing `/fees/{id}` → 200, the unit shown as text with no select.

**State plainly what curl could not verify** — Select open state, option clicks, submission.

- [ ] **Step 5: Commit**

```bash
git add src/components/fees/fee-structure-form.tsx "src/app/(dashboard)/fees/new/page.tsx" "src/app/(dashboard)/fees/[feeId]/page.tsx"
git commit -m "feat: pick a class or course from the academic structure"
```

---

## Definition of done

- `FeeStructure.academicUnitId` required and indexed; `classOrCourse` gone from the model;
  unique key `(institutionId, academicUnitId, academicYear)`.
- `objectIdString` lives in `src/lib/validation/common.ts` and both validators import it.
- Every fee read path goes through `withLabels`; nothing else in `src/` reads `pathLabel`
  off a fee structure. Check: `grep -rn "pathLabel" src/services/fee-structure.service.ts`
  shows it only inside `withLabels` and `create`'s unit lookup.
- `AcademicStructureService.remove` refuses a subtree carrying fee structures, and
  `grep -n "Phase 6 obligation" src/services/academic-structure.service.ts` is empty.
- `src/lib/api/openapi.ts` untouched: `git diff main --stat -- src/lib/api/openapi.ts` empty.
- `tests/unit/fee-structure-projection.test.ts`, `tests/unit/openapi-fee-structure.test.ts`
  and `tests/unit/api-contract.test.ts` all pass **unedited**:
  `git diff main --stat -- tests/unit/fee-structure-projection.test.ts tests/unit/openapi-fee-structure.test.ts tests/unit/api-contract.test.ts` is empty.
- No fee test file has fewer tests than it started with: 3→4, 7→8, 12→12, 12→12, 5→5, 10→10.
- `npx tsc --noEmit` clean, `npm run lint` at 2 warnings / 0 errors, **643 passing**.
- Every guard added in this plan mutation-checked as its task specified.
