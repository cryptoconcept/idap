# Phase 4 — Fee Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an institution publish a class/course fee structure, itemized by line item, versioned by academic year, readable by any website through the same credential-free public API pattern Results Management established.

**Architecture:** A new `feestructures` collection, tenant-scoped by `institutionId`, one record per `(institutionId, classOrCourse, academicYear)`. Institution Admin creates a DRAFT, edits its identity and line items, publishes it (making it public), and can archive or delete it. The public read path is an allow-list projection, mirroring `toPublicResult()` exactly. No new role or permission is added — every write route reuses the existing `requireInstitution()` guard, the same boundary Results, Staff, and Settings already use.

**Tech Stack:** Next.js 16 App Router, Mongoose 8, Zod 4, TypeScript, Vitest 3, react-hook-form + `@hookform/resolvers/zod`.

**Spec:** `docs/superpowers/specs/2026-08-24-fee-structure-design.md`

## Global Constraints

- **No payment collection, no per-student assignment, no multi-currency, no effective-dating.** This module publishes a price list. Nothing here moves money, tracks who owes what, or schedules a future-dated change. (Spec §1.)
- **`classOrCourse` is free text, never validated against `Institution.classesOffered`.** No enum, no foreign-key check. (Spec decisions 2–3.)
- **Line items are itemized**, each `{ label, amount, frequency, optional }`. `frequency` is exactly `ONE_TIME` \| `ANNUAL` — no other values. (Spec decision 4–5.)
- **Fee structures are versioned by academic year**, one record per `(institutionId, classOrCourse, academicYear)`, lifecycle `DRAFT` → `PUBLISHED` → `ARCHIVED`, identical shape to `Result`. (Spec decision 6.)
- **Only `INSTITUTION_ADMIN` may create, edit, publish, or delete a fee structure.** No new `ROLE_PERMISSIONS` entry — every write route uses `requireInstitution()` directly, exactly like `/api/settings/results`, `/api/settings/staff`, and `/api/settings/settings`. Counselor and Front Desk get 403 on every write route. (Spec decision 8, §7.)
- **A `feeId` from another institution returns `NOT_FOUND`, never `FORBIDDEN`** — the platform-wide rule, every prior phase.
- **The public projection is an allow-list, never a spread.** `toPublicFeeStructure()` is the sole path from a stored document to a public response, and only projects a `PUBLISHED` record. (Spec §8.)
- **Every guard is verified by mutation**: remove it, confirm the named test fails, restore it. Same discipline as every prior phase.
- **The pre-existing 496 tests must stay green** at every commit.

---

### Task 1: Constants and the `FeeStructure` model

**Files:**
- Modify: `src/lib/constants.ts` (append)
- Create: `src/models/FeeStructure.ts`
- Modify: `src/models/index.ts`
- Test: `tests/unit/fee-structure-model.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `FEE_FREQUENCIES = ["ONE_TIME", "ANNUAL"] as const`, `type FeeFrequency`, `FEE_FREQUENCY_LABELS`
  - `FEE_STRUCTURE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const`, `type FeeStructureStatus`, `FEE_STRUCTURE_STATUS_LABELS`
  - `FeeStructure: Model<FeeStructureDoc>`, `type FeeStructureDoc`, exported from `src/models/index.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fee-structure-model.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { FeeStructure } from "@/models";

beforeAll(async () => {
  await startTestDatabase("fee-structure-model");
  // Mongoose builds indexes in the background; without waiting for it here,
  // the very first duplicate write can race ahead of the unique index
  // actually existing on the server. Same pattern as results-crud.test.ts.
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("FeeStructure model", () => {
  it("creates a document with DRAFT status by default and no publishedAt", async () => {
    const created = await FeeStructure.create({
      institutionId: "INS0001",
      classOrCourse: "Grade 10",
      academicYear: "2026-27",
    });

    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();
  });

  it("enforces one record per institution, class/course and academic year", async () => {
    await FeeStructure.create({
      institutionId: "INS0001",
      classOrCourse: "Grade 10",
      academicYear: "2026-27",
    });

    await expect(
      FeeStructure.create({
        institutionId: "INS0001",
        classOrCourse: "Grade 10",
        academicYear: "2026-27",
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("allows the same class/course and year across two institutions", async () => {
    await FeeStructure.create({
      institutionId: "INS0001",
      classOrCourse: "Grade 10",
      academicYear: "2026-27",
    });

    await expect(
      FeeStructure.create({
        institutionId: "INS0002",
        classOrCourse: "Grade 10",
        academicYear: "2026-27",
      }),
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/fee-structure-model.test.ts
```

Expected: FAIL — cannot resolve `FeeStructure` from `@/models`.

- [ ] **Step 3: Append to `src/lib/constants.ts`**

Add at the very end of the file:

```ts
export const FEE_FREQUENCIES = ["ONE_TIME", "ANNUAL"] as const;
export type FeeFrequency = (typeof FEE_FREQUENCIES)[number];

export const FEE_FREQUENCY_LABELS: Record<FeeFrequency, string> = {
  ONE_TIME: "One-time",
  ANNUAL: "Annual",
};

export const FEE_STRUCTURE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type FeeStructureStatus = (typeof FEE_STRUCTURE_STATUSES)[number];

export const FEE_STRUCTURE_STATUS_LABELS: Record<FeeStructureStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};
```

- [ ] **Step 4: Create `src/models/FeeStructure.ts`**

```ts
import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { FEE_FREQUENCIES, FEE_STRUCTURE_STATUSES } from "@/lib/constants";

/**
 * No `_id`: a line item has no identity of its own — nothing (no photo, no
 * separate endpoint) ever addresses one individually, so the whole array
 * replaces wholesale on every write, the same way `Result.bands` does.
 */
const FeeLineItemSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    frequency: { type: String, enum: FEE_FREQUENCIES, required: true },
    optional: { type: Boolean, default: false },
  },
  { _id: false },
);

const FeeStructureSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    classOrCourse: { type: String, required: true, trim: true },
    academicYear: { type: String, required: true, trim: true },

    lineItems: { type: [FeeLineItemSchema], default: undefined },

    status: { type: String, enum: FEE_STRUCTURE_STATUSES, default: "DRAFT" },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

FeeStructureSchema.index({ institutionId: 1, createdAt: -1 });
FeeStructureSchema.index({ institutionId: 1, status: 1, academicYear: -1 });

/** One record per class/course per academic year. Duplicates are refused by the index, not by a pre-read. */
FeeStructureSchema.index(
  { institutionId: 1, classOrCourse: 1, academicYear: 1 },
  { unique: true },
);

export type FeeStructureDoc = InferSchemaType<typeof FeeStructureSchema> & { _id: Types.ObjectId };

export const FeeStructure: Model<FeeStructureDoc> =
  (models.FeeStructure as Model<FeeStructureDoc>) ?? model<FeeStructureDoc>("FeeStructure", FeeStructureSchema);
```

- [ ] **Step 5: Register the model in `src/models/index.ts`**

Add this line, in the same style as every other export in the file (after the `Result` line):

```ts
export { FeeStructure, type FeeStructureDoc } from "./FeeStructure";
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run tests/unit/fee-structure-model.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Run the full suite to confirm nothing regressed**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: typecheck clean, 496 pre-existing + 3 new = 499 passing.

- [ ] **Step 8: Commit**

```bash
git add src/lib/constants.ts src/models/FeeStructure.ts src/models/index.ts tests/unit/fee-structure-model.test.ts
git commit -m "feat: add FeeStructure model and constants"
```

---

### Task 2: Validation

**Files:**
- Create: `src/lib/validation/fee-structure.ts`
- Test: `tests/unit/fee-structure-validation.test.ts`

**Interfaces:**
- Consumes: `requiredText` from `@/lib/validation/common` (Task 1's constants already exist); `validationError` from `@/lib/api/errors`.
- Produces:
  - `createFeeStructureSchema`, `type CreateFeeStructureInput`
  - `updateFeeStructureSchema`, `type UpdateFeeStructureInput`
  - `feeStructureQuerySchema`
  - `type FeeStructureInvariantInput = { lineItems?: { label: string; amount: number; frequency: string; optional?: boolean }[] | null }`
  - `assertFeeStructureInvariants(input: FeeStructureInvariantInput): void`
  - `assertFeeStructurePublishable(input: FeeStructureInvariantInput): void`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fee-structure-validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assertFeeStructureInvariants,
  assertFeeStructurePublishable,
  createFeeStructureSchema,
} from "@/lib/validation/fee-structure";

describe("createFeeStructureSchema", () => {
  it("accepts a structure with no line items", () => {
    const result = createFeeStructureSchema.safeParse({
      classOrCourse: "Grade 10",
      academicYear: "2026-27",
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 20 line items", () => {
    const lineItems = Array.from({ length: 21 }, (_, i) => ({
      label: `Item ${i}`,
      amount: 100,
      frequency: "ANNUAL" as const,
    }));

    const result = createFeeStructureSchema.safeParse({
      classOrCourse: "Grade 10",
      academicYear: "2026-27",
      lineItems,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative amount", () => {
    const result = createFeeStructureSchema.safeParse({
      classOrCourse: "Grade 10",
      academicYear: "2026-27",
      lineItems: [{ label: "Tuition", amount: -1, frequency: "ANNUAL" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("assertFeeStructureInvariants", () => {
  it("passes with distinct labels", () => {
    expect(() =>
      assertFeeStructureInvariants({
        lineItems: [
          { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
          { label: "Admission Fee", amount: 5000, frequency: "ONE_TIME" },
        ],
      }),
    ).not.toThrow();
  });

  it("throws on a duplicate label", () => {
    expect(() =>
      assertFeeStructureInvariants({
        lineItems: [
          { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
          { label: "Tuition", amount: 5000, frequency: "ONE_TIME" },
        ],
      }),
    ).toThrow(/appears more than once/i);
  });
});

describe("assertFeeStructurePublishable", () => {
  it("throws with zero line items", () => {
    expect(() => assertFeeStructurePublishable({ lineItems: [] })).toThrow(
      /at least one line item/i,
    );
  });

  it("passes with at least one line item and no duplicate labels", () => {
    expect(() =>
      assertFeeStructurePublishable({
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/fee-structure-validation.test.ts
```

Expected: FAIL — cannot resolve `@/lib/validation/fee-structure`.

- [ ] **Step 3: Create `src/lib/validation/fee-structure.ts`**

```ts
import { z } from "zod";
import { FEE_FREQUENCIES } from "@/lib/constants";
import { validationError } from "@/lib/api/errors";
import { requiredText } from "./common";

const FEE_STRUCTURE_MAX_LINE_ITEMS = 20;

const feeLineItemSchema = z.object({
  label: requiredText("Line item label", 60),
  amount: z.number().min(0, "Must be 0 or more"),
  frequency: z.enum(FEE_FREQUENCIES),
  optional: z.boolean().optional(),
});

const identityFields = {
  classOrCourse: requiredText("Class or course", 120),
  academicYear: requiredText("Academic year", 20),
};

export const createFeeStructureSchema = z.object({
  ...identityFields,
  lineItems: z.array(feeLineItemSchema).max(FEE_STRUCTURE_MAX_LINE_ITEMS).optional(),
});
export type CreateFeeStructureInput = z.infer<typeof createFeeStructureSchema>;

/**
 * `status` is absent on purpose: a fee structure changes state only through
 * the publish route, so a PATCH can never smuggle a structure into PUBLISHED
 * and skip the "at least one line item" gate.
 */
export const updateFeeStructureSchema = z.object({
  classOrCourse: identityFields.classOrCourse.optional(),
  academicYear: identityFields.academicYear.optional(),
  lineItems: z.array(feeLineItemSchema).max(FEE_STRUCTURE_MAX_LINE_ITEMS).optional(),
});
export type UpdateFeeStructureInput = z.infer<typeof updateFeeStructureSchema>;

export const feeStructureQuerySchema = z.object({
  academicYear: z.string().trim().max(20).optional(),
});

export type FeeStructureInvariantInput = {
  lineItems?: { label: string; amount: number; frequency: string; optional?: boolean }[] | null;
};

/**
 * Cross-field rules, checked against the MERGED record rather than the
 * request body — a PATCH carrying only one new line item still has to be
 * checked against the whole stored list once merged.
 */
export function assertFeeStructureInvariants(input: FeeStructureInvariantInput): void {
  const items = input.lineItems ?? [];
  const labels = new Set<string>();

  for (const item of items) {
    if (labels.has(item.label)) {
      throw validationError(
        `lineItems: "${item.label}" appears more than once — each line item needs a distinct label`,
      );
    }
    labels.add(item.label);
  }
}

/**
 * The publish gate. Stricter than `assertFeeStructureInvariants`, which a
 * draft may still satisfy while incomplete.
 */
export function assertFeeStructurePublishable(input: FeeStructureInvariantInput): void {
  assertFeeStructureInvariants(input);

  if ((input.lineItems ?? []).length === 0) {
    throw validationError("lineItems: add at least one line item before publishing");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/unit/fee-structure-validation.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 499 pre-existing + 7 new = 506 passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/validation/fee-structure.ts tests/unit/fee-structure-validation.test.ts
git commit -m "feat: add fee structure validation"
```

---

### Task 3: `FeeStructureService` — CRUD

**Files:**
- Create: `src/services/fee-structure.service.ts`
- Test: `tests/integration/fee-structure-crud.test.ts`

**Interfaces:**
- Consumes: `FeeStructure`/`FeeStructureDoc` (Task 1); `createFeeStructureSchema`/`updateFeeStructureSchema`/`assertFeeStructureInvariants` (Task 2); `ActivityService.record` (existing, unchanged).
- Produces:
  - `type FeeStructureDTO = { id: string; classOrCourse: string; academicYear: string; lineItems?: {label,amount,frequency,optional}[]; status: string; publishedAt?: string; updatedAt?: string }`
  - `FeeStructureService.list(institutionId: string): Promise<FeeStructureDTO[]>`
  - `FeeStructureService.get(institutionId: string, feeStructureId: string): Promise<FeeStructureDTO>`
  - `FeeStructureService.create(institutionId: string, input: CreateFeeStructureInput, actor: {id,name}): Promise<FeeStructureDTO>`
  - `FeeStructureService.update(institutionId: string, feeStructureId: string, patch: UpdateFeeStructureInput, actor: {id,name}): Promise<FeeStructureDTO>`
  - `FeeStructureService.remove(institutionId: string, feeStructureId: string, actor: {id,name}): Promise<void>`

`ActivityService.record`'s `entityType` field is a plain `string` on the `Activity` model (no enum) — `"FEE_STRUCTURE"` is a valid new value, confirmed against `src/models/Activity.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/fee-structure-crud.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { FeeStructure } from "@/models";
import { FeeStructureService } from "@/services/fee-structure.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

const input = {
  classOrCourse: "Grade 10",
  academicYear: "2026-27",
  lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" as const }],
};

beforeAll(async () => {
  await startTestDatabase("fee-structure-crud");
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("FeeStructureService CRUD", () => {
  it("creates a fee structure and reads it back", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);

    expect(created.id).toBeDefined();
    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();

    const read = await FeeStructureService.get("INS0001", created.id);
    expect(read.academicYear).toBe("2026-27");
    expect(read.lineItems).toHaveLength(1);
  });

  it("refuses a duplicate (classOrCourse, academicYear) via the unique index, not a pre-read", async () => {
    await FeeStructureService.create("INS0001", input, actor);

    await expect(FeeStructureService.create("INS0001", input, actor)).rejects.toMatchObject({
      code: 11000,
    });
  });

  it("lets two institutions hold the same class/course and year independently", async () => {
    await FeeStructureService.create("INS0001", input, actor);
    await expect(FeeStructureService.create("INS0002", input, actor)).resolves.toBeDefined();
  });

  it("merges a partial patch without erasing untouched fields", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);

    const updated = await FeeStructureService.update(
      "INS0001",
      created.id,
      { academicYear: "2027-28" },
      actor,
    );

    expect(updated.academicYear).toBe("2027-28");
    expect(updated.lineItems).toHaveLength(1);
    expect(updated.lineItems?.[0]?.label).toBe("Tuition");
  });

  it("replaces lineItems wholesale rather than merging element by element", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);

    const updated = await FeeStructureService.update(
      "INS0001",
      created.id,
      { lineItems: [{ label: "Only", amount: 1000, frequency: "ONE_TIME" }] },
      actor,
    );

    expect(updated.lineItems).toHaveLength(1);
    expect(updated.lineItems?.[0]?.label).toBe("Only");
  });

  it("validates invariants against the merged record when lineItems are patched", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      {
        classOrCourse: "Grade 10",
        academicYear: "2026-27",
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      },
      actor,
    );

    await expect(
      FeeStructureService.update(
        "INS0001",
        created.id,
        {
          lineItems: [
            { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
            { label: "Tuition", amount: 1000, frequency: "ONE_TIME" },
          ],
        },
        actor,
      ),
    ).rejects.toThrow(/appears more than once/i);
  });

  it("returns NOT_FOUND, never FORBIDDEN, for another institution's fee structure", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);

    await expect(FeeStructureService.get("INS0002", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      FeeStructureService.update("INS0002", created.id, { academicYear: "2027-28" }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(FeeStructureService.remove("INS0002", created.id, actor)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lists only the calling institution's fee structures, newest academic year first", async () => {
    await FeeStructureService.create("INS0001", { ...input, academicYear: "2025-26" }, actor);
    await FeeStructureService.create("INS0001", { ...input, academicYear: "2026-27" }, actor);
    await FeeStructureService.create("INS0002", input, actor);

    const list = await FeeStructureService.list("INS0001");

    expect(list).toHaveLength(2);
    expect(list[0]?.academicYear).toBe("2026-27");
  });

  it("deletes a fee structure", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);
    await FeeStructureService.remove("INS0001", created.id, actor);

    await expect(FeeStructureService.get("INS0001", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects a malformed feeStructureId as NOT_FOUND rather than throwing a cast error", async () => {
    await expect(FeeStructureService.get("INS0001", "not-an-object-id")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/fee-structure-crud.test.ts
```

Expected: FAIL — cannot resolve `@/services/fee-structure.service`.

- [ ] **Step 3: Create `src/services/fee-structure.service.ts`**

```ts
import "server-only";
import { Types } from "mongoose";
import type { z } from "zod";
import { connectToDatabase } from "@/lib/db/mongoose";
import { FeeStructure, type FeeStructureDoc } from "@/models";
import { notFound } from "@/lib/api/errors";
import {
  assertFeeStructureInvariants,
  type createFeeStructureSchema,
  type updateFeeStructureSchema,
} from "@/lib/validation/fee-structure";
import { ActivityService } from "./activity.service";

type CreateInput = z.infer<typeof createFeeStructureSchema>;
type UpdateInput = z.infer<typeof updateFeeStructureSchema>;

export type FeeStructureDTO = {
  id: string;
  classOrCourse: string;
  academicYear: string;
  lineItems?: { label: string; amount: number; frequency: string; optional: boolean }[];
  status: string;
  publishedAt?: string;
  updatedAt?: string;
};

/** A malformed id must read as "no such fee structure", not as a 500. */
function toObjectId(feeStructureId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(feeStructureId)) throw notFound("Fee structure not found");
  return new Types.ObjectId(feeStructureId);
}

function serialize(row: FeeStructureDoc): FeeStructureDTO {
  return {
    id: String(row._id),
    classOrCourse: row.classOrCourse,
    academicYear: row.academicYear,
    lineItems: row.lineItems?.length
      ? row.lineItems.map((item) => ({
          label: item.label,
          amount: item.amount,
          frequency: item.frequency,
          optional: item.optional === true,
        }))
      : undefined,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString(),
    updatedAt: (row as FeeStructureDoc & { updatedAt?: Date }).updatedAt?.toISOString(),
  };
}

/** Every read is scoped by institutionId, so a foreign id is simply not found. */
async function findOwned(institutionId: string, feeStructureId: string): Promise<FeeStructureDoc> {
  const row = await FeeStructure.findOne({
    _id: toObjectId(feeStructureId),
    institutionId,
  }).lean<FeeStructureDoc>();
  if (!row) throw notFound("Fee structure not found");
  return row;
}

/**
 * A key absent from a patch arrives as `undefined` and must be left alone —
 * `$set: { classOrCourse: undefined }` would otherwise erase a stored value
 * the caller never mentioned.
 */
function stripUndefined<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export const FeeStructureService = {
  async list(institutionId: string): Promise<FeeStructureDTO[]> {
    await connectToDatabase();
    const rows = await FeeStructure.find({ institutionId })
      .sort({ academicYear: -1, classOrCourse: 1 })
      .lean<FeeStructureDoc[]>();
    return rows.map(serialize);
  },

  async get(institutionId: string, feeStructureId: string): Promise<FeeStructureDTO> {
    await connectToDatabase();
    return serialize(await findOwned(institutionId, feeStructureId));
  },

  async create(
    institutionId: string,
    input: CreateInput,
    actor: { id: string; name: string },
  ): Promise<FeeStructureDTO> {
    await connectToDatabase();

    assertFeeStructureInvariants({ lineItems: input.lineItems });

    // Duplicate (classOrCourse, academicYear) is refused by the unique index
    // rather than a pre-read: a read-then-write races two browser tabs and
    // creates both.
    const created = await FeeStructure.create({ ...input, institutionId, status: "DRAFT" });

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityId: created._id,
      entityRef: institutionId,
      action: "Fee structure created",
      description: `${input.classOrCourse} ${input.academicYear} created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(created.toObject() as FeeStructureDoc);
  },

  async update(
    institutionId: string,
    feeStructureId: string,
    patch: UpdateInput,
    actor: { id: string; name: string },
  ): Promise<FeeStructureDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, feeStructureId);

    const set = stripUndefined(patch);

    // Invariants hold against the MERGED record: a patch carrying only one
    // new line item must still be checked against the whole stored list.
    const merged = { ...before, ...set };
    assertFeeStructureInvariants({ lineItems: merged.lineItems });

    const updated = await FeeStructure.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<FeeStructureDoc>();
    if (!updated) throw notFound("Fee structure not found");

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Fee structure updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },

  async remove(
    institutionId: string,
    feeStructureId: string,
    actor: { id: string; name: string },
  ): Promise<void> {
    await connectToDatabase();
    const before = await findOwned(institutionId, feeStructureId);

    await FeeStructure.deleteOne({ _id: before._id, institutionId });

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityId: before._id,
      entityRef: institutionId,
      action: "Fee structure deleted",
      description: `${before.classOrCourse} ${before.academicYear} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/integration/fee-structure-crud.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Mutation-check the invariant guard**

| Mutation | Test that must fail |
|---|---|
| Comment out `assertFeeStructureInvariants` inside `create()` | none directly — this call has no test forcing `create()` itself to reject a duplicate label; skip this row and instead mutate `update()`'s call (below), which is what the test suite actually exercises |
| Comment out `assertFeeStructureInvariants(merged...)` inside `update()` | `validates invariants against the merged record when lineItems are patched` |
| Remove `institutionId` from `findOwned`'s filter | `returns NOT_FOUND, never FORBIDDEN, for another institution's fee structure` |

- [ ] **Step 6: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 506 pre-existing + 10 new = 516 passing.

- [ ] **Step 7: Commit**

```bash
git add src/services/fee-structure.service.ts tests/integration/fee-structure-crud.test.ts
git commit -m "feat: add FeeStructureService CRUD methods"
```

---

### Task 4: `FeeStructureService` — publish lifecycle

**Files:**
- Modify: `src/services/fee-structure.service.ts`
- Test: `tests/integration/fee-structure-publish.test.ts`

**Interfaces:**
- Consumes: `assertFeeStructurePublishable` (Task 2); `findOwned`/`serialize` (private to the service file, already defined in Task 3).
- Produces: `FeeStructureService.setStatus(institutionId: string, feeStructureId: string, action: "publish" | "unpublish" | "archive", actor: {id,name}): Promise<FeeStructureDTO>`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/fee-structure-publish.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { FeeStructure } from "@/models";
import { FeeStructureService } from "@/services/fee-structure.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(async () => {
  await startTestDatabase("fee-structure-publish");
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});

describe("FeeStructureService.setStatus", () => {
  it("refuses to publish with zero line items", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      { classOrCourse: "Grade 10", academicYear: "2026-27" },
      actor,
    );

    await expect(
      FeeStructureService.setStatus("INS0001", created.id, "publish", actor),
    ).rejects.toThrow(/at least one line item/i);
  });

  it("publishes and stamps publishedAt", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      {
        classOrCourse: "Grade 10",
        academicYear: "2026-27",
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      },
      actor,
    );

    const published = await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).toBeDefined();
  });

  it("does not move publishedAt on a later publish", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      {
        classOrCourse: "Grade 10",
        academicYear: "2026-27",
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      },
      actor,
    );

    const first = await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);
    await FeeStructureService.setStatus("INS0001", created.id, "unpublish", actor);
    const second = await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    expect(second.publishedAt).toBe(first.publishedAt);
  });

  it("unpublish preserves the line items", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      {
        classOrCourse: "Grade 10",
        academicYear: "2026-27",
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    const unpublished = await FeeStructureService.setStatus(
      "INS0001",
      created.id,
      "unpublish",
      actor,
    );

    expect(unpublished.status).toBe("DRAFT");
    expect(unpublished.lineItems).toHaveLength(1);
  });

  it("archives a published structure", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      {
        classOrCourse: "Grade 10",
        academicYear: "2026-27",
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    const archived = await FeeStructureService.setStatus("INS0001", created.id, "archive", actor);

    expect(archived.status).toBe("ARCHIVED");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/fee-structure-publish.test.ts
```

Expected: FAIL — `FeeStructureService.setStatus` is not a function.

- [ ] **Step 3: Modify `src/services/fee-structure.service.ts`**

Change the import line from Task 3:

```ts
import {
  assertFeeStructureInvariants,
  type createFeeStructureSchema,
  type updateFeeStructureSchema,
} from "@/lib/validation/fee-structure";
```

to:

```ts
import {
  assertFeeStructureInvariants,
  assertFeeStructurePublishable,
  type createFeeStructureSchema,
  type updateFeeStructureSchema,
} from "@/lib/validation/fee-structure";
```

Add this constant right above `export const FeeStructureService = {`:

```ts
/** `"archive" + "ed"` reads as "archiveed" — spelled out instead of concatenated. */
const ACTION_LABELS: Record<"publish" | "unpublish" | "archive", string> = {
  publish: "published",
  unpublish: "unpublished",
  archive: "archived",
};
```

Add this method inside `FeeStructureService`, after `update` and before `remove`:

```ts
  async setStatus(
    institutionId: string,
    feeStructureId: string,
    action: "publish" | "unpublish" | "archive",
    actor: { id: string; name: string },
  ): Promise<FeeStructureDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, feeStructureId);

    const status = action === "publish" ? "PUBLISHED" : action === "archive" ? "ARCHIVED" : "DRAFT";

    if (action === "publish") {
      assertFeeStructurePublishable({ lineItems: before.lineItems });
    }

    const set: Record<string, unknown> = { status };
    // Stamped on first publication and never moved: it records when this
    // structure was first made public, not when it was last touched.
    if (action === "publish" && !before.publishedAt) set.publishedAt = new Date();

    const updated = await FeeStructure.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<FeeStructureDoc>();
    if (!updated) throw notFound("Fee structure not found");

    await ActivityService.record({
      institutionId,
      entityType: "FEE_STRUCTURE",
      entityId: updated._id,
      entityRef: institutionId,
      action: `Fee structure ${ACTION_LABELS[action]}`,
      description: `${updated.classOrCourse} ${updated.academicYear}`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/integration/fee-structure-publish.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-check the publish gate**

| Mutation | Test that must fail |
|---|---|
| Remove the `if (action === "publish") assertFeeStructurePublishable(...)` block | `refuses to publish with zero line items` |
| Remove the `if (action === "publish" && !before.publishedAt) set.publishedAt = ...` guard (always stamp) | `does not move publishedAt on a later publish` |

- [ ] **Step 6: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 516 pre-existing + 5 new = 521 passing.

- [ ] **Step 7: Commit**

```bash
git add src/services/fee-structure.service.ts tests/integration/fee-structure-publish.test.ts
git commit -m "feat: add FeeStructureService publish lifecycle"
```

---

### Task 5: Admin API routes

**Files:**
- Create: `src/app/api/settings/fees/route.ts`
- Create: `src/app/api/settings/fees/[feeId]/route.ts`
- Create: `src/app/api/settings/fees/[feeId]/publish/route.ts`
- Test: `tests/integration/fee-structure-routes.test.ts`

**Interfaces:**
- Consumes: `FeeStructureService` (Tasks 3–4); `createFeeStructureSchema`/`updateFeeStructureSchema` (Task 2); `requireInstitution` (existing, unchanged); `assertSameOrigin` (existing).
- Produces: `GET/POST /api/settings/fees`, `GET/PATCH/DELETE /api/settings/fees/:feeId`, `POST /api/settings/fees/:feeId/publish`.

This task adds **no new permission or role check**. Every handler uses `requireInstitution()` directly — the same guard `/api/settings/results` uses — which already throws `FORBIDDEN` for any role other than `INSTITUTION_ADMIN`. Counselor and Front Desk are refused by that existing guard, not by anything this task writes.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/fee-structure-routes.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { GET as listFees, POST as createFee } from "@/app/api/settings/fees/route";
import {
  DELETE as deleteFee,
  GET as getFee,
  PATCH as patchFee,
} from "@/app/api/settings/fees/[feeId]/route";
import { POST as publishFee } from "@/app/api/settings/fees/[feeId]/publish/route";
import { FeeStructureService } from "@/services/fee-structure.service";
import type { NextRequest } from "next/server";

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/fees");
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  headers.set("host", "localhost");
  return {
    headers,
    nextUrl: url,
    url: url.toString(),
    json: async () => init.body ?? {},
  } as unknown as NextRequest;
}

async function signIn(
  institutionId: string,
  role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK",
  email: string,
) {
  const user = await makeUser(institutionId, role, email);
  const token = await signSession({
    sub: String(user._id),
    role,
    institutionId,
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
  return user;
}

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };
const input = {
  classOrCourse: "Grade 10",
  academicYear: "2026-27",
  lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" as const }],
};

beforeAll(() => startTestDatabase("fee-structure-routes"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("fee structure routes — admin CRUD over real HTTP", () => {
  it("an admin can create a fee structure — 201", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createFee(cookieRequest({ body: input, origin: "http://localhost" }));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.feeStructure.classOrCourse).toBe("Grade 10");
  });

  it("an admin can list, read, update, and delete their own fee structure", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    const created = await FeeStructureService.create("INS0001", input, actor);

    const listResponse = await listFees();
    expect((await listResponse.json()).feeStructures).toHaveLength(1);

    const getResponse = await getFee(
      cookieRequest({ url: `http://localhost/api/settings/fees/${created.id}` }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(getResponse.status).toBe(200);

    const patchResponse = await patchFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}`,
        body: { academicYear: "2027-28" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(patchResponse.status).toBe(200);
    expect((await patchResponse.json()).feeStructure.academicYear).toBe("2027-28");

    const deleteResponse = await deleteFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(deleteResponse.status).toBe(200);
  });

  it("an admin can publish a fee structure", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    const created = await FeeStructureService.create("INS0001", input, actor);

    const publishResponse = await publishFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}/publish`,
        body: { action: "publish" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(publishResponse.status).toBe(200);
    expect((await publishResponse.json()).feeStructure.status).toBe("PUBLISHED");
  });

  it("a fee structure from another institution 404s on GET, PATCH and DELETE — never 403", async () => {
    await signIn("INS0002", "INSTITUTION_ADMIN", "admin@intelligentpublic.edu.in");
    const created = await FeeStructureService.create("INS0001", input, actor);

    const getResponse = await getFee(
      cookieRequest({ url: `http://localhost/api/settings/fees/${created.id}` }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(getResponse.status).toBe(404);

    const patchResponse = await patchFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}`,
        body: { academicYear: "2027-28" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(patchResponse.status).toBe(404);

    const deleteResponse = await deleteFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(deleteResponse.status).toBe(404);
  });
});

describe("fee structure routes — Counselor and Front Desk are refused on every route", () => {
  it("a Counselor session gets 403 listing fee structures", async () => {
    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const response = await listFees();
    expect(response.status).toBe(403);
  });

  it("a Counselor session gets 403 creating a fee structure", async () => {
    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const response = await createFee(cookieRequest({ body: input, origin: "http://localhost" }));
    expect(response.status).toBe(403);
  });

  it("a Front Desk session gets 403 reading a fee structure", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await getFee(
      cookieRequest({ url: `http://localhost/api/settings/fees/${created.id}` }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk session gets 403 updating a fee structure", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await patchFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}`,
        body: { academicYear: "2027-28" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(response.status).toBe(403);
  });

  it("a Counselor session gets 403 deleting a fee structure", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);
    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");

    const response = await deleteFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk session gets 403 publishing a fee structure", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await publishFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}/publish`,
        body: { action: "publish" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/fee-structure-routes.test.ts
```

Expected: FAIL — cannot resolve the route modules.

- [ ] **Step 3: Create `src/app/api/settings/fees/route.ts`**

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { createFeeStructureSchema } from "@/lib/validation/fee-structure";
import { FeeStructureService } from "@/services/fee-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const feeStructures = await FeeStructureService.list(institution.institutionId);
    return jsonSuccess({ feeStructures });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = createFeeStructureSchema.parse(await request.json().catch(() => ({})));

    const feeStructure = await FeeStructureService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ feeStructure }, { status: 201 });
  } catch (error) {
    // A duplicate (classOrCourse, academicYear) arrives here as a Mongo
    // 11000, which handleApiError already maps to CONFLICT.
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: Create `src/app/api/settings/fees/[feeId]/route.ts`**

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateFeeStructureSchema } from "@/lib/validation/fee-structure";
import { FeeStructureService } from "@/services/fee-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/settings/fees/[feeId]">,
) {
  try {
    const { feeId } = await context.params;
    const { institution } = await requireInstitution();
    const feeStructure = await FeeStructureService.get(institution.institutionId, feeId);
    return jsonSuccess({ feeStructure });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/fees/[feeId]">,
) {
  try {
    assertSameOrigin(request);
    const { feeId } = await context.params;
    const { user, institution } = await requireInstitution();
    const patch = updateFeeStructureSchema.parse(await request.json().catch(() => ({})));

    const feeStructure = await FeeStructureService.update(
      institution.institutionId,
      feeId,
      patch,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ feeStructure });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/fees/[feeId]">,
) {
  try {
    assertSameOrigin(request);
    const { feeId } = await context.params;
    const { user, institution } = await requireInstitution();

    await FeeStructureService.remove(institution.institutionId, feeId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: Create `src/app/api/settings/fees/[feeId]/publish/route.ts`**

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { FeeStructureService } from "@/services/fee-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const ACTIONS = ["publish", "unpublish", "archive"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/settings/fees/[feeId]/publish">,
) {
  try {
    assertSameOrigin(request);
    const { feeId } = await context.params;
    const { user, institution } = await requireInstitution();

    const body = (await request.json().catch(() => ({}))) as { action?: string };
    if (!ACTIONS.includes(body.action as Action)) {
      throw validationError(`action: must be one of ${ACTIONS.join(", ")}`);
    }

    const feeStructure = await FeeStructureService.setStatus(
      institution.institutionId,
      feeId,
      body.action as Action,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ feeStructure });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run tests/integration/fee-structure-routes.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 7: Mutation-check the tenant and role boundaries**

| Mutation | Test that must fail |
|---|---|
| Change `assertSameOrigin(request)` calls to no-ops without also removing `requireInstitution()`'s role check — instead, temporarily change `requireInstitution()`'s own role comparison in `src/lib/tenant/index.ts` from `role !== "INSTITUTION_ADMIN"` to `false` (never throws) | every test in the "Counselor and Front Desk are refused" describe block |
| Restore that line. Then remove `institutionId` from `findOwned`'s filter in the service (already covered by Task 3's mutation check — re-run `fee-structure-crud.test.ts`, not this file, to re-confirm) | `returns NOT_FOUND, never FORBIDDEN, for another institution's fee structure` (Task 3's test) |

Restore both mutations before continuing.

- [ ] **Step 8: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 521 pre-existing + 10 new = 531 passing.

- [ ] **Step 9: Commit**

```bash
git add src/app/api/settings/fees tests/integration/fee-structure-routes.test.ts
git commit -m "feat: add admin API routes for fee structures"
```

---

### Task 6: Public projection

**Files:**
- Create: `src/lib/fee-structure/public-projection.ts`
- Test: `tests/unit/fee-structure-projection.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure function over a plain object).
- Produces: `toPublicFeeStructure(feeStructure: Record<string, unknown>): PublicFeeStructure | null`, `type PublicFeeStructure`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fee-structure-projection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toPublicFeeStructure } from "@/lib/fee-structure/public-projection";

const published = {
  _id: "aaa",
  institutionId: "INS0001",
  classOrCourse: "Grade 10",
  academicYear: "2026-27",
  lineItems: [
    { label: "Tuition", amount: 60000, frequency: "ANNUAL", optional: false },
    { label: "Transport", amount: 12000, frequency: "ANNUAL", optional: true },
  ],
  status: "PUBLISHED",
  publishedAt: new Date("2026-05-10T00:00:00.000Z"),
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-10T00:00:00.000Z"),
};

describe("toPublicFeeStructure", () => {
  it("emits exactly the allowed top-level keys and no others", () => {
    const result = toPublicFeeStructure(published);

    expect(Object.keys(result ?? {}).sort()).toEqual(
      ["academicYear", "classOrCourse", "lineItems", "publishedAt"].sort(),
    );
  });

  it("never emits internal fields", () => {
    const result = toPublicFeeStructure(published) as Record<string, unknown>;

    expect(result).not.toHaveProperty("_id");
    expect(result).not.toHaveProperty("institutionId");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("returns null for a draft fee structure", () => {
    expect(toPublicFeeStructure({ ...published, status: "DRAFT" })).toBeNull();
  });

  it("returns null for an archived fee structure", () => {
    expect(toPublicFeeStructure({ ...published, status: "ARCHIVED" })).toBeNull();
  });

  it("emits each line item's optional flag", () => {
    const result = toPublicFeeStructure(published);

    expect(result?.lineItems).toHaveLength(2);
    expect(result?.lineItems?.[1]?.optional).toBe(true);
  });

  it("drops lineItems entirely rather than emitting an empty array", () => {
    const result = toPublicFeeStructure({ ...published, lineItems: [] });
    expect(result?.lineItems).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/fee-structure-projection.test.ts
```

Expected: FAIL — cannot resolve `@/lib/fee-structure/public-projection`.

- [ ] **Step 3: Create `src/lib/fee-structure/public-projection.ts`**

```ts
/**
 * The only path from a FeeStructure document to a public response.
 *
 * This is an allow-list: it names the fields that may leave. A field added to
 * the schema is private until someone deliberately adds it here. Rewriting
 * this as a spread with deletions would leak every future field on the day it
 * was added — a test exists specifically to catch that.
 *
 * The one rule that lives here and nowhere else: only a PUBLISHED fee
 * structure is ever projected. Callers already filter, but this is defence
 * in depth on the module's highest-risk boundary.
 */
type Doc = Record<string, unknown>;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const bool = (value: unknown): boolean => value === true;

const rows = (value: unknown): Doc[] => (Array.isArray(value) ? (value as Doc[]) : []);

/** Drops an array entirely when it has no members, so `[]` never reaches a consumer. */
const listOrUndefined = <T>(values: T[]): T[] | undefined =>
  values.length > 0 ? values : undefined;

export type PublicFeeStructure = NonNullable<ReturnType<typeof toPublicFeeStructure>>;

export function toPublicFeeStructure(feeStructure: Doc) {
  const doc = feeStructure ?? {};

  if (doc.status !== "PUBLISHED") return null;

  const lineItems = rows(doc.lineItems).map((item) => ({
    label: text(item.label),
    amount: num(item.amount),
    frequency: text(item.frequency),
    optional: bool(item.optional),
  }));

  const publishedAt = doc.publishedAt;

  return {
    classOrCourse: text(doc.classOrCourse),
    academicYear: text(doc.academicYear),
    lineItems: listOrUndefined(lineItems),
    publishedAt: publishedAt instanceof Date ? publishedAt.toISOString() : text(publishedAt),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/unit/fee-structure-projection.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 531 pre-existing + 6 new = 537 passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fee-structure/public-projection.ts tests/unit/fee-structure-projection.test.ts
git commit -m "feat: add the fee structure public projection"
```

---

### Task 7: `listPublic` and the public API routes

**Files:**
- Modify: `src/services/fee-structure.service.ts`
- Create: `src/app/api/public/[institutionId]/fees/route.ts`
- Create: `src/app/api/public/institutions/[slug]/fees/route.ts`
- Test: `tests/integration/fee-structure-public.test.ts`

**Interfaces:**
- Consumes: `toPublicFeeStructure`/`PublicFeeStructure` (Task 6); `feeStructureQuerySchema` (Task 2); `Institution` model (existing); `PUBLIC_READ_RATE_LIMIT`, `consumeRateLimit`, `getClientIp`, `publicCorsPreflight` (all existing, unchanged — the exact same shared utilities `/api/public/[institutionId]/results` already uses).
- Produces:
  - `FeeStructureService.listPublic(query: {institutionId?, slug?, academicYear?}): Promise<PublicFeeStructure[] | null>`
  - `GET /api/public/:institutionId/fees`
  - `GET /api/public/institutions/:slug/fees`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/fee-structure-public.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeProfiledInstitution } from "../helpers/factories";
import { GET as getByInstitutionId } from "@/app/api/public/[institutionId]/fees/route";
import { GET as getBySlug } from "@/app/api/public/institutions/[slug]/fees/route";
import { FeeStructureService } from "@/services/fee-structure.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };
const lineItems = [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" as const }];

beforeAll(() => startTestDatabase("fee-structure-public"));
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("GET /api/public/:institutionId/fees", () => {
  it("returns a published fee structure by institutionId", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    const created = await FeeStructureService.create(
      "INS0001",
      { classOrCourse: "Grade 10", academicYear: "2026-27", lineItems },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.feeStructures).toHaveLength(1);
    expect(payload.feeStructures[0].classOrCourse).toBe("Grade 10");
  });

  it("returns a published fee structure by slug", async () => {
    await makeProfiledInstitution("INS0001", {
      profileStatus: "PUBLISHED",
      slug: "infinity-school",
    });
    const created = await FeeStructureService.create(
      "INS0001",
      { classOrCourse: "Grade 10", academicYear: "2026-27", lineItems },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getBySlug(
      new Request("http://localhost/api/public/institutions/infinity-school/fees"),
      { params: Promise.resolve({ slug: "infinity-school" }) } as never,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).feeStructures).toHaveLength(1);
  });

  it("returns an empty list, not a 404, when the institution has no published fee structures", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).feeStructures).toEqual([]);
  });

  it("excludes a draft fee structure", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    await FeeStructureService.create(
      "INS0001",
      { classOrCourse: "Grade 10", academicYear: "2026-27" },
      actor,
    );

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect((await response.json()).feeStructures).toEqual([]);
  });

  it("excludes an archived fee structure", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    const created = await FeeStructureService.create(
      "INS0001",
      { classOrCourse: "Grade 10", academicYear: "2026-27", lineItems },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);
    await FeeStructureService.setStatus("INS0001", created.id, "archive", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect((await response.json()).feeStructures).toEqual([]);
  });

  it("404s for a suspended institution even with a published fee structure", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED", active: false });
    const created = await FeeStructureService.create(
      "INS0001",
      { classOrCourse: "Grade 10", academicYear: "2026-27", lineItems },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("404s for a nonexistent institution", async () => {
    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS9999/fees"),
      { params: Promise.resolve({ institutionId: "INS9999" }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("filters by academicYear", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    const older = await FeeStructureService.create(
      "INS0001",
      { classOrCourse: "Grade 10", academicYear: "2025-26", lineItems },
      actor,
    );
    const newer = await FeeStructureService.create(
      "INS0001",
      { classOrCourse: "Grade 10", academicYear: "2026-27", lineItems },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", older.id, "publish", actor);
    await FeeStructureService.setStatus("INS0001", newer.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees?academicYear=2025-26"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    const payload = await response.json();
    expect(payload.feeStructures).toHaveLength(1);
    expect(payload.feeStructures[0].academicYear).toBe("2025-26");
  });

  it("sets a 5-minute Cache-Control header", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/fees"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("trips the shared public-read rate limit after 60 requests from one caller", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });

    let last;
    for (let i = 0; i < 61; i += 1) {
      last = await getByInstitutionId(new Request("http://localhost/api/public/INS0001/fees"), {
        params: Promise.resolve({ institutionId: "INS0001" }),
      } as never);
    }

    expect(last!.status).toBe(429);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/fee-structure-public.test.ts
```

Expected: FAIL — cannot resolve the public route modules, and `FeeStructureService.listPublic` is not a function.

- [ ] **Step 3: Modify `src/services/fee-structure.service.ts`**

Change the import line:

```ts
import { FeeStructure, type FeeStructureDoc } from "@/models";
```

to:

```ts
import { FeeStructure, Institution, type FeeStructureDoc } from "@/models";
```

Add this import alongside the validation import:

```ts
import { toPublicFeeStructure, type PublicFeeStructure } from "@/lib/fee-structure/public-projection";
```

Add this method inside `FeeStructureService`, after `list` and before `get`:

```ts
  /**
   * Returns null when the institution is not publicly visible at all — the
   * caller turns that into a 404. An empty array means "visible, but nothing
   * published", a 200. The visibility gate matches the profile and results
   * endpoints' exactly, so a fee structure can never be reachable on an
   * institution whose profile 404s.
   */
  async listPublic(query: {
    institutionId?: string;
    slug?: string;
    academicYear?: string;
  }): Promise<PublicFeeStructure[] | null> {
    await connectToDatabase();

    const key = query.institutionId
      ? { institutionId: query.institutionId.toUpperCase() }
      : { slug: (query.slug ?? "").toLowerCase() };

    const institution = await Institution.findOne({
      ...key,
      active: true,
      profileStatus: "PUBLISHED",
    })
      .select("institutionId")
      .lean();
    if (!institution) return null;

    const filter: Record<string, unknown> = {
      institutionId: institution.institutionId,
      status: "PUBLISHED",
    };
    if (query.academicYear) filter.academicYear = query.academicYear;

    const rows = await FeeStructure.find(filter)
      .sort({ academicYear: -1, classOrCourse: 1 })
      .lean<FeeStructureDoc[]>();

    // The projection is the allow-list; it also re-checks PUBLISHED, so a
    // filter mistake here cannot leak an unpublished record.
    return rows
      .map((row) => toPublicFeeStructure(row as unknown as Record<string, unknown>))
      .filter((row): row is PublicFeeStructure => row !== null);
  },
```

- [ ] **Step 4: Create `src/app/api/public/[institutionId]/fees/route.ts`**

```ts
import { FeeStructureService } from "@/services/fee-structure.service";
import { feeStructureQuerySchema } from "@/lib/validation/fee-structure";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "public, max-age=300" };

/**
 * Credential-free. A draft fee structure, an archived one, a suspended
 * institution and a nonexistent institution are indistinguishable here:
 * there is no 403 branch to write, because none exists.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/public/[institutionId]/fees">,
) {
  try {
    const { institutionId } = await context.params;

    // Keyed on IP only — never on institutionId, so one institution's traffic
    // cannot exhaust another's allowance.
    const limit = await consumeRateLimit(
      `public-fees:${getClientIp(request)}`,
      PUBLIC_READ_RATE_LIMIT.limit,
      PUBLIC_READ_RATE_LIMIT.windowSeconds,
    );
    if (!limit.allowed) {
      return jsonError("RATE_LIMITED", "Too many requests. Please try again in a minute.", {
        headers: {
          ...rateLimitHeaders(limit),
          "Retry-After": String(limit.retryAfterSeconds),
          "Cache-Control": "no-store",
        },
      });
    }

    const url = new URL(request.url);
    const query = feeStructureQuerySchema.parse({
      academicYear: url.searchParams.get("academicYear") ?? undefined,
    });

    const feeStructures = await FeeStructureService.listPublic({ institutionId, ...query });
    if (feeStructures === null) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: HEADERS });
    }

    return jsonSuccess({ feeStructures }, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, HEADERS);
  }
}

export async function OPTIONS() {
  return publicCorsPreflight();
}
```

- [ ] **Step 5: Create `src/app/api/public/institutions/[slug]/fees/route.ts`**

```ts
import { FeeStructureService } from "@/services/fee-structure.service";
import { feeStructureQuerySchema } from "@/lib/validation/fee-structure";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "public, max-age=300" };

export async function GET(
  request: Request,
  context: RouteContext<"/api/public/institutions/[slug]/fees">,
) {
  try {
    const { slug } = await context.params;

    const limit = await consumeRateLimit(
      `public-fees:${getClientIp(request)}`,
      PUBLIC_READ_RATE_LIMIT.limit,
      PUBLIC_READ_RATE_LIMIT.windowSeconds,
    );
    if (!limit.allowed) {
      return jsonError("RATE_LIMITED", "Too many requests. Please try again in a minute.", {
        headers: {
          ...rateLimitHeaders(limit),
          "Retry-After": String(limit.retryAfterSeconds),
          "Cache-Control": "no-store",
        },
      });
    }

    const url = new URL(request.url);
    const query = feeStructureQuerySchema.parse({
      academicYear: url.searchParams.get("academicYear") ?? undefined,
    });

    const feeStructures = await FeeStructureService.listPublic({ slug, ...query });
    if (feeStructures === null) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: HEADERS });
    }

    return jsonSuccess({ feeStructures }, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, HEADERS);
  }
}

export async function OPTIONS() {
  return publicCorsPreflight();
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run tests/integration/fee-structure-public.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 7: Mutation-check the visibility gate**

| Mutation | Test that must fail |
|---|---|
| Remove `active: true, profileStatus: "PUBLISHED"` from `listPublic`'s `Institution.findOne` filter | `404s for a suspended institution even with a published fee structure` |
| Remove `status: "PUBLISHED"` from `listPublic`'s `FeeStructure.find` filter | `excludes a draft fee structure` |

- [ ] **Step 8: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 537 pre-existing + 10 new = 547 passing.

- [ ] **Step 9: Commit**

```bash
git add src/services/fee-structure.service.ts src/app/api/public/[institutionId]/fees src/app/api/public/institutions/[slug]/fees tests/integration/fee-structure-public.test.ts
git commit -m "feat: add the public fee structure API"
```

---

### Task 8: OpenAPI documentation

**Files:**
- Modify: `src/lib/api/openapi.ts`
- Test: `tests/unit/openapi-fee-structure.test.ts`

**Interfaces:**
- Consumes: nothing new — the same `buildOpenApiDocument(options)` function, `publicBase`/`slugPath`/`scoped` locals already computed at the top of that function, and the same `errorResponses()` helper the Results paths already use.
- Produces: two new path entries and two new schemas (`PublicFeeStructuresResponse`, `PublicFeeStructure`) in the generated OpenAPI document.

- [ ] **Step 1: Read the surrounding code first**

Open `src/lib/api/openapi.ts` and find the `[${publicBase}/results]` and `[${slugPath}/results]` path entries (there are two — one under the `publicBase` key, one under `slugPath`). This task inserts two near-identical blocks for `fees` immediately after each, inside the same `buildOpenApiDocument` function. Confirm the exact surrounding brace structure before editing — the file is one large object literal, and misplacing a brace produces a syntax error that `tsc` alone will report clearly.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/openapi-fee-structure.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";

const doc = buildOpenApiDocument({ origin: "https://admissions.test" }) as {
  paths: Record<string, Record<string, { tags?: string[]; security?: unknown[] }>>;
  components: { schemas: Record<string, unknown> };
};

describe("OpenAPI — fee structures", () => {
  it("documents the public fees path by institution id", () => {
    expect(doc.paths["/api/public/{institutionId}/fees"]?.get).toBeDefined();
  });

  it("documents the public fees path by slug", () => {
    expect(doc.paths["/api/public/institutions/{slug}/fees"]?.get).toBeDefined();
  });

  it("tags both as Website and declares them credential-free", () => {
    for (const path of [
      "/api/public/{institutionId}/fees",
      "/api/public/institutions/{slug}/fees",
    ]) {
      const operation = doc.paths[path]?.get;
      expect(operation?.tags).toContain("Website");
      expect(operation?.security).toEqual([]);
    }
  });

  it("defines the response schema", () => {
    expect(doc.components.schemas.PublicFeeStructuresResponse).toBeDefined();
  });

  it("never documents an institute-admin fees route in the public spec", () => {
    const adminPaths = Object.keys(doc.paths).filter((path) => path.startsWith("/api/settings/fees"));
    expect(adminPaths).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run tests/unit/openapi-fee-structure.test.ts
```

Expected: FAIL — the new paths and schema don't exist yet.

- [ ] **Step 4: Add the two path entries**

Immediately after the closing brace of the existing `[${publicBase}/results]` entry, add:

```ts
      [`${publicBase}/fees`]: {
      ...(scoped
        ? {}
        : {
            parameters: [
              {
                name: "institutionId",
                in: "path",
                required: true,
                description: "The institution whose public fee structures to read, e.g. `INS0001`.",
                schema: { type: "string", example: PLACEHOLDER_ID },
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "List the institution's published fee structures",
          description:
            "Published fee structures — itemized line items per class or course, per academic year — newest academic year first. Cached for five minutes.",
          operationId: "listPublicFeeStructuresById",
          security: [],
          parameters: [
            { name: "academicYear", in: "query", required: false, schema: { type: "string" }, example: "2026-27" },
          ],
          responses: {
            "200": {
              description: "Published fee structures for this institution",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicFeeStructuresResponse" },
                },
              },
            },
            ...errorResponses(["VALIDATION_ERROR", "NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"]),
          },
        },
      },
```

Check the exact object/property this file uses for the institution-id path parameter's example value (`PLACEHOLDER_ID` was used above as a guess matching the neighboring `/profile` entry's shape — confirm this constant actually exists in this file before using it; if the results entry above uses a literal string like `"INS0001"` instead, match that exactly rather than introducing a new constant reference).

Immediately after the closing brace of the existing `[${slugPath}/results]` entry, add:

```ts
      [`${slugPath}/fees`]: {
      ...(options.slug
        ? {}
        : {
            parameters: [
              {
                name: "slug",
                in: "path",
                required: true,
                description: "The institution's public slug, from its profile URL.",
                schema: { type: "string", example: "infinity-school-mysore" },
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "List the institution's published fee structures, by slug",
          description:
            "Published fee structures — itemized line items per class or course, per academic year — newest academic year first. Cached for five minutes.",
          operationId: "listPublicFeeStructuresBySlug",
          security: [],
          parameters: [
            { name: "academicYear", in: "query", required: false, schema: { type: "string" }, example: "2026-27" },
          ],
          responses: {
            "200": {
              description: "Published fee structures for this institution",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicFeeStructuresResponse" },
                },
              },
            },
            ...errorResponses(["VALIDATION_ERROR", "NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"]),
          },
        },
      },
```

- [ ] **Step 5: Add the two schemas**

Immediately after the closing brace of the existing `PublicResult` schema (inside the same `schemas: { ... }` object the `PublicResultsResponse`/`PublicResult` entries live in), add:

```ts
        PublicFeeStructuresResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            feeStructures: {
              type: "array",
              items: { $ref: "#/components/schemas/PublicFeeStructure" },
            },
          },
        },

        PublicFeeStructure: {
          type: "object",
          properties: {
            classOrCourse: { type: "string", example: "Grade 10" },
            academicYear: { type: "string", example: "2026-27" },
            lineItems: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", example: "Tuition" },
                  amount: { type: "number", example: 60000 },
                  frequency: { type: "string", enum: ["ONE_TIME", "ANNUAL"], example: "ANNUAL" },
                  optional: { type: "boolean", example: false },
                },
              },
            },
            publishedAt: { type: "string", format: "date-time" },
          },
        },
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run tests/unit/openapi-fee-structure.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 7: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 547 pre-existing + 5 new = 552 passing.

- [ ] **Step 8: Commit**

```bash
git add src/lib/api/openapi.ts tests/unit/openapi-fee-structure.test.ts
git commit -m "docs: add fee structure OpenAPI paths and schemas"
```

---

### Task 9: Dashboard — navigation and the fee structures list

**Files:**
- Modify: `src/components/dashboard/nav-config.ts`
- Create: `src/components/fees/fee-structure-status-badge.tsx`
- Create: `src/components/fees/fee-structures-list-view.tsx`
- Create: `src/app/(dashboard)/fees/page.tsx`

**Interfaces:**
- Consumes: `FeeStructureService.list` (Task 3); `FEE_STRUCTURE_STATUS_LABELS`/`type FeeStructureStatus` (Task 1); `FeeStructureDTO` (Task 3); `getCurrentUser`/`getCurrentInstitution` (existing, unchanged).
- Produces: the `/fees` page and the `FeeStructuresListView`/`FeeStructureStatusBadge` components later tasks reuse.

No test file — matching this codebase's established "no component harness" pattern for pure UI (every prior phase's dashboard tasks: Results, Staff, Lead Follow-up's UI tasks). Verified manually per Step 5.

- [ ] **Step 1: Add the nav entry**

In `src/components/dashboard/nav-config.ts`, add `Receipt` to the `lucide-react` import (check the existing import block's exact current contents before editing — it was last touched by Lead Follow-up's Task 13 and may have drifted since):

```ts
import {
  Building2,
  FileText,
  GraduationCap,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Plug,
  Receipt,
  Settings,
  Users,
} from "lucide-react";
```

In `INSTITUTION_NAV`'s second group (the one containing Staff, Institution Profile, Integration, Settings), add one entry after `Settings`:

```ts
      { href: "/settings", label: "Settings", icon: Settings, adminOnly: true },
      { href: "/fees", label: "Fees", icon: Receipt, adminOnly: true },
```

`adminOnly: true` matches Results' exact nav entry. Counselor and Front Desk have no authenticated dashboard route for fee structures (§7 of the spec grants them only the anonymous public endpoint) — there is no `/fees` page for either role to usefully land on, so hiding the nav item for them is correct, not a workaround.

- [ ] **Step 2: Create `src/components/fees/fee-structure-status-badge.tsx`**

```tsx
import { cn } from "@/lib/utils";
import { FEE_STRUCTURE_STATUS_LABELS, type FeeStructureStatus } from "@/lib/constants";

/**
 * The same fill-weight tone vocabulary as `result-status-badge.tsx`:
 * DRAFT hasn't been shown to anyone yet, PUBLISHED is the terminal, positive
 * state the public API reads from, ARCHIVED is withdrawn.
 */
const TONE: Record<FeeStructureStatus, string> = {
  DRAFT: "border-foreground/25 bg-background text-foreground",
  PUBLISHED: "border-transparent bg-foreground text-background",
  ARCHIVED: "border-dashed border-border bg-background text-muted-foreground",
};

export function FeeStructureStatusBadge({ status }: { status: FeeStructureStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE[status],
      )}
    >
      {FEE_STRUCTURE_STATUS_LABELS[status]}
    </span>
  );
}
```

- [ ] **Step 3: Create `src/components/fees/fee-structures-list-view.tsx`**

```tsx
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { FeeStructureStatusBadge } from "@/components/fees/fee-structure-status-badge";
import type { FeeStructureDTO } from "@/services/fee-structure.service";
import type { FeeStructureStatus } from "@/lib/constants";

/** Quick-glance total: every ANNUAL line item summed. Not a stored field. */
function annualTotal(feeStructure: FeeStructureDTO): number {
  return (feeStructure.lineItems ?? [])
    .filter((item) => item.frequency === "ANNUAL")
    .reduce((sum, item) => sum + item.amount, 0);
}

export function FeeStructuresListView({ feeStructures }: { feeStructures: FeeStructureDTO[] }) {
  return (
    <>
      <PageHeader
        title="Fees"
        description="Class and course fee structures your website and partner sites read from the public API."
        actions={
          <Button asChild size="sm">
            <Link href="/fees/new">
              <Plus className="size-4" />
              Add a fee structure
            </Link>
          </Button>
        }
      />

      {feeStructures.length === 0 ? (
        <EmptyState
          title="No fee structures yet"
          description="Publish a class or course's fees and any website reading your public API picks it up."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Class / course</th>
                <th className="px-4 py-2 font-medium">Academic year</th>
                <th className="px-4 py-2 font-medium">Annual total</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {feeStructures.map((feeStructure) => (
                <tr key={feeStructure.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/fees/${feeStructure.id}`} className="font-medium hover:underline">
                      {feeStructure.classOrCourse}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{feeStructure.academicYear}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    ₹{annualTotal(feeStructure).toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-2.5">
                    <FeeStructureStatusBadge status={feeStructure.status as FeeStructureStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Create `src/app/(dashboard)/fees/page.tsx`**

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { FeeStructureService } from "@/services/fee-structure.service";
import { FeeStructuresListView } from "@/components/fees/fee-structures-list-view";

export const metadata: Metadata = { title: "Fees" };
export const dynamic = "force-dynamic";

/**
 * The institute admin owns this screen, matching Results and Staff exactly:
 * the platform admin has no route here, and neither does Counselor or Front
 * Desk — they read published fees the same way any public caller does.
 */
export default async function FeesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const feeStructures = await FeeStructureService.list(institution.institutionId);

  return <FeeStructuresListView feeStructures={feeStructures} />;
}
```

- [ ] **Step 5: Verify manually**

No browser tool is available in this environment (an established fact for every UI task in this project's execution so far) — use the same headless-HTTP verification approach: start (or find an already-running) dev server, sign in as the seeded `admin@infinityschool.edu.in` / `Infinity!2026` account, fetch the rendered `/fees` page HTML, and confirm it renders the empty state ("No fee structures yet") with an "Add a fee structure" link to `/fees/new`. Then use `FeeStructureService.create`/`.setStatus` directly (or the API routes from Task 5) to seed one fee structure, re-fetch `/fees`, and confirm the table renders it with the correct class/course, academic year, computed annual total, and status badge. Also confirm the nav item "Fees" appears for an admin session and is absent for a Counselor or Front Desk session (`GET /dashboard` or any dashboard page, checking the rendered nav markup). Report exactly what you verified this way.

- [ ] **Step 6: Run the full suite to confirm nothing regressed**

```bash
npx tsc --noEmit
npm run lint
npm test -- --run
```

Expected: typecheck and lint clean, 552 passing (unchanged — this task adds no automated tests, matching the established UI-task pattern).

- [ ] **Step 7: Commit**

```bash
git add src/components/dashboard/nav-config.ts src/components/fees/fee-structure-status-badge.tsx src/components/fees/fee-structures-list-view.tsx "src/app/(dashboard)/fees/page.tsx"
git commit -m "feat: add the fee structures dashboard list"
```

---

### Task 10: Dashboard — the fee structure editor

**Files:**
- Create: `src/components/fees/fee-structure-form.tsx`
- Create: `src/components/fees/fee-structure-actions.tsx`
- Create: `src/app/(dashboard)/fees/new/page.tsx`
- Create: `src/app/(dashboard)/fees/[feeId]/page.tsx`

**Interfaces:**
- Consumes: `createFeeStructureSchema`/`updateFeeStructureSchema` (Task 2); `FeeStructureService.get`/`setStatus` (Tasks 3–4); `FeeStructureDTO` (Task 3); `FEE_FREQUENCIES`/`FEE_FREQUENCY_LABELS` (Task 1); `FeeStructureStatusBadge` (Task 9).
- Produces: `/fees/new` and `/fees/[feeId]`, the two pages `fee-structures-list-view.tsx`'s links point at.

Before writing `fee-structure-form.tsx`, read `src/components/ui/button.tsx` and `src/components/profile/section-form.tsx` (specifically the `TextField` export's props) to confirm the exact prop names used below — this task's code follows the conventions already confirmed elsewhere in this codebase (`register()` spread, `error` prop taking a string), but confirm before assuming rather than guessing blind.

- [ ] **Step 1: Create `src/components/fees/fee-structure-form.tsx`**

One form for both create and edit — unlike Results' three-section tabbed editor (which exists because toppers need photo uploads requiring an already-saved record), a fee structure's identity and line items have no such dependency, so a single form covers both cases.

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createFeeStructureSchema, updateFeeStructureSchema } from "@/lib/validation/fee-structure";
import { FEE_FREQUENCIES, FEE_FREQUENCY_LABELS, type FeeFrequency } from "@/lib/constants";
import type { FeeStructureDTO } from "@/services/fee-structure.service";

type Values = z.input<typeof createFeeStructureSchema>;

export function FeeStructureForm({
  initialFeeStructure,
}: {
  /** `null` while creating — the same fields, saved by a POST instead of a PATCH. */
  initialFeeStructure: FeeStructureDTO | null;
}) {
  const router = useRouter();
  const isEditing = initialFeeStructure !== null;

  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(isEditing ? updateFeeStructureSchema : createFeeStructureSchema),
    defaultValues: {
      classOrCourse: initialFeeStructure?.classOrCourse ?? "",
      academicYear: initialFeeStructure?.academicYear ?? "",
      lineItems: initialFeeStructure?.lineItems?.map((item) => ({
        label: item.label,
        amount: item.amount,
        frequency: item.frequency as FeeFrequency,
        optional: item.optional,
      })) ?? [],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "lineItems" });

  async function onSubmit(values: Values) {
    try {
      const response = await fetch(
        isEditing ? `/api/settings/fees/${initialFeeStructure.id}` : "/api/settings/fees",
        {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        },
      );
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not save. Please try again.");
        return;
      }

      toast.success(isEditing ? "Fee structure updated" : "Fee structure created");
      if (!isEditing) {
        router.push(`/fees/${payload.feeStructure.id}`);
      } else {
        router.refresh();
      }
    } catch {
      toast.error("Could not reach the server. Please try again.");
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="classOrCourse">Class or course</Label>
          <Input
            id="classOrCourse"
            placeholder="Grade 10"
            aria-invalid={Boolean(errors.classOrCourse)}
            {...register("classOrCourse")}
          />
          {errors.classOrCourse ? (
            <p className="text-xs text-destructive">{errors.classOrCourse.message}</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="academicYear">Academic year</Label>
          <Input
            id="academicYear"
            placeholder="2026-27"
            aria-invalid={Boolean(errors.academicYear)}
            {...register("academicYear")}
          />
          {errors.academicYear ? (
            <p className="text-xs text-destructive">{errors.academicYear.message}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Line items</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => append({ label: "", amount: 0, frequency: "ANNUAL", optional: false })}
          >
            <Plus className="size-3.5" />
            Add line item
          </Button>
        </div>

        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">No line items yet.</p>
        ) : (
          <div className="space-y-3">
            {fields.map((field, index) => (
              <div
                key={field.id}
                className="grid items-end gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_140px_140px_auto_auto]"
              >
                <div className="space-y-1">
                  <Label htmlFor={`lineItems.${index}.label`} className="text-xs">
                    Label
                  </Label>
                  <Input
                    id={`lineItems.${index}.label`}
                    placeholder="Tuition"
                    {...register(`lineItems.${index}.label` as const)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`lineItems.${index}.amount`} className="text-xs">
                    Amount (₹)
                  </Label>
                  <Input
                    id={`lineItems.${index}.amount`}
                    type="number"
                    min={0}
                    {...register(`lineItems.${index}.amount` as const, { valueAsNumber: true })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`lineItems.${index}.frequency`} className="text-xs">
                    Frequency
                  </Label>
                  <Select
                    value={field.frequency}
                    onValueChange={(value) => {
                      register(`lineItems.${index}.frequency` as const).onChange({
                        target: { value },
                      });
                    }}
                  >
                    <SelectTrigger id={`lineItems.${index}.frequency`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FEE_FREQUENCIES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {FEE_FREQUENCY_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-1.5 pb-2">
                  <Checkbox
                    id={`lineItems.${index}.optional`}
                    {...register(`lineItems.${index}.optional` as const)}
                  />
                  <Label htmlFor={`lineItems.${index}.optional`} className="text-xs font-normal">
                    Optional
                  </Label>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => remove(index)}
                  aria-label="Remove line item"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {errors.lineItems ? (
          <p className="text-xs text-destructive">{errors.lineItems.message as string}</p>
        ) : null}
      </div>

      <Button type="submit" size="sm" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : isEditing ? "Save changes" : "Create fee structure"}
      </Button>
    </form>
  );
}
```

Check `Select`'s actual controlled-value API against `src/components/ui/select.tsx` and against how `create-staff-dialog.tsx` already drives it (`onValueChange={(value) => setValue("role", value)}`) before assuming `register(...).onChange({target:{value}})` is the right way to wire a `Select` into react-hook-form for this codebase — the staff dialog's pattern (a plain `onValueChange` calling `setValue` directly, not routing through `register`) is more likely the established convention here; if so, use `setValue` from `useForm` instead, matching that file exactly rather than the pattern drafted above. Also check whether `Checkbox` exists as a component in `src/components/ui/` at all — if it doesn't, use a plain `<input type="checkbox">` styled to match this codebase's existing form conventions instead of assuming a component that may not exist.

- [ ] **Step 2: Create `src/components/fees/fee-structure-actions.tsx`**

Mirrors `ArchiveDeleteControl` and `PublishControl` from `src/components/results/result-editor.tsx` (built in the `chore/close-phase-gaps` branch's Batch 1) — same confirm-dialog pattern, same fetch/toast/router cycle, combined into one component since a fee structure has three lifecycle actions (publish/unpublish, archive, delete) rather than two.

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, Globe, Lock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FeeStructureDTO } from "@/services/fee-structure.service";

type DialogKind = "publish" | "unpublish" | "archive" | "delete" | null;

export function FeeStructureActions({ feeStructure }: { feeStructure: FeeStructureDTO }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);

  async function setStatus(action: "publish" | "unpublish" | "archive") {
    setBusy(true);
    try {
      const response = await fetch(`/api/settings/fees/${feeStructure.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not update. Please try again.");
        return;
      }

      toast.success(
        action === "publish" ? "Fee structure published" : action === "unpublish" ? "Fee structure unpublished" : "Fee structure archived",
      );
      setDialog(null);
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      const response = await fetch(`/api/settings/fees/${feeStructure.id}`, { method: "DELETE" });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not delete. Please try again.");
        setBusy(false);
        return;
      }

      toast.success("Fee structure deleted");
      router.push("/fees");
    } catch {
      toast.error("Could not reach the server. Please try again.");
      setBusy(false);
    }
  }

  const published = feeStructure.status === "PUBLISHED";

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant={published ? "outline" : "default"}
        onClick={() => setDialog(published ? "unpublish" : "publish")}
      >
        {published ? <Lock className="size-3.5" /> : <Globe className="size-3.5" />}
        {published ? "Unpublish" : "Publish"}
      </Button>
      {feeStructure.status !== "ARCHIVED" ? (
        <Button size="sm" variant="outline" onClick={() => setDialog("archive")}>
          <Archive className="size-3.5" />
          Archive
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        className="text-destructive hover:text-destructive"
        onClick={() => setDialog("delete")}
      >
        <Trash2 className="size-3.5" />
        Delete
      </Button>

      <Dialog open={dialog === "publish"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Publish {feeStructure.classOrCourse}'s fees?</DialogTitle>
            <DialogDescription>
              This makes every line item public to any website reading your API, with no login.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => setStatus("publish")} disabled={busy}>
              {busy ? "Publishing…" : "Publish now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "unpublish"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Unpublish {feeStructure.classOrCourse}'s fees?</DialogTitle>
            <DialogDescription>
              This removes it from your public API immediately. Nothing is deleted, and you can
              publish again at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => setStatus("unpublish")} disabled={busy}>
              {busy ? "Unpublishing…" : "Unpublish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "archive"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Archive {feeStructure.classOrCourse}'s fees?</DialogTitle>
            <DialogDescription>
              {feeStructure.status === "PUBLISHED"
                ? "This removes it from your public API. Nothing is deleted — you can publish again to bring it back."
                : "This moves the structure out of your active list. Nothing is deleted."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => setStatus("archive")} disabled={busy}>
              {busy ? "Archiving…" : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "delete"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Delete {feeStructure.classOrCourse}'s fees?</DialogTitle>
            <DialogDescription>
              This permanently removes the fee structure and every line item. This cannot be
              undone.
              {feeStructure.status === "PUBLISHED"
                ? " It also disappears from your public API immediately."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmDelete} disabled={busy}>
              {busy ? "Deleting…" : "Delete permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 3: Create `src/app/(dashboard)/fees/new/page.tsx`**

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { FeeStructureForm } from "@/components/fees/fee-structure-form";

export const metadata: Metadata = { title: "Add a fee structure" };
export const dynamic = "force-dynamic";

export default async function NewFeeStructurePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3 text-muted-foreground">
        <Link href="/fees">
          <ArrowLeft className="size-3.5" />
          Fees
        </Link>
      </Button>

      <PageHeader
        title="Add a fee structure"
        description="Name the class or course and its academic year, then add line items."
      />

      <FeeStructureForm initialFeeStructure={null} />
    </>
  );
}
```

- [ ] **Step 4: Create `src/app/(dashboard)/fees/[feeId]/page.tsx`**

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { AppError } from "@/lib/api/errors";
import { FeeStructureService, type FeeStructureDTO } from "@/services/fee-structure.service";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { FeeStructureForm } from "@/components/fees/fee-structure-form";
import { FeeStructureActions } from "@/components/fees/fee-structure-actions";

export const metadata: Metadata = { title: "Fee structure" };
export const dynamic = "force-dynamic";

export default async function FeeStructureEditorPage(props: PageProps<"/fees/[feeId]">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const { feeId } = await props.params;

  let feeStructure: FeeStructureDTO;
  try {
    feeStructure = await FeeStructureService.get(institution.institutionId, feeId);
  } catch (error) {
    // A fee structure belonging to someone else, or an id that is not an id
    // at all, is "no such page" — never a 500.
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3 text-muted-foreground">
        <Link href="/fees">
          <ArrowLeft className="size-3.5" />
          Fees
        </Link>
      </Button>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={`${feeStructure.classOrCourse} · ${feeStructure.academicYear}`}
          description="Everything a website reading your public fees endpoint would see."
        />
        <FeeStructureActions feeStructure={feeStructure} />
      </div>

      <FeeStructureForm initialFeeStructure={feeStructure} />
    </>
  );
}
```

Check `PageProps<"/fees/[feeId]">` resolves correctly for this route once the file exists — this codebase's typed-route generation (seen throughout every prior phase's editor page) picks up new dynamic routes automatically on the next `next dev`/`next build`, but confirm no stale type error remains after creating this file.

- [ ] **Step 5: Verify manually**

No browser tool is available in this environment — same headless-HTTP approach as every other UI task. Start (or find) a running dev server, sign in as the seeded admin account:

1. Fetch `GET /fees/new` and confirm the form renders with empty class/course and academic year inputs and an "Add line item" button.
2. Drive `POST /api/settings/fees` directly (matching what the form's `fetch` call sends) to create a fee structure with one line item, then fetch `GET /fees/{id}` and confirm the page renders the identity fields pre-filled, the line item pre-filled, and Publish/Archive/Delete controls.
3. Drive `POST /api/settings/fees/{id}/publish` with `{"action":"publish"}` and re-fetch the page; confirm the status badge (if surfaced) or the Actions component's button label reflects the new state ("Unpublish" instead of "Publish").
4. Confirm a Counselor or Front Desk session redirects away from `/fees/new` and `/fees/[feeId]` (both pages redirect to `/dashboard` before rendering, per the role check at the top of each).

Report exactly what you verified this way and what remains unverifiable without an actual browser (the Select dropdown's open state, the `useFieldArray` add/remove interaction, toast rendering) — matching how every prior UI task in this project has reported this honestly rather than claiming a walkthrough that didn't happen.

- [ ] **Step 6: Run the full suite**

```bash
npx tsc --noEmit
npm run lint
npm test -- --run
```

Expected: typecheck and lint clean, 552 passing (unchanged — this task adds no automated tests).

- [ ] **Step 7: Commit**

```bash
git add src/components/fees/fee-structure-form.tsx src/components/fees/fee-structure-actions.tsx "src/app/(dashboard)/fees/new" "src/app/(dashboard)/fees/[feeId]"
git commit -m "feat: add the fee structure editor"
```

---

## Plan self-review

Run against the spec after writing; findings recorded here rather than silently fixed.

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| §2 decisions 1, 9, 10 (collection shape, unique index, visibility gate) | 1, 6, 7 |
| §2 decisions 2–3 (classOrCourse free text, no FK) | 2 |
| §2 decisions 4–5 (itemized line items, frequency enum) | 1, 2 |
| §2 decision 6 (versioning, lifecycle) | 1, 4 |
| §2 decision 7 (public) | 6, 7 |
| §2 decision 8 (admin-only, no new permission) | 5 |
| §4 data model | 1 |
| §5 validation | 2 |
| §6 API surface | 5, 7 |
| §7 authorization | 5 |
| §8 public projection | 6 |
| §9 dashboard | 9, 10 |
| §11 future extensibility | no task — deliberately not implemented |
| §12 testing | every listed file has a corresponding task's test |
| §13 definition of done | walked below |

**Definition of done, walked against this plan:**

- All tests green, pre-existing suite (496) still green at every commit — enforced by every task's Step "run the full suite."
- `npx tsc --noEmit` clean, lint clean — same.
- Every invariant in spec §5 has a mutation-checked test — Tasks 2–4's mutation-check tables.
- The projection's exhaustive-key test fails when a field is added — Task 6, Step 1's first test.
- A published fee structure is readable with no credentials, by both id and slug — Task 7's test file.
- A draft fee structure, and a published one on a suspended institution, both 404 — Task 7's test file.
- The platform admin has no route — enforced by construction (no route exists), same as Results.
- A Counselor and Front Desk session are rejected on every write route, verified by mutation — Task 5, Step 7.
- OpenAPI documents both public paths — Task 8.

**Placeholder scan:** no "TBD"/"TODO"/"handle appropriately" found in any task. Every code step contains real code. Two places explicitly ask the implementer to *verify* something against the real file before proceeding rather than blindly trusting the plan's own guess (Task 8's `PLACEHOLDER_ID` constant name; Task 10's `Select`/`Checkbox` wiring) — these are flagged uncertainty, not missing content, and each names exactly what to check and what to do with either outcome.

**Type consistency check:** `FeeStructureDTO` (Task 3) is used identically in Tasks 5, 7, 9, and 10 — `id`, `classOrCourse`, `academicYear`, `lineItems`, `status`, `publishedAt`. `FeeStructureService`'s method names (`list`, `get`, `create`, `update`, `remove`, `setStatus`, `listPublic`) are referenced identically everywhere they're consumed. `PublicFeeStructure` (Task 6) matches exactly what Task 7's `listPublic` returns and what Task 8's OpenAPI schema documents (`classOrCourse`, `academicYear`, `lineItems`, `publishedAt` — no more, no less). `FEE_FREQUENCIES`/`FEE_STRUCTURE_STATUSES` (Task 1) are the only two enums introduced, used consistently in the model, validation, service, routes, and UI.

**Test-count chain**, verified by direct count against every task's own test code, not by re-deriving arithmetic from memory: 496 → 499 (Task 1, +3) → 506 (Task 2, +7) → 516 (Task 3, +10) → 521 (Task 4, +5) → 531 (Task 5, +10) → 537 (Task 6, +6) → 547 (Task 7, +10) → 552 (Task 8, +5) → 552 (Task 9, +0, UI only) → 552 (Task 10, +0, UI only).

(This chain was corrected once already, during this self-review: Task 3's test file was originally miscounted as 9 tests when it actually contains 10 — caught by mechanically counting `it(` blocks against the written test code rather than trusting the arithmetic, the same discipline this project's SDD process applies at pre-flight-scan time. Every downstream total in this plan was updated to match.)
