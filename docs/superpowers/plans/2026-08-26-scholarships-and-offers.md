# Scholarships & Offers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an institution two new publishable, publicly-readable record types — eligibility-based scholarships and time-bound discount offers — each scopeable to one class/course or the whole institution.

**Architecture:** Two independent Mongoose models following the `FeeStructure` pattern exactly (tenant-scoped, `DRAFT`/`PUBLISHED`/`ARCHIVED`, allow-list public projection, publish gate, derived class label). Each gets its own validation module, service, dashboard route set, public route pair, and UI pages. They share a pattern, never a model.

**Tech Stack:** Next.js 16 (App Router), Mongoose 8, Zod 4, TypeScript, Vitest 3, react-hook-form + `@hookform/resolvers/zod`, Radix/shadcn UI, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-26-scholarships-and-offers-design.md`

## Global Constraints

- **Tenant scoping is absolute.** Every read and write is filtered by `institutionId`. Another institution's row is `NOT_FOUND`, never `FORBIDDEN`. A malformed id is `NOT_FOUND`, never a Mongoose cast error (500).
- **Public projections are allow-lists.** Named fields only. Never a spread with deletions. Every projection re-checks `status === "PUBLISHED"` and returns `null` otherwise.
- **`status` is never patchable.** It is absent from every update schema so a PATCH cannot skip the publish gate. Zod strips it.
- **Guard optional numeric/date bounds with `!= null`, never `?? 0` or truthiness.** An unreported bound means "unknown", not "zero". This rule cost eight fix-rounds on the previous phase.
- **No new lint warnings.** The repo currently has exactly 7 `react-hooks/incompatible-library` warnings and 0 errors. `npx eslint src` must not exceed that.
- **`tsc --noEmit` clean** at the end of every task.
- **Radix `Select` is driven by `watch`/`setValue`, never `register()`** — it renders a button, not a native input.
- **Never run `git checkout`, `git switch`, or `git worktree add`** in this repo. It is a shared working directory with no per-task isolation. Use `git show <ref>:<path>` to read another commit.
- **Test helper signature (verified at source, do not guess):** `makeInstitution(institutionId: string, overrides: Record<string, unknown> = {})` and `makeProfiledInstitution(institutionId: string, overrides = {})` are **positional**. `makeInstitution({ institutionId: "INS0001" })` is wrong and will fail.

---

## File Structure

**Created:**
- `src/models/Scholarship.ts` — the Scholarship schema and model
- `src/models/Offer.ts` — the Offer schema and model
- `src/lib/validation/scholarship.ts` — create/update schemas + invariants + publish gate
- `src/lib/validation/offer.ts` — same, for offers
- `src/lib/academic/assert-owned.ts` — shared tenant check for a supplied `academicUnitId`
- `src/lib/scholarship/public-projection.ts` — allow-list projection
- `src/lib/offer/public-projection.ts` — allow-list projection
- `src/services/scholarship.service.ts` — CRUD + publish + public read
- `src/services/offer.service.ts` — same, for offers
- 10 dashboard route files under `src/app/api/settings/{scholarships,offers}/`
- 4 public route files under `src/app/api/public/`
- 6 dashboard pages under `src/app/(dashboard)/{scholarships,offers}/`
- 6 components under `src/components/{scholarships,offers}/`

**Modified:**
- `src/lib/constants.ts` — status/kind enums, labels, caps
- `src/models/index.ts` — export the two new models
- `src/components/dashboard/nav-config.ts` — two new nav items
- `src/app/api/v1/openapi.json/route.ts` and `openapi.yaml/route.ts` — document the 4 public routes

**Task ordering rationale:** Scholarship is built end-to-end first (Tasks 2–5), then Offer (Tasks 6–9), because Offer is strictly the more complex of the two (enum + numeric invariants + date window + expiry filtering) and benefits from Scholarship having already established the shape. Task 1 lands the shared foundations both need. Task 10 wires nav and OpenAPI once, for both.

---

## Task 1: Constants, shared tenant-check helper, model exports

**Files:**
- Modify: `src/lib/constants.ts`
- Create: `src/lib/academic/assert-owned.ts`
- Test: `tests/unit/assert-owned.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SCHOLARSHIP_STATUSES`, `ScholarshipStatus`, `SCHOLARSHIP_STATUS_LABELS`, `OFFER_STATUSES`, `OfferStatus`, `OFFER_STATUS_LABELS`, `OFFER_KINDS`, `OfferKind`, `OFFER_KIND_LABELS`, `SCHOLARSHIP_MAX_PER_INSTITUTION`, `OFFER_MAX_PER_INSTITUTION`; and `assertOwnedAcademicUnit(institutionId: string, academicUnitId: string | undefined): Promise<{ _id: Types.ObjectId; pathLabel: string } | null>`.

- [ ] **Step 1: Add the constants**

Append to `src/lib/constants.ts`, after the existing `FEE_STRUCTURE_STATUS_LABELS` block:

```ts
export const SCHOLARSHIP_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type ScholarshipStatus = (typeof SCHOLARSHIP_STATUSES)[number];

export const SCHOLARSHIP_STATUS_LABELS: Record<ScholarshipStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export const OFFER_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export const OFFER_KINDS = ["PERCENTAGE", "FLAT"] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

export const OFFER_KIND_LABELS: Record<OfferKind, string> = {
  PERCENTAGE: "Percentage off",
  FLAT: "Flat amount off",
};

/** Document-count caps. Neither is enforced by an index — the service checks before insert. */
export const SCHOLARSHIP_MAX_PER_INSTITUTION = 40;
export const OFFER_MAX_PER_INSTITUTION = 40;
```

Status enums are declared per-model rather than shared even though their members are identical — this matches how `RESULT_STATUSES` and `FEE_STRUCTURE_STATUSES` already coexist as distinct constants. Each model owns its own lifecycle.

- [ ] **Step 2: Write the failing test for the tenant-check helper**

Create `tests/unit/assert-owned.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit } from "@/models";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { assertOwnedAcademicUnit } from "@/lib/academic/assert-owned";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(async () => {
  await startTestDatabase("assert-owned");
  await AcademicUnit.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("assertOwnedAcademicUnit", () => {
  it("returns the unit when it belongs to the calling institution", async () => {
    const unit = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 10" },
      actor,
    );

    const found = await assertOwnedAcademicUnit("INS0001", unit.id);

    expect(found).not.toBeNull();
    expect(found?.pathLabel).toBe("Grade 10");
  });

  it("returns null when no id is supplied", async () => {
    expect(await assertOwnedAcademicUnit("INS0001", undefined)).toBeNull();
  });

  it("throws NOT_FOUND for another institution's unit", async () => {
    const foreign = await AcademicStructureService.create(
      "INS0002",
      { segment: "SCHOOL", name: "Grade 10" },
      actor,
    );

    await expect(assertOwnedAcademicUnit("INS0001", foreign.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws NOT_FOUND for a malformed id rather than a cast error", async () => {
    await expect(assertOwnedAcademicUnit("INS0001", "not-an-object-id")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run tests/unit/assert-owned.test.ts`
Expected: FAIL — cannot resolve `@/lib/academic/assert-owned`.

- [ ] **Step 4: Implement the helper**

Create `src/lib/academic/assert-owned.ts`:

```ts
import "server-only";
import { Types } from "mongoose";
import { AcademicUnit } from "@/models";
import { notFound } from "@/lib/api/errors";

/**
 * Resolves a caller-supplied academic unit id, scoped to the calling
 * institution. Another institution's unit is "no such unit" — NOT_FOUND,
 * never FORBIDDEN — and so is a malformed id, which must never surface as a
 * Mongoose cast error.
 *
 * Returns `null` (not a throw) when no id was supplied at all: for
 * scholarships and offers an absent unit means "applies institution-wide",
 * which is a valid state, unlike a fee structure where the unit is required.
 *
 * Extracted rather than copied because three consumers now need it —
 * `fee-structure.service.ts` predates this and keeps its own inline copy for
 * now, since its variant also selects `pathLabel` for a different purpose and
 * changing it is not this phase's business.
 */
export async function assertOwnedAcademicUnit(
  institutionId: string,
  academicUnitId: string | undefined | null,
): Promise<{ _id: Types.ObjectId; pathLabel: string } | null> {
  if (academicUnitId == null) return null;
  if (!Types.ObjectId.isValid(academicUnitId)) throw notFound("Academic unit not found");

  const unit = await AcademicUnit.findOne({
    _id: new Types.ObjectId(academicUnitId),
    institutionId,
  })
    .select("_id pathLabel")
    .lean<{ _id: Types.ObjectId; pathLabel: string }>();

  if (!unit) throw notFound("Academic unit not found");
  return unit;
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run tests/unit/assert-owned.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Mutation-check the tenant guard**

This proves the test is not confounded. Temporarily delete `institutionId` from the `findOne` filter:

```ts
  const unit = await AcademicUnit.findOne({
    _id: new Types.ObjectId(academicUnitId),
  })
```

Before running tests, print evidence the deletion actually landed:

```bash
grep -n "institutionId" src/lib/academic/assert-owned.ts
```

Expected: the `institutionId` line inside `findOne` is gone from the output.

Then run: `npx vitest run tests/unit/assert-owned.test.ts`
Expected: FAIL — and **only** "throws NOT_FOUND for another institution's unit" fails. If any other test fails too, or if that one passes, stop and report: the test is not isolating what it claims.

Restore the line. This file is uncommitted at this point, so `git diff --quiet` proves nothing — instead confirm restoration by re-running the test (4 passing) AND re-running the grep to see `institutionId` back inside the filter.

- [ ] **Step 7: Commit**

```bash
git add src/lib/constants.ts src/lib/academic/assert-owned.ts tests/unit/assert-owned.test.ts
git commit -m "feat: add scholarship/offer constants and shared academic-unit tenant check"
```

---

## Task 2: Scholarship model and validation

**Files:**
- Create: `src/models/Scholarship.ts`
- Modify: `src/models/index.ts`
- Create: `src/lib/validation/scholarship.ts`
- Test: `tests/unit/scholarship-model.test.ts`, `tests/unit/scholarship-validation.test.ts`

**Interfaces:**
- Consumes: `SCHOLARSHIP_STATUSES` from Task 1.
- Produces: `Scholarship` model, `ScholarshipDoc` type; `createScholarshipSchema`, `updateScholarshipSchema`, `CreateScholarshipInput`, `UpdateScholarshipInput`, `assertScholarshipPublishable(input: { name?: string | null }): void`.

- [ ] **Step 1: Write the failing model test**

Create `tests/unit/scholarship-model.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { Scholarship } from "@/models";

beforeAll(async () => {
  await startTestDatabase("scholarship-model");
  await Scholarship.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("Scholarship model", () => {
  it("defaults a new scholarship to DRAFT with no publishedAt", async () => {
    const created = await Scholarship.create({
      institutionId: "INS0001",
      name: "Merit Scholarship",
    });

    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();
  });

  it("requires a name", async () => {
    await expect(Scholarship.create({ institutionId: "INS0001" })).rejects.toThrow();
  });

  it("rejects a status outside the enum", async () => {
    await expect(
      Scholarship.create({ institutionId: "INS0001", name: "X", status: "LIVE" }),
    ).rejects.toThrow();
  });

  it("stores amount as free-form text, not a number", async () => {
    const created = await Scholarship.create({
      institutionId: "INS0001",
      name: "Merit Scholarship",
      amount: "100% tuition for ranks 1-10",
    });

    expect(created.amount).toBe("100% tuition for ranks 1-10");
  });

  it("accepts an optional academicUnitId and leaves it unset when absent", async () => {
    const unitId = new Types.ObjectId();
    const scoped = await Scholarship.create({
      institutionId: "INS0001",
      name: "Science Merit",
      academicUnitId: unitId,
    });
    const wide = await Scholarship.create({ institutionId: "INS0001", name: "General Merit" });

    expect(String(scoped.academicUnitId)).toBe(String(unitId));
    expect(wide.academicUnitId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/unit/scholarship-model.test.ts`
Expected: FAIL — `Scholarship` is not exported from `@/models`.

- [ ] **Step 3: Create the model**

Create `src/models/Scholarship.ts`:

```ts
import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { SCHOLARSHIP_STATUSES } from "@/lib/constants";

const ScholarshipSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    criteria: { type: String, trim: true },
    /**
     * Free-form on purpose: "Up to ₹50,000", "100% tuition for ranks 1-10".
     * A kind/value pair like Offer's cannot express the eligibility half
     * without losing it, so this is prose the institution controls.
     */
    amount: { type: String, trim: true },
    /**
     * Absent means the scholarship applies institution-wide. No `ref`:
     * nothing here uses Mongoose populate — the service queries the unit
     * directly — and a `ref` would imply an access pattern that does not exist.
     */
    academicUnitId: { type: Schema.Types.ObjectId, index: true },
    status: { type: String, enum: SCHOLARSHIP_STATUSES, default: "DRAFT" },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

ScholarshipSchema.index({ institutionId: 1, createdAt: -1 });
ScholarshipSchema.index({ institutionId: 1, status: 1 });

export type ScholarshipDoc = InferSchemaType<typeof ScholarshipSchema> & { _id: Types.ObjectId };

export const Scholarship: Model<ScholarshipDoc> =
  (models.Scholarship as Model<ScholarshipDoc>) ??
  model<ScholarshipDoc>("Scholarship", ScholarshipSchema);
```

No unique index: an institution may legitimately run two scholarships with the same name in different years, and there is no academic-year field to key on.

- [ ] **Step 4: Export it**

Add to `src/models/index.ts`, following the existing export style in that file:

```ts
export { Scholarship, type ScholarshipDoc } from "./Scholarship";
```

- [ ] **Step 5: Run the model test to confirm it passes**

Run: `npx vitest run tests/unit/scholarship-model.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the failing validation test**

Create `tests/unit/scholarship-validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assertScholarshipPublishable,
  createScholarshipSchema,
  updateScholarshipSchema,
} from "@/lib/validation/scholarship";

describe("createScholarshipSchema", () => {
  it("accepts a minimal scholarship", () => {
    const parsed = createScholarshipSchema.parse({ name: "Merit Scholarship" });
    expect(parsed.name).toBe("Merit Scholarship");
  });

  it("rejects a blank name", () => {
    expect(() => createScholarshipSchema.parse({ name: "   " })).toThrow();
  });

  it("rejects a malformed academicUnitId", () => {
    expect(() =>
      createScholarshipSchema.parse({ name: "Merit", academicUnitId: "nope" }),
    ).toThrow();
  });

  it("strips status so a create cannot set it", () => {
    const parsed = createScholarshipSchema.parse({
      name: "Merit",
      status: "PUBLISHED",
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("status");
  });
});

describe("updateScholarshipSchema", () => {
  it("accepts a partial patch", () => {
    const parsed = updateScholarshipSchema.parse({ amount: "Up to ₹50,000" });
    expect(parsed.amount).toBe("Up to ₹50,000");
    expect(parsed.name).toBeUndefined();
  });

  it("strips status so a PATCH cannot skip the publish gate", () => {
    const parsed = updateScholarshipSchema.parse({
      name: "Merit",
      status: "PUBLISHED",
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("status");
  });
});

describe("assertScholarshipPublishable", () => {
  it("passes a scholarship with a name", () => {
    expect(() => assertScholarshipPublishable({ name: "Merit Scholarship" })).not.toThrow();
  });

  it("rejects a blank name", () => {
    expect(() => assertScholarshipPublishable({ name: "   " })).toThrow(
      /name: give this scholarship a name/,
    );
  });

  it("rejects a missing name", () => {
    expect(() => assertScholarshipPublishable({})).toThrow(/name: give this scholarship a name/);
  });
});
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `npx vitest run tests/unit/scholarship-validation.test.ts`
Expected: FAIL — cannot resolve `@/lib/validation/scholarship`.

- [ ] **Step 8: Write the validation module**

Create `src/lib/validation/scholarship.ts`:

```ts
import { z } from "zod";
import { validationError } from "@/lib/api/errors";
import { objectIdString, requiredText } from "./common";

export const createScholarshipSchema = z.object({
  name: requiredText("Scholarship name", 120),
  criteria: z.string().trim().max(600).optional(),
  amount: z.string().trim().max(80).optional(),
  academicUnitId: objectIdString.optional(),
});
export type CreateScholarshipInput = z.infer<typeof createScholarshipSchema>;

/**
 * `status` is absent, so a PATCH can never smuggle a scholarship into
 * PUBLISHED and skip the gate below — Zod strips it, the same mechanism
 * `updateFeeStructureSchema` uses. Unlike a fee structure, `academicUnitId`
 * IS patchable here: it carries no unique key, so moving a scholarship
 * between units breaks nothing.
 */
export const updateScholarshipSchema = createScholarshipSchema.partial();
export type UpdateScholarshipInput = z.infer<typeof updateScholarshipSchema>;

/**
 * The publish gate. Stricter than create, which a draft may satisfy while
 * incomplete: `name` is required at create, but a PATCH could blank it.
 */
export function assertScholarshipPublishable(input: { name?: string | null }): void {
  if (!input.name?.trim()) {
    throw validationError("name: give this scholarship a name before publishing it");
  }
}
```

- [ ] **Step 9: Run both tests to confirm they pass**

Run: `npx vitest run tests/unit/scholarship-model.test.ts tests/unit/scholarship-validation.test.ts`
Expected: PASS, 14 tests total.

- [ ] **Step 10: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/models/Scholarship.ts src/models/index.ts src/lib/validation/scholarship.ts tests/unit/scholarship-model.test.ts tests/unit/scholarship-validation.test.ts
git commit -m "feat: add the Scholarship model and its validation"
```

---

## Task 3: Scholarship public projection

**Files:**
- Create: `src/lib/scholarship/public-projection.ts`
- Test: `tests/unit/scholarship-projection.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2 at runtime (the projection takes a plain `Record<string, unknown>`).
- Produces: `toPublicScholarship(doc: Record<string, unknown>)` returning `PublicScholarship | null`, and the `PublicScholarship` type.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scholarship-projection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toPublicScholarship } from "@/lib/scholarship/public-projection";

const published = {
  _id: "aaa",
  institutionId: "INS0001",
  academicUnitId: "bbb",
  name: "Merit Scholarship",
  criteria: "Top 10 ranks in the board examination",
  amount: "100% tuition",
  classOrCourse: "Grade 10",
  status: "PUBLISHED",
  publishedAt: new Date("2026-05-10T00:00:00.000Z"),
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-10T00:00:00.000Z"),
};

describe("toPublicScholarship", () => {
  it("emits exactly the allowed top-level keys and no others", () => {
    const result = toPublicScholarship(published);

    expect(Object.keys(result ?? {}).sort()).toEqual(
      ["amount", "classOrCourse", "criteria", "name", "publishedAt"].sort(),
    );
  });

  it("never emits internal fields", () => {
    const result = toPublicScholarship(published) as Record<string, unknown>;

    expect(result).not.toHaveProperty("_id");
    expect(result).not.toHaveProperty("institutionId");
    expect(result).not.toHaveProperty("academicUnitId");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("returns null for a draft scholarship", () => {
    expect(toPublicScholarship({ ...published, status: "DRAFT" })).toBeNull();
  });

  it("returns null for an archived scholarship", () => {
    expect(toPublicScholarship({ ...published, status: "ARCHIVED" })).toBeNull();
  });

  it("drops an institution-wide scholarship's empty classOrCourse rather than emitting a blank", () => {
    const result = toPublicScholarship({ ...published, classOrCourse: "" }) as Record<
      string,
      unknown
    >;

    expect(result.classOrCourse).toBeUndefined();
  });

  it("does not leak a field added to the document but not to the allow-list", () => {
    const result = toPublicScholarship({
      ...published,
      internalReviewerNote: "do not publish this",
    }) as Record<string, unknown>;

    expect(result).not.toHaveProperty("internalReviewerNote");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/unit/scholarship-projection.test.ts`
Expected: FAIL — cannot resolve `@/lib/scholarship/public-projection`.

- [ ] **Step 3: Write the projection**

Create `src/lib/scholarship/public-projection.ts`:

```ts
/**
 * The only path from a Scholarship document to a public response.
 *
 * This is an allow-list: it names the fields that may leave. A field added to
 * the schema is private until someone deliberately adds it here. Rewriting
 * this as a spread with deletions would leak every future field on the day it
 * was added — a test exists specifically to catch that.
 *
 * The one rule that lives here and nowhere else: only a PUBLISHED scholarship
 * is ever projected. Callers already filter, but this is defence in depth on
 * the module's highest-risk boundary.
 */
type Doc = Record<string, unknown>;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export type PublicScholarship = NonNullable<ReturnType<typeof toPublicScholarship>>;

export function toPublicScholarship(scholarship: Doc) {
  const doc = scholarship ?? {};

  if (doc.status !== "PUBLISHED") return null;

  const publishedAt = doc.publishedAt;

  return {
    name: text(doc.name),
    criteria: text(doc.criteria),
    amount: text(doc.amount),
    /** Absent for an institution-wide scholarship — `text` drops the empty string. */
    classOrCourse: text(doc.classOrCourse),
    publishedAt: publishedAt instanceof Date ? publishedAt.toISOString() : text(publishedAt),
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/unit/scholarship-projection.test.ts`
Expected: PASS, 6 tests.

Note: `Object.keys()` includes keys whose value is `undefined`, so the first test's key list holds even for an institution-wide scholarship. That is deliberate and matches `toPublicFeeStructure`'s existing behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scholarship/public-projection.ts tests/unit/scholarship-projection.test.ts
git commit -m "feat: add the Scholarship public projection allow-list"
```

---

## Task 4: Scholarship service

**Files:**
- Create: `src/services/scholarship.service.ts`
- Test: `tests/integration/scholarship-crud.test.ts`

**Interfaces:**
- Consumes: `Scholarship`/`ScholarshipDoc` (Task 2), `createScholarshipSchema`/`updateScholarshipSchema`/`assertScholarshipPublishable` (Task 2), `toPublicScholarship`/`PublicScholarship` (Task 3), `assertOwnedAcademicUnit` (Task 1), `SCHOLARSHIP_MAX_PER_INSTITUTION` (Task 1).
- Produces: `ScholarshipService` with `list`, `listPublic`, `get`, `create`, `update`, `setStatus`, `remove`; and `ScholarshipDTO`.

**Interface contract for `ScholarshipDTO`** — later tasks depend on these exact field names:

```ts
export type ScholarshipDTO = {
  id: string;
  name: string;
  criteria?: string;
  amount?: string;
  academicUnitId?: string;
  /** Derived live from the unit's pathLabel. Absent when institution-wide. */
  classOrCourse?: string;
  status: string;
  publishedAt?: string;
  updatedAt?: string;
};
```

- [ ] **Step 1: Write the failing service test**

Create `tests/integration/scholarship-crud.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit, Scholarship } from "@/models";
import { AcademicStructureService, type AcademicUnitDTO } from "@/services/academic-structure.service";
import { ScholarshipService } from "@/services/scholarship.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

let unit: AcademicUnitDTO;
let foreignUnit: AcademicUnitDTO;

beforeAll(async () => {
  await startTestDatabase("scholarship-crud");
  await Scholarship.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
  await AcademicUnit.syncIndexes();
  unit = await AcademicStructureService.create(
    "INS0001",
    { segment: "SCHOOL", name: "Grade 10" },
    actor,
  );
  foreignUnit = await AcademicStructureService.create(
    "INS0002",
    { segment: "SCHOOL", name: "Grade 10" },
    actor,
  );
});

describe("ScholarshipService", () => {
  it("creates an institution-wide scholarship and reads it back", async () => {
    const created = await ScholarshipService.create(
      "INS0001",
      { name: "Merit Scholarship", criteria: "Top 10 ranks", amount: "100% tuition" },
      actor,
    );

    expect(created.id).toBeDefined();
    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();
    expect(created.classOrCourse).toBeUndefined();

    const read = await ScholarshipService.get("INS0001", created.id);
    expect(read.name).toBe("Merit Scholarship");
  });

  it("derives classOrCourse live from the academic unit", async () => {
    const created = await ScholarshipService.create(
      "INS0001",
      { name: "Science Merit", academicUnitId: unit.id },
      actor,
    );

    expect(created.classOrCourse).toBe("Grade 10");

    await AcademicStructureService.update("INS0001", unit.id, { name: "Class 10" }, actor);

    const read = await ScholarshipService.get("INS0001", created.id);
    expect(read.classOrCourse).toBe("Class 10");
  });

  it("refuses another institution's academic unit as NOT_FOUND", async () => {
    await expect(
      ScholarshipService.create(
        "INS0001",
        { name: "Merit", academicUnitId: foreignUnit.id },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists only the calling institution's scholarships", async () => {
    await ScholarshipService.create("INS0001", { name: "Mine" }, actor);
    await ScholarshipService.create("INS0002", { name: "Theirs" }, actor);

    const list = await ScholarshipService.list("INS0001");

    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("Mine");
  });

  it("treats another institution's scholarship as NOT_FOUND, never FORBIDDEN", async () => {
    const theirs = await ScholarshipService.create("INS0002", { name: "Theirs" }, actor);

    await expect(ScholarshipService.get("INS0001", theirs.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects a malformed id as NOT_FOUND rather than a cast error", async () => {
    await expect(ScholarshipService.get("INS0001", "not-an-object-id")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("updates a scholarship and can move it between units", async () => {
    const created = await ScholarshipService.create("INS0001", { name: "Merit" }, actor);

    const updated = await ScholarshipService.update(
      "INS0001",
      created.id,
      { amount: "Up to ₹50,000", academicUnitId: unit.id },
      actor,
    );

    expect(updated.amount).toBe("Up to ₹50,000");
    expect(updated.classOrCourse).toBe("Grade 10");
  });

  it("publishes, stamps publishedAt, and keeps it across a republish", async () => {
    const created = await ScholarshipService.create("INS0001", { name: "Merit" }, actor);

    const published = await ScholarshipService.setStatus("INS0001", created.id, "publish", actor);
    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).toBeDefined();

    await ScholarshipService.setStatus("INS0001", created.id, "unpublish", actor);
    const republished = await ScholarshipService.setStatus(
      "INS0001",
      created.id,
      "publish",
      actor,
    );

    expect(republished.publishedAt).toBe(published.publishedAt);
  });

  it("refuses to publish a scholarship whose name was blanked by a patch", async () => {
    const created = await ScholarshipService.create("INS0001", { name: "Merit" }, actor);
    await Scholarship.updateOne({ _id: created.id }, { $set: { name: "  " } });

    await expect(
      ScholarshipService.setStatus("INS0001", created.id, "publish", actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("refuses to create beyond the per-institution cap", async () => {
    for (let i = 0; i < 40; i += 1) {
      await ScholarshipService.create("INS0001", { name: `Scholarship ${i}` }, actor);
    }

    await expect(
      ScholarshipService.create("INS0001", { name: "One too many" }, actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("deletes a scholarship", async () => {
    const created = await ScholarshipService.create("INS0001", { name: "Merit" }, actor);
    await ScholarshipService.remove("INS0001", created.id, actor);

    await expect(ScholarshipService.get("INS0001", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
```

Before writing the implementation, verify `AcademicStructureService.update`'s real signature with `grep -n "async update" -A 6 src/services/academic-structure.service.ts` — the "derives classOrCourse live" test above calls it, and a guessed shape would fail. Adjust that one call to match reality; do not adjust the assertion.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/integration/scholarship-crud.test.ts`
Expected: FAIL — cannot resolve `@/services/scholarship.service`.

- [ ] **Step 3: Write the service**

Create `src/services/scholarship.service.ts`:

```ts
import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { AcademicUnit, Institution, Scholarship, type ScholarshipDoc } from "@/models";
import { notFound, validationError } from "@/lib/api/errors";
import { SCHOLARSHIP_MAX_PER_INSTITUTION } from "@/lib/constants";
import {
  assertScholarshipPublishable,
  type CreateScholarshipInput,
  type UpdateScholarshipInput,
} from "@/lib/validation/scholarship";
import { assertOwnedAcademicUnit } from "@/lib/academic/assert-owned";
import { toPublicScholarship, type PublicScholarship } from "@/lib/scholarship/public-projection";
import { ActivityService } from "./activity.service";

export type ScholarshipDTO = {
  id: string;
  name: string;
  criteria?: string;
  amount?: string;
  academicUnitId?: string;
  classOrCourse?: string;
  status: string;
  publishedAt?: string;
  updatedAt?: string;
};

/** A row with its label attached. The label is never stored — see `withLabels`. */
type ScholarshipRow = ScholarshipDoc & { classOrCourse?: string };

/** A malformed id must read as "no such scholarship", not as a 500. */
function toObjectId(scholarshipId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(scholarshipId)) throw notFound("Scholarship not found");
  return new Types.ObjectId(scholarshipId);
}

/**
 * Scholarships store a unit id, not a label. Every read path passes its rows
 * through here, which fetches the referenced units in ONE query and attaches
 * each row's `classOrCourse` from the unit's current `pathLabel`.
 *
 * Rows with no `academicUnitId` are institution-wide and get no label at all.
 */
async function withLabels(
  institutionId: string,
  rows: ScholarshipDoc[],
): Promise<ScholarshipRow[]> {
  if (rows.length === 0) return [];

  const unitIds = rows.map((row) => row.academicUnitId).filter(Boolean);
  const units = unitIds.length
    ? await AcademicUnit.find({ _id: { $in: unitIds }, institutionId })
        .select("_id pathLabel")
        .lean<{ _id: Types.ObjectId; pathLabel: string }[]>()
    : [];

  const labelById = new Map(units.map((unit) => [String(unit._id), unit.pathLabel]));

  return rows.map((row) => ({
    ...row,
    classOrCourse: row.academicUnitId ? labelById.get(String(row.academicUnitId)) : undefined,
  }));
}

function serialize(row: ScholarshipRow): ScholarshipDTO {
  return {
    id: String(row._id),
    name: row.name,
    criteria: row.criteria || undefined,
    amount: row.amount || undefined,
    academicUnitId: row.academicUnitId ? String(row.academicUnitId) : undefined,
    classOrCourse: row.classOrCourse || undefined,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString(),
    updatedAt: (row as ScholarshipDoc & { updatedAt?: Date }).updatedAt?.toISOString(),
  };
}

/** Every read is scoped by institutionId, so a foreign id is simply not found. */
async function findOwned(institutionId: string, scholarshipId: string): Promise<ScholarshipDoc> {
  const row = await Scholarship.findOne({
    _id: toObjectId(scholarshipId),
    institutionId,
  }).lean<ScholarshipDoc>();
  if (!row) throw notFound("Scholarship not found");
  return row;
}

/**
 * A key absent from a patch arrives as `undefined` and must be left alone —
 * `$set: { amount: undefined }` would otherwise erase a stored value the
 * caller never mentioned.
 */
function stripUndefined<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

const ACTION_LABELS: Record<"publish" | "unpublish" | "archive", string> = {
  publish: "published",
  unpublish: "unpublished",
  archive: "archived",
};

export const ScholarshipService = {
  async list(institutionId: string): Promise<ScholarshipDTO[]> {
    await connectToDatabase();
    const rows = await Scholarship.find({ institutionId })
      .sort({ createdAt: -1 })
      .lean<ScholarshipDoc[]>();
    return (await withLabels(institutionId, rows)).map(serialize);
  },

  /**
   * Returns null when the institution is not publicly visible at all — the
   * caller turns that into a 404. An empty array means "visible, but nothing
   * published", a 200. The visibility gate matches the profile, results and
   * fees endpoints' exactly, so a scholarship can never be reachable on an
   * institution whose profile 404s.
   */
  async listPublic(query: {
    institutionId?: string;
    slug?: string;
  }): Promise<PublicScholarship[] | null> {
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

    const rows = await Scholarship.find({
      institutionId: institution.institutionId,
      status: "PUBLISHED",
    })
      .sort({ createdAt: -1 })
      .lean<ScholarshipDoc[]>();

    // The projection is the allow-list; it also re-checks PUBLISHED, so a
    // filter mistake here cannot leak an unpublished record.
    return (await withLabels(institution.institutionId, rows))
      .map((row) => toPublicScholarship(row as unknown as Record<string, unknown>))
      .filter((row): row is PublicScholarship => row !== null);
  },

  async get(institutionId: string, scholarshipId: string): Promise<ScholarshipDTO> {
    await connectToDatabase();
    const row = await findOwned(institutionId, scholarshipId);
    const [enriched] = await withLabels(institutionId, [row]);
    return serialize(enriched);
  },

  async create(
    institutionId: string,
    input: CreateScholarshipInput,
    actor: { id: string; name: string },
  ): Promise<ScholarshipDTO> {
    await connectToDatabase();

    const count = await Scholarship.countDocuments({ institutionId });
    if (count >= SCHOLARSHIP_MAX_PER_INSTITUTION) {
      throw validationError(
        `You can keep up to ${SCHOLARSHIP_MAX_PER_INSTITUTION} scholarships. Delete one to add another.`,
      );
    }

    const unit = await assertOwnedAcademicUnit(institutionId, input.academicUnitId);

    const created = await Scholarship.create({ ...input, institutionId, status: "DRAFT" });

    await ActivityService.record({
      institutionId,
      entityType: "SCHOLARSHIP",
      entityId: created._id,
      entityRef: institutionId,
      action: "Scholarship created",
      description: `${input.name} created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize({
      ...(created.toObject() as ScholarshipDoc),
      // Derived inline from the unit already loaded above rather than via
      // `withLabels`, which would re-query it. The two must agree: any change
      // to how `withLabels` builds a label belongs here too, or a create
      // response will disagree with the very next read.
      classOrCourse: unit?.pathLabel,
    });
  },

  async update(
    institutionId: string,
    scholarshipId: string,
    patch: UpdateScholarshipInput,
    actor: { id: string; name: string },
  ): Promise<ScholarshipDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, scholarshipId);

    await assertOwnedAcademicUnit(institutionId, patch.academicUnitId);

    const set = stripUndefined(patch);

    // A published scholarship must stay publishable: a patch that blanks the
    // name would otherwise leave it publicly visible with no name.
    const merged = { ...before, ...set };
    if (before.status === "PUBLISHED") {
      assertScholarshipPublishable({ name: merged.name });
    }

    const updated = await Scholarship.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<ScholarshipDoc>();
    if (!updated) throw notFound("Scholarship not found");
    const [enriched] = await withLabels(institutionId, [updated]);

    await ActivityService.record({
      institutionId,
      entityType: "SCHOLARSHIP",
      entityId: updated._id,
      entityRef: institutionId,
      action: "Scholarship updated",
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(enriched);
  },

  async setStatus(
    institutionId: string,
    scholarshipId: string,
    action: "publish" | "unpublish" | "archive",
    actor: { id: string; name: string },
  ): Promise<ScholarshipDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, scholarshipId);

    const status = action === "publish" ? "PUBLISHED" : action === "archive" ? "ARCHIVED" : "DRAFT";

    if (action === "publish") {
      assertScholarshipPublishable({ name: before.name });
    }

    const set: Record<string, unknown> = { status };
    // Stamped on first publication and never moved: it records when this
    // scholarship was first made public, not when it was last touched.
    if (action === "publish" && !before.publishedAt) set.publishedAt = new Date();

    const updated = await Scholarship.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<ScholarshipDoc>();
    if (!updated) throw notFound("Scholarship not found");
    const [enriched] = await withLabels(institutionId, [updated]);

    await ActivityService.record({
      institutionId,
      entityType: "SCHOLARSHIP",
      entityId: updated._id,
      entityRef: institutionId,
      action: `Scholarship ${ACTION_LABELS[action]}`,
      description: enriched.name,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(enriched);
  },

  async remove(
    institutionId: string,
    scholarshipId: string,
    actor: { id: string; name: string },
  ): Promise<void> {
    await connectToDatabase();
    const before = await findOwned(institutionId, scholarshipId);

    await Scholarship.deleteOne({ _id: before._id, institutionId });

    await ActivityService.record({
      institutionId,
      entityType: "SCHOLARSHIP",
      entityId: before._id,
      entityRef: institutionId,
      action: "Scholarship deleted",
      description: `${before.name} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },
};
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/integration/scholarship-crud.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Mutation-check the tenant scoping**

Delete `institutionId` from `findOwned`'s filter:

```ts
  const row = await Scholarship.findOne({
    _id: toObjectId(scholarshipId),
  }).lean<ScholarshipDoc>();
```

Print evidence the deletion landed before running anything:

```bash
sed -n '/async function findOwned/,/^}/p' src/services/scholarship.service.ts
```

Expected: no `institutionId` inside the `findOne` object.

Run: `npx vitest run tests/integration/scholarship-crud.test.ts`
Expected: FAIL — "treats another institution's scholarship as NOT_FOUND, never FORBIDDEN" fails, and it is the only failure. If anything else fails, or that one passes, stop and report.

Restore, then re-run (11 passing) and re-run the `sed` to confirm `institutionId` is back. Do **not** use `git diff --quiet` as the restore check — this file is uncommitted, so it reports a diff either way and proves nothing.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/services/scholarship.service.ts tests/integration/scholarship-crud.test.ts
git commit -m "feat: add the Scholarship service"
```

---

## Task 5: Scholarship routes (dashboard + public)

**Files:**
- Create: `src/app/api/settings/scholarships/route.ts`
- Create: `src/app/api/settings/scholarships/[scholarshipId]/route.ts`
- Create: `src/app/api/settings/scholarships/[scholarshipId]/publish/route.ts`
- Create: `src/app/api/public/[institutionId]/scholarships/route.ts`
- Create: `src/app/api/public/institutions/[slug]/scholarships/route.ts`
- Test: `tests/integration/scholarship-routes.test.ts`, `tests/integration/scholarship-public.test.ts`

**Interfaces:**
- Consumes: `ScholarshipService` (Task 4), `createScholarshipSchema`/`updateScholarshipSchema` (Task 2).
- Produces: the five HTTP routes above.

- [ ] **Step 1: Write the dashboard route**

Create `src/app/api/settings/scholarships/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { createScholarshipSchema } from "@/lib/validation/scholarship";
import { ScholarshipService } from "@/services/scholarship.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const scholarships = await ScholarshipService.list(institution.institutionId);
    return jsonSuccess({ scholarships });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = createScholarshipSchema.parse(await request.json().catch(() => ({})));

    const scholarship = await ScholarshipService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ scholarship }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 2: Write the item route**

Create `src/app/api/settings/scholarships/[scholarshipId]/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateScholarshipSchema } from "@/lib/validation/scholarship";
import { ScholarshipService } from "@/services/scholarship.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/settings/scholarships/[scholarshipId]">,
) {
  try {
    const { scholarshipId } = await context.params;
    const { institution } = await requireInstitution();
    const scholarship = await ScholarshipService.get(institution.institutionId, scholarshipId);
    return jsonSuccess({ scholarship });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/scholarships/[scholarshipId]">,
) {
  try {
    assertSameOrigin(request);
    const { scholarshipId } = await context.params;
    const { user, institution } = await requireInstitution();
    const input = updateScholarshipSchema.parse(await request.json().catch(() => ({})));

    const scholarship = await ScholarshipService.update(
      institution.institutionId,
      scholarshipId,
      input,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ scholarship });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/scholarships/[scholarshipId]">,
) {
  try {
    assertSameOrigin(request);
    const { scholarshipId } = await context.params;
    const { user, institution } = await requireInstitution();

    await ScholarshipService.remove(institution.institutionId, scholarshipId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 3: Write the publish route**

Create `src/app/api/settings/scholarships/[scholarshipId]/publish/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { ScholarshipService } from "@/services/scholarship.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const ACTIONS = ["publish", "unpublish", "archive"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/settings/scholarships/[scholarshipId]/publish">,
) {
  try {
    assertSameOrigin(request);
    const { scholarshipId } = await context.params;
    const { user, institution } = await requireInstitution();

    const body = (await request.json().catch(() => ({}))) as { action?: string };
    if (!ACTIONS.includes(body.action as Action)) {
      throw validationError(`action: must be one of ${ACTIONS.join(", ")}`);
    }

    const scholarship = await ScholarshipService.setStatus(
      institution.institutionId,
      scholarshipId,
      body.action as Action,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ scholarship });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: Write the two public routes**

Create `src/app/api/public/[institutionId]/scholarships/route.ts`:

```ts
import { ScholarshipService } from "@/services/scholarship.service";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "public, max-age=300" };

/**
 * Credential-free. A draft scholarship, an archived one, a suspended
 * institution and a nonexistent institution are indistinguishable here:
 * there is no 403 branch to write, because none exists.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/public/[institutionId]/scholarships">,
) {
  try {
    const { institutionId } = await context.params;

    // Keyed on IP only — never on institutionId, so one institution's traffic
    // cannot exhaust another's allowance.
    const limit = await consumeRateLimit(
      `public-scholarships:${getClientIp(request)}`,
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

    const scholarships = await ScholarshipService.listPublic({ institutionId });
    if (scholarships === null) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: HEADERS });
    }

    return jsonSuccess({ scholarships }, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, HEADERS);
  }
}

export async function OPTIONS() {
  return publicCorsPreflight();
}
```

Create `src/app/api/public/institutions/[slug]/scholarships/route.ts` — identical, except the params type is `RouteContext<"/api/public/institutions/[slug]/scholarships">`, it destructures `{ slug }`, the rate-limit key is `public-scholarships-slug:`, and it calls `ScholarshipService.listPublic({ slug })`. Read `src/app/api/public/institutions/[slug]/fees/route.ts` and mirror it exactly.

- [ ] **Step 5: Write the route tests**

Create `tests/integration/scholarship-routes.test.ts`. Model it on `tests/integration/fee-structure-routes.test.ts` — read that file first and mirror its session-mocking and CSRF-header setup exactly rather than inventing one. Cover:

1. `GET` (collection) returns only the calling institution's scholarships.
2. `GET` (item) returns one; another institution's id returns 404.
3. `POST` creates one and returns 201.
4. `POST` without a same-origin header is refused (the CSRF guard).
5. `PATCH` updates one.
6. `PATCH` on another institution's scholarship returns 404.
7. `DELETE` removes one.
8. `POST …/publish` with `{ action: "publish" }` publishes.
9. `POST …/publish` with `{ action: "nonsense" }` returns a validation error.

Case 4 matters most and is the easiest to write hollow: assert the CSRF-refused request returns a non-2xx **and** that the scholarship count is unchanged afterwards. A test that only checks the status code passes even if the write went through.

- [ ] **Step 6: Write the public route test**

Create `tests/integration/scholarship-public.test.ts`, modelled on `tests/integration/fee-structure-public.test.ts` (read it first; it uses `makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" })` and calls the route function directly with `{ params: Promise.resolve({ institutionId: "INS0001" }) } as never`). Cover:

1. A published scholarship is returned by `institutionId`.
2. A published scholarship is returned by `slug`.
3. A DRAFT scholarship is absent.
4. An institution whose `profileStatus` is `DRAFT` returns 404.
5. An inactive institution returns 404.
6. The response carries no `institutionId`, `status`, or `_id` on any row.

- [ ] **Step 7: Run both, typecheck, commit**

```bash
npx vitest run tests/integration/scholarship-routes.test.ts tests/integration/scholarship-public.test.ts
npx tsc --noEmit
git add src/app/api/settings/scholarships src/app/api/public/[institutionId]/scholarships "src/app/api/public/institutions/[slug]/scholarships" tests/integration/scholarship-routes.test.ts tests/integration/scholarship-public.test.ts
git commit -m "feat: add the scholarship dashboard and public routes"
```

---

## Task 6: Offer model and validation

**Files:**
- Create: `src/models/Offer.ts`
- Modify: `src/models/index.ts`
- Create: `src/lib/validation/offer.ts`
- Test: `tests/unit/offer-model.test.ts`, `tests/unit/offer-validation.test.ts`

**Interfaces:**
- Consumes: `OFFER_STATUSES`, `OFFER_KINDS` from Task 1.
- Produces: `Offer` model, `OfferDoc` type; `createOfferSchema`, `updateOfferSchema`, `CreateOfferInput`, `UpdateOfferInput`, `assertOfferInvariants`, `assertOfferPublishable`.

- [ ] **Step 1: Write the failing model test**

Create `tests/unit/offer-model.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { Offer } from "@/models";

beforeAll(async () => {
  await startTestDatabase("offer-model");
  await Offer.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

const base = { institutionId: "INS0001", title: "Early bird", kind: "PERCENTAGE", value: 15 };

describe("Offer model", () => {
  it("defaults a new offer to DRAFT with no publishedAt", async () => {
    const created = await Offer.create(base);

    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();
  });

  it("requires a title, a kind and a value", async () => {
    await expect(Offer.create({ institutionId: "INS0001" })).rejects.toThrow();
    await expect(Offer.create({ ...base, title: undefined })).rejects.toThrow();
    await expect(Offer.create({ ...base, kind: undefined })).rejects.toThrow();
    await expect(Offer.create({ ...base, value: undefined })).rejects.toThrow();
  });

  it("rejects a kind outside the enum", async () => {
    await expect(Offer.create({ ...base, kind: "BOGOF" })).rejects.toThrow();
  });

  it("rejects a negative value", async () => {
    await expect(Offer.create({ ...base, value: -1 })).rejects.toThrow();
  });

  it("leaves validFrom and validUntil unset when absent", async () => {
    const created = await Offer.create(base);

    expect(created.validFrom).toBeUndefined();
    expect(created.validUntil).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/unit/offer-model.test.ts`
Expected: FAIL — `Offer` is not exported from `@/models`.

- [ ] **Step 3: Create the model**

Create `src/models/Offer.ts`:

```ts
import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { OFFER_KINDS, OFFER_STATUSES } from "@/lib/constants";

const OfferSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    kind: { type: String, enum: OFFER_KINDS, required: true },
    /** Percent (0-100) when kind is PERCENTAGE; rupees (>= 0) when FLAT. */
    value: { type: Number, required: true, min: 0 },
    /**
     * Published as text and never validated or counted — IDAP has no student
     * accounts, so there is no identity to redeem against. The institution
     * honours it offline.
     */
    code: { type: String, trim: true },
    /** Absent means the offer applies institution-wide. No `ref` — see Scholarship. */
    academicUnitId: { type: Schema.Types.ObjectId, index: true },
    validFrom: { type: Date },
    /** Absent means the offer never expires. See the service's listPublic filter. */
    validUntil: { type: Date },
    status: { type: String, enum: OFFER_STATUSES, default: "DRAFT" },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

OfferSchema.index({ institutionId: 1, createdAt: -1 });
OfferSchema.index({ institutionId: 1, status: 1, validUntil: 1 });

export type OfferDoc = InferSchemaType<typeof OfferSchema> & { _id: Types.ObjectId };

export const Offer: Model<OfferDoc> =
  (models.Offer as Model<OfferDoc>) ?? model<OfferDoc>("Offer", OfferSchema);
```

There is deliberately **no `active` flag**: FeesBasket carries both `active` and a validity window, which can contradict each other. `status` already means "is this live", and expiry is derived at read time.

- [ ] **Step 4: Export it**

Add to `src/models/index.ts`:

```ts
export { Offer, type OfferDoc } from "./Offer";
```

- [ ] **Step 5: Run the model test**

Run: `npx vitest run tests/unit/offer-model.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the failing validation test**

Create `tests/unit/offer-validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assertOfferInvariants,
  assertOfferPublishable,
  createOfferSchema,
  updateOfferSchema,
} from "@/lib/validation/offer";

describe("createOfferSchema", () => {
  it("accepts a minimal offer", () => {
    const parsed = createOfferSchema.parse({ title: "Early bird", kind: "PERCENTAGE", value: 15 });
    expect(parsed.value).toBe(15);
  });

  it("rejects a kind outside the enum", () => {
    expect(() => createOfferSchema.parse({ title: "X", kind: "BOGOF", value: 1 })).toThrow();
  });

  it("rejects a negative value", () => {
    expect(() =>
      createOfferSchema.parse({ title: "X", kind: "FLAT", value: -1 }),
    ).toThrow();
  });

  it("coerces ISO date strings into Dates", () => {
    const parsed = createOfferSchema.parse({
      title: "X",
      kind: "FLAT",
      value: 1,
      validUntil: "2026-03-31",
    });
    expect(parsed.validUntil).toBeInstanceOf(Date);
  });

  it("strips status so a create cannot set it", () => {
    const parsed = createOfferSchema.parse({
      title: "X",
      kind: "FLAT",
      value: 1,
      status: "PUBLISHED",
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("status");
  });
});

describe("updateOfferSchema", () => {
  it("strips status so a PATCH cannot skip the publish gate", () => {
    const parsed = updateOfferSchema.parse({ status: "PUBLISHED" }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("status");
  });
});

describe("assertOfferInvariants", () => {
  it("accepts a percentage of exactly 100", () => {
    expect(() => assertOfferInvariants({ kind: "PERCENTAGE", value: 100 })).not.toThrow();
  });

  it("rejects a percentage above 100", () => {
    expect(() => assertOfferInvariants({ kind: "PERCENTAGE", value: 101 })).toThrow(
      /cannot exceed 100/,
    );
  });

  it("allows a FLAT value above 100 — rupees, not percent", () => {
    expect(() => assertOfferInvariants({ kind: "FLAT", value: 25000 })).not.toThrow();
  });

  it("rejects an end date before the start date", () => {
    expect(() =>
      assertOfferInvariants({
        kind: "FLAT",
        value: 1,
        validFrom: new Date("2026-06-01"),
        validUntil: new Date("2026-05-01"),
      }),
    ).toThrow(/cannot fall before the start date/);
  });

  it("accepts an end date equal to the start date", () => {
    const day = new Date("2026-06-01");
    expect(() =>
      assertOfferInvariants({ kind: "FLAT", value: 1, validFrom: day, validUntil: day }),
    ).not.toThrow();
  });

  it("does not fire the date rule when only ONE bound is given", () => {
    expect(() =>
      assertOfferInvariants({ kind: "FLAT", value: 1, validUntil: new Date("2020-01-01") }),
    ).not.toThrow();
    expect(() =>
      assertOfferInvariants({ kind: "FLAT", value: 1, validFrom: new Date("2030-01-01") }),
    ).not.toThrow();
  });
});

describe("assertOfferPublishable", () => {
  it("passes a complete offer", () => {
    expect(() =>
      assertOfferPublishable({ title: "Early bird", kind: "PERCENTAGE", value: 15 }),
    ).not.toThrow();
  });

  it("rejects a blank title", () => {
    expect(() => assertOfferPublishable({ title: "  ", kind: "FLAT", value: 1 })).toThrow(
      /title: give this offer a title/,
    );
  });

  it("rejects a zero value — a 0% discount is meaningless", () => {
    expect(() => assertOfferPublishable({ title: "X", kind: "PERCENTAGE", value: 0 })).toThrow(
      /value: set a discount greater than zero/,
    );
  });

  it("still enforces the base invariants", () => {
    expect(() =>
      assertOfferPublishable({ title: "X", kind: "PERCENTAGE", value: 150 }),
    ).toThrow(/cannot exceed 100/);
  });
});
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `npx vitest run tests/unit/offer-validation.test.ts`
Expected: FAIL — cannot resolve `@/lib/validation/offer`.

- [ ] **Step 8: Write the validation module**

Create `src/lib/validation/offer.ts`:

```ts
import { z } from "zod";
import { OFFER_KINDS } from "@/lib/constants";
import { validationError } from "@/lib/api/errors";
import { objectIdString, requiredText } from "./common";

export const createOfferSchema = z.object({
  title: requiredText("Offer title", 120),
  description: z.string().trim().max(600).optional(),
  kind: z.enum(OFFER_KINDS),
  value: z.number().min(0, "Must be 0 or more"),
  code: z.string().trim().max(40).optional(),
  academicUnitId: objectIdString.optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
});
export type CreateOfferInput = z.infer<typeof createOfferSchema>;

/** `status` is absent so a PATCH cannot skip the publish gate — Zod strips it. */
export const updateOfferSchema = createOfferSchema.partial();
export type UpdateOfferInput = z.infer<typeof updateOfferSchema>;

export type OfferInvariantInput = {
  kind: string;
  value: number;
  validFrom?: Date | null;
  validUntil?: Date | null;
};

/**
 * Cross-field rules, checked against the MERGED record rather than the request
 * body — a PATCH carrying only `validUntil` has no `validFrom` of its own to
 * compare against, so the service merges first and calls this second.
 */
export function assertOfferInvariants(input: OfferInvariantInput): void {
  if (input.kind === "PERCENTAGE" && input.value > 100) {
    throw validationError("value: a percentage discount cannot exceed 100");
  }

  // Guarded on BOTH bounds being given: an absent bound means "unreported",
  // not "zero" or "epoch". A `?? new Date(0)` here would manufacture a false
  // violation on an offer with only an end date.
  if (input.validFrom != null && input.validUntil != null && input.validUntil < input.validFrom) {
    throw validationError("validUntil: the end date cannot fall before the start date");
  }
}

/**
 * The publish gate. Stricter than `assertOfferInvariants`, which a draft may
 * still satisfy while incomplete.
 */
export function assertOfferPublishable(input: OfferInvariantInput & { title?: string | null }): void {
  assertOfferInvariants(input);

  if (!input.title?.trim()) {
    throw validationError("title: give this offer a title before publishing it");
  }

  if (input.value <= 0) {
    throw validationError("value: set a discount greater than zero before publishing this offer");
  }
}
```

- [ ] **Step 9: Run both tests**

Run: `npx vitest run tests/unit/offer-model.test.ts tests/unit/offer-validation.test.ts`
Expected: PASS, 21 tests total.

- [ ] **Step 10: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/models/Offer.ts src/models/index.ts src/lib/validation/offer.ts tests/unit/offer-model.test.ts tests/unit/offer-validation.test.ts
git commit -m "feat: add the Offer model and its validation"
```

---

## Task 7: Offer public projection

**Files:**
- Create: `src/lib/offer/public-projection.ts`
- Test: `tests/unit/offer-projection.test.ts`

**Interfaces:**
- Produces: `toPublicOffer(doc: Record<string, unknown>)` returning `PublicOffer | null`, and the `PublicOffer` type.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/offer-projection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toPublicOffer } from "@/lib/offer/public-projection";

const published = {
  _id: "aaa",
  institutionId: "INS0001",
  academicUnitId: "bbb",
  title: "Early bird",
  description: "Book before March",
  kind: "PERCENTAGE",
  value: 15,
  code: "EARLY15",
  classOrCourse: "Grade 10",
  validFrom: new Date("2026-01-01T00:00:00.000Z"),
  validUntil: new Date("2026-03-31T00:00:00.000Z"),
  status: "PUBLISHED",
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  createdAt: new Date("2025-12-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

describe("toPublicOffer", () => {
  it("emits exactly the allowed top-level keys and no others", () => {
    const result = toPublicOffer(published);

    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        "classOrCourse",
        "code",
        "description",
        "kind",
        "publishedAt",
        "title",
        "validFrom",
        "validUntil",
        "value",
      ].sort(),
    );
  });

  it("never emits internal fields", () => {
    const result = toPublicOffer(published) as Record<string, unknown>;

    expect(result).not.toHaveProperty("_id");
    expect(result).not.toHaveProperty("institutionId");
    expect(result).not.toHaveProperty("academicUnitId");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("returns null for a draft offer", () => {
    expect(toPublicOffer({ ...published, status: "DRAFT" })).toBeNull();
  });

  it("returns null for an archived offer", () => {
    expect(toPublicOffer({ ...published, status: "ARCHIVED" })).toBeNull();
  });

  it("emits value as a number and dates as ISO strings", () => {
    const result = toPublicOffer(published);

    expect(result?.value).toBe(15);
    expect(result?.validUntil).toBe("2026-03-31T00:00:00.000Z");
  });

  it("does NOT re-check expiry — the query is the single enforcement point", () => {
    const expired = { ...published, validUntil: new Date("2020-01-01T00:00:00.000Z") };

    expect(toPublicOffer(expired)).not.toBeNull();
  });

  it("does not leak a field added to the document but not to the allow-list", () => {
    const result = toPublicOffer({
      ...published,
      internalMargin: 0.4,
    }) as Record<string, unknown>;

    expect(result).not.toHaveProperty("internalMargin");
  });
});
```

The "does NOT re-check expiry" test is a deliberate pin on a design decision, not an oversight: a projection that reads the clock cannot be tested deterministically, so expiry lives in the query (Task 8) and this test documents why the projection is silent about it.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/unit/offer-projection.test.ts`
Expected: FAIL — cannot resolve `@/lib/offer/public-projection`.

- [ ] **Step 3: Write the projection**

Create `src/lib/offer/public-projection.ts`:

```ts
/**
 * The only path from an Offer document to a public response.
 *
 * This is an allow-list: it names the fields that may leave. A field added to
 * the schema is private until someone deliberately adds it here. Rewriting
 * this as a spread with deletions would leak every future field on the day it
 * was added — a test exists specifically to catch that.
 *
 * Only a PUBLISHED offer is ever projected. Expiry is deliberately NOT checked
 * here: it lives in the service's query, because a projection that reads the
 * clock cannot be tested deterministically.
 */
type Doc = Record<string, unknown>;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const iso = (value: unknown): string | undefined =>
  value instanceof Date ? value.toISOString() : text(value);

export type PublicOffer = NonNullable<ReturnType<typeof toPublicOffer>>;

export function toPublicOffer(offer: Doc) {
  const doc = offer ?? {};

  if (doc.status !== "PUBLISHED") return null;

  return {
    title: text(doc.title),
    description: text(doc.description),
    kind: text(doc.kind),
    value: num(doc.value),
    code: text(doc.code),
    /** Absent for an institution-wide offer — `text` drops the empty string. */
    classOrCourse: text(doc.classOrCourse),
    validFrom: iso(doc.validFrom),
    validUntil: iso(doc.validUntil),
    publishedAt: iso(doc.publishedAt),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/offer-projection.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/offer/public-projection.ts tests/unit/offer-projection.test.ts
git commit -m "feat: add the Offer public projection allow-list"
```

---

## Task 8: Offer service

**Files:**
- Create: `src/services/offer.service.ts`
- Test: `tests/integration/offer-crud.test.ts`

**Interfaces:**
- Consumes: `Offer`/`OfferDoc` (Task 6), `assertOfferInvariants`/`assertOfferPublishable`/`CreateOfferInput`/`UpdateOfferInput` (Task 6), `toPublicOffer`/`PublicOffer` (Task 7), `assertOwnedAcademicUnit` (Task 1), `OFFER_MAX_PER_INSTITUTION` (Task 1).
- Produces: `OfferService` with `list`, `listPublic`, `get`, `create`, `update`, `setStatus`, `remove`; and `OfferDTO`.

**Interface contract for `OfferDTO`:**

```ts
export type OfferDTO = {
  id: string;
  title: string;
  description?: string;
  kind: string;
  value: number;
  code?: string;
  academicUnitId?: string;
  classOrCourse?: string;
  validFrom?: string;
  validUntil?: string;
  status: string;
  publishedAt?: string;
  updatedAt?: string;
};
```

- [ ] **Step 1: Write the failing test**

Create `tests/integration/offer-crud.test.ts`. Mirror `tests/integration/scholarship-crud.test.ts`'s structure from Task 4 (same `beforeEach` institution/unit setup, same `actor`), covering:

1. Creates an institution-wide offer and reads it back — `status` is `DRAFT`, `classOrCourse` undefined.
2. Derives `classOrCourse` live from the unit, and follows a unit rename.
3. Refuses another institution's `academicUnitId` as `NOT_FOUND`.
4. Lists only the calling institution's offers.
5. Another institution's offer is `NOT_FOUND`, never `FORBIDDEN`.
6. A malformed id is `NOT_FOUND`, not a cast error.
7. Refuses a create with `kind: "PERCENTAGE", value: 101`.
8. Refuses a create where `validUntil` precedes `validFrom`.
9. Publishing stamps `publishedAt`; republishing keeps the first stamp.
10. Refuses to publish an offer whose `value` is 0.
11. Refuses to create beyond `OFFER_MAX_PER_INSTITUTION` (40).
12. Deletes an offer.

Plus the three expiry tests, which are this service's distinguishing behaviour:

```ts
  it("listPublic includes an offer whose validUntil is in the future", async () => {
    await makeProfiledInstitution("INS0003", { profileStatus: "PUBLISHED" });
    const created = await OfferService.create(
      "INS0003",
      {
        title: "Future",
        kind: "PERCENTAGE",
        value: 10,
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      actor,
    );
    await OfferService.setStatus("INS0003", created.id, "publish", actor);

    const list = await OfferService.listPublic({ institutionId: "INS0003" });

    expect(list).toHaveLength(1);
    expect(list?.[0]?.title).toBe("Future");
  });

  it("listPublic drops an expired offer while the dashboard list keeps it", async () => {
    await makeProfiledInstitution("INS0003", { profileStatus: "PUBLISHED" });
    const created = await OfferService.create(
      "INS0003",
      { title: "Expired", kind: "PERCENTAGE", value: 10 },
      actor,
    );
    await OfferService.setStatus("INS0003", created.id, "publish", actor);
    // Set the past date directly: creating with it would be refused only if a
    // validFrom were also present, but writing it here keeps the test honest
    // about what it is exercising — the READ filter, not the write rules.
    await Offer.updateOne(
      { _id: created.id },
      { $set: { validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    );

    expect(await OfferService.listPublic({ institutionId: "INS0003" })).toHaveLength(0);
    // The institution still needs to see and re-date it.
    expect(await OfferService.list("INS0003")).toHaveLength(1);
  });

  it("listPublic includes an offer with no validUntil at all", async () => {
    await makeProfiledInstitution("INS0003", { profileStatus: "PUBLISHED" });
    const created = await OfferService.create(
      "INS0003",
      { title: "Evergreen", kind: "FLAT", value: 5000 },
      actor,
    );
    await OfferService.setStatus("INS0003", created.id, "publish", actor);

    const list = await OfferService.listPublic({ institutionId: "INS0003" });

    expect(list).toHaveLength(1);
  });
```

This test file needs `makeProfiledInstitution` imported alongside `makeInstitution`, and `Offer` imported from `@/models`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/integration/offer-crud.test.ts`
Expected: FAIL — cannot resolve `@/services/offer.service`.

- [ ] **Step 3: Write the service**

Create `src/services/offer.service.ts` as a direct structural copy of `src/services/scholarship.service.ts` (Task 4), with these differences:

- `Offer`/`OfferDoc`/`OfferDTO`/`OfferRow` throughout; `entityType: "OFFER"`; activity actions read "Offer created/updated/published/…"; `notFound("Offer not found")`; cap constant `OFFER_MAX_PER_INSTITUTION`.
- `serialize` additionally emits `kind`, `value`, `code`, `validFrom?.toISOString()`, `validUntil?.toISOString()`.
- `create` calls `assertOfferInvariants({ kind: input.kind, value: input.value, validFrom: input.validFrom, validUntil: input.validUntil })` **before** the cap check and the unit check.
- `update` merges first, then calls `assertOfferPublishable` when `before.status === "PUBLISHED"`, else `assertOfferInvariants` — mirroring how `fee-structure.service.ts`'s `update` picks its gate.
- `setStatus` calls `assertOfferPublishable({ title: before.title, kind: before.kind, value: before.value, validFrom: before.validFrom, validUntil: before.validUntil })` on publish.
- `listPublic` adds the expiry filter:

```ts
    const rows = await Offer.find({
      institutionId: institution.institutionId,
      status: "PUBLISHED",
      // Two clauses, not three: `{ validUntil: null }` matches an ABSENT field
      // as well as an explicitly-null one, so a separate `$exists: false`
      // clause would be redundant. Verified against mongodb-memory-server.
      $or: [{ validUntil: null }, { validUntil: { $gte: new Date() } }],
    })
      .sort({ createdAt: -1 })
      .lean<OfferDoc[]>();
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/integration/offer-crud.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Mutation-check the expiry filter**

This is the behaviour with the most ways to be silently wrong. Temporarily remove the `$or` clause from `listPublic`'s filter.

Print evidence first:

```bash
grep -n "validUntil" src/services/offer.service.ts
```

Expected: no `$or`/`validUntil` line inside `listPublic`'s `find`.

Run: `npx vitest run tests/integration/offer-crud.test.ts`
Expected: FAIL — "listPublic drops an expired offer while the dashboard list keeps it" fails, and is the **only** failure. In particular "includes an offer with no validUntil at all" must still PASS, proving that test is not accidentally passing because of the filter.

Restore it, re-run (15 passing), and re-run the grep to confirm the `$or` is back. Do not use `git diff --quiet` — the file is uncommitted.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/services/offer.service.ts tests/integration/offer-crud.test.ts
git commit -m "feat: add the Offer service with read-time expiry filtering"
```

---

## Task 9: Offer routes (dashboard + public)

**Files:**
- Create: `src/app/api/settings/offers/route.ts`
- Create: `src/app/api/settings/offers/[offerId]/route.ts`
- Create: `src/app/api/settings/offers/[offerId]/publish/route.ts`
- Create: `src/app/api/public/[institutionId]/offers/route.ts`
- Create: `src/app/api/public/institutions/[slug]/offers/route.ts`
- Test: `tests/integration/offer-routes.test.ts`, `tests/integration/offer-public.test.ts`

**Interfaces:**
- Consumes: `OfferService` (Task 8), `createOfferSchema`/`updateOfferSchema` (Task 6).

- [ ] **Step 1: Write the five routes**

Each is a direct copy of its scholarship counterpart from Task 5, with `Offer`/`offers`/`offerId` substituted throughout, `OfferService` in place of `ScholarshipService`, `createOfferSchema`/`updateOfferSchema` in place of the scholarship schemas, and rate-limit keys `public-offers:` / `public-offers-slug:`.

The `RouteContext` type parameters must match the real paths exactly:
`RouteContext<"/api/settings/offers/[offerId]">`,
`RouteContext<"/api/settings/offers/[offerId]/publish">`,
`RouteContext<"/api/public/[institutionId]/offers">`,
`RouteContext<"/api/public/institutions/[slug]/offers">`.

- [ ] **Step 2: Write the route tests**

Create `tests/integration/offer-routes.test.ts` mirroring `tests/integration/scholarship-routes.test.ts` from Task 5, covering the same nine cases with offer payloads (`{ title: "Early bird", kind: "PERCENTAGE", value: 15 }`), plus one more:

10. `POST` with `{ title: "X", kind: "PERCENTAGE", value: 150 }` returns a validation error, proving the invariant runs on the route path and not only in a direct service call.

- [ ] **Step 3: Write the public route test**

Create `tests/integration/offer-public.test.ts` mirroring `tests/integration/scholarship-public.test.ts`, covering the same six cases plus:

7. An expired published offer is absent from the public response while a non-expired one on the same institution is present.

- [ ] **Step 4: Run, typecheck, commit**

```bash
npx vitest run tests/integration/offer-routes.test.ts tests/integration/offer-public.test.ts
npx tsc --noEmit
git add src/app/api/settings/offers src/app/api/public/[institutionId]/offers "src/app/api/public/institutions/[slug]/offers" tests/integration/offer-routes.test.ts tests/integration/offer-public.test.ts
git commit -m "feat: add the offer dashboard and public routes"
```

---

## Task 10: Scholarship UI

**Files:**
- Create: `src/components/scholarships/scholarship-status-badge.tsx`
- Create: `src/components/scholarships/scholarship-form.tsx`
- Create: `src/components/scholarships/scholarship-actions.tsx`
- Create: `src/components/scholarships/scholarships-list-view.tsx`
- Create: `src/app/(dashboard)/scholarships/page.tsx`
- Create: `src/app/(dashboard)/scholarships/new/page.tsx`
- Create: `src/app/(dashboard)/scholarships/[scholarshipId]/page.tsx`

**Interfaces:**
- Consumes: `ScholarshipService`, `ScholarshipDTO` (Task 4); `AcademicStructureService.list`, `flattenTree`, `inactiveIds`; `SCHOLARSHIP_STATUS_LABELS`, `ScholarshipStatus` (Task 1).

Read these four files first and mirror them closely — this task is a translation, not a design exercise:
`src/components/fees/fee-structure-status-badge.tsx`,
`src/components/fees/fee-structure-form.tsx`,
`src/components/fees/fee-structure-actions.tsx`,
`src/components/fees/fee-structures-list-view.tsx`,
plus the three pages under `src/app/(dashboard)/fees/`.

- [ ] **Step 1: Write the status badge**

Create `src/components/scholarships/scholarship-status-badge.tsx`:

```tsx
import { cn } from "@/lib/utils";
import { SCHOLARSHIP_STATUS_LABELS, type ScholarshipStatus } from "@/lib/constants";

/**
 * The same fill-weight tone vocabulary as `fee-structure-status-badge.tsx`:
 * DRAFT hasn't been shown to anyone yet, PUBLISHED is the terminal, positive
 * state the public API reads from, ARCHIVED is withdrawn.
 */
const TONE: Record<ScholarshipStatus, string> = {
  DRAFT: "border-foreground/25 bg-background text-foreground",
  PUBLISHED: "border-transparent bg-foreground text-background",
  ARCHIVED: "border-dashed border-border bg-background text-muted-foreground",
};

export function ScholarshipStatusBadge({ status }: { status: ScholarshipStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE[status],
      )}
    >
      {SCHOLARSHIP_STATUS_LABELS[status]}
    </span>
  );
}
```

Note the cast at the call sites: `ScholarshipDTO.status` is typed `string` at the service layer (DTOs never narrow enums in this codebase), so pages pass `status={scholarship.status as ScholarshipStatus}`. Use that named cast — never `as never`, which is only correct for generic components.

- [ ] **Step 2: Write the form**

Create `src/components/scholarships/scholarship-form.tsx`, following `fee-structure-form.tsx`'s conventions exactly:

- `useForm<Values>` where `Values = z.input<typeof createScholarshipSchema>`, `zodResolver(isEditing ? updateScholarshipSchema : createScholarshipSchema) as unknown as Resolver<Values>`.
- Fields: `name` (Input, `register`), `criteria` (Textarea, `register`), `amount` (Input with placeholder `"e.g. 100% tuition, or Up to ₹50,000"`, `register`), and the academic-unit `Select`.
- The unit `Select` is driven by `watch("academicUnitId")` / `setValue(...)`, **never** `register()`. It carries an explicit first option representing institution-wide:

```tsx
<SelectItem value={ALL_UNITS}>All classes and courses</SelectItem>
```

where `const ALL_UNITS = "__all__";` — a sentinel that never collides with an ObjectId. On submit, map it back:

```ts
const payload = {
  ...values,
  academicUnitId: values.academicUnitId === ALL_UNITS ? undefined : values.academicUnitId,
};
```

This mapping is why the form cannot simply hand `values` to `fetch` — send `payload`.

- Submits `POST /api/settings/scholarships` when creating (then `router.push("/scholarships/" + payload.scholarship.id)`), `PATCH /api/settings/scholarships/<id>` when editing (then `router.refresh()`), with `toast.success`/`toast.error` exactly as `fee-structure-form.tsx` does.
- Unlike the fee form, the unit **is** editable while editing (it carries no unique key), so there is no read-only branch.

- [ ] **Step 3: Write the actions component**

Create `src/components/scholarships/scholarship-actions.tsx`, mirroring `fee-structure-actions.tsx`: Publish / Unpublish / Archive buttons posting to `/api/settings/scholarships/<id>/publish` with `{ action }`, and a Delete button calling `DELETE /api/settings/scholarships/<id>` behind the same confirmation dialog that file already uses, then `router.push("/scholarships")`.

- [ ] **Step 4: Write the list view**

Create `src/components/scholarships/scholarships-list-view.tsx`, mirroring `fee-structures-list-view.tsx`'s table shape. Columns: Name, Applies to (`classOrCourse ?? "All classes and courses"`), Amount, Status badge, Updated. Rows link to `/scholarships/<id>`. Empty state uses the shared `EmptyState` with `actionLabel="Add a scholarship"` / `actionHref="/scholarships/new"`.

- [ ] **Step 5: Write the three pages**

Each mirrors its `/fees` counterpart, including the guard block at the top:

```ts
const user = await getCurrentUser();
if (!user) redirect("/login");
if (user.role === "SUPER_ADMIN") redirect("/admin");
if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");
```

- `/scholarships/page.tsx` — `ScholarshipService.list`, renders `ScholarshipsListView`, `PageHeader` titled "Scholarships" with a "Add a scholarship" action.
- `/scholarships/new/page.tsx` — loads units via `AcademicStructureService.list` filtered through `flattenTree` + `inactiveIds` (copy the exact filtering from `src/app/(dashboard)/fees/new/page.tsx`), renders `<ScholarshipForm initialScholarship={null} units={units} />`.
- `/scholarships/[scholarshipId]/page.tsx` — `ScholarshipService.get`, renders `PageHeader` with the name, `ScholarshipActions`, and `<ScholarshipForm initialScholarship={scholarship} units={units} />`.

- [ ] **Step 6: Verify in the browser**

Start or reuse the dev server on port 3000 (`npm run dev`). Because Mongoose caches compiled models, if the server was already running before Task 2 added the `Scholarship` model, **restart it** — kill by PID (find it with `lsof -nP -iTCP:3000 -sTCP:LISTEN`), never by process-name pattern; many unrelated dev servers run on this machine.

Log in as `admin@infinityschool.edu.in` / `Infinity!2026`, then confirm by hand:
1. `/scholarships` renders with the empty state.
2. Creating an institution-wide scholarship lands on its detail page and shows "All classes and courses".
3. Creating one scoped to a class shows that class's `pathLabel`.
4. Publish flips the badge to Published; Unpublish returns it to Draft.
5. Delete removes it and returns to the list.
6. No errors in the dev-server log or the browser console.

Delete anything you created before finishing, so the dev database is left as you found it.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npx tsc --noEmit
npx eslint src
```

`eslint` must report **0 errors** and no more than **7 warnings** (all `react-hooks/incompatible-library`). If a new warning of that class appears on your own `watch()` call, use `getValues()` instead inside event handlers — `watch()` is only for values that must re-render.

```bash
git add src/components/scholarships "src/app/(dashboard)/scholarships"
git commit -m "feat: add the scholarships dashboard UI"
```

---

## Task 11: Offer UI

**Files:**
- Create: `src/components/offers/offer-status-badge.tsx`
- Create: `src/components/offers/offer-form.tsx`
- Create: `src/components/offers/offer-actions.tsx`
- Create: `src/components/offers/offers-list-view.tsx`
- Create: `src/app/(dashboard)/offers/page.tsx`
- Create: `src/app/(dashboard)/offers/new/page.tsx`
- Create: `src/app/(dashboard)/offers/[offerId]/page.tsx`

**Interfaces:**
- Consumes: `OfferService`, `OfferDTO` (Task 8); `OFFER_STATUS_LABELS`, `OfferStatus`, `OFFER_KINDS`, `OFFER_KIND_LABELS`, `OfferKind` (Task 1).

Build each file as the direct counterpart of Task 10's, with `Offer`/`offers`/`offerId` substituted. The differences that are **not** mechanical substitution:

- [ ] **Step 1: Badge, actions, list view**

Same as Task 10 steps 1, 3, 4 with names substituted. The list view's columns are: Title, Applies to, Discount (rendered as `kind === "PERCENTAGE" ? `${value}% off` : `₹${value.toLocaleString("en-IN")} off``), Valid until (`validUntil` formatted, or "No end date"), Status badge, Updated.

- [ ] **Step 2: Write the form, with three fields the scholarship form does not have**

Create `src/components/offers/offer-form.tsx` following Task 10's form conventions, plus:

**A `kind` Select** — Radix, driven by `watch`/`setValue`:

```tsx
<Select
  value={watch("kind")}
  onValueChange={(value) => setValue("kind", value as OfferKind, { shouldDirty: true })}
>
  <SelectTrigger id="kind" aria-invalid={Boolean(errors.kind)}>
    <SelectValue placeholder="Pick a discount type" />
  </SelectTrigger>
  <SelectContent>
    {OFFER_KINDS.map((kind) => (
      <SelectItem key={kind} value={kind}>
        {OFFER_KIND_LABELS[kind]}
      </SelectItem>
    ))}
  </SelectContent>
</Select>
```

Note `as OfferKind` — the named cast, because `OfferDTO.kind` is `string` at the service layer. Never `as never`.

**A `value` number input** registered with `valueAsNumber`, since Zod expects a number and an unconverted input yields a string:

```tsx
<Input
  id="value"
  type="number"
  min={0}
  aria-invalid={Boolean(errors.value)}
  {...register("value", { valueAsNumber: true })}
/>
```

Its label changes with `kind`: `watch("kind") === "PERCENTAGE" ? "Percentage off" : "Amount off (₹)"`.

**Two date inputs**, `validFrom` and `validUntil`, as `type="date"` registered normally. `z.coerce.date()` accepts the `YYYY-MM-DD` string the input produces, so no manual conversion is needed on submit. When editing, seed their `defaultValues` from the DTO's ISO strings sliced to 10 characters (`initialOffer?.validUntil?.slice(0, 10) ?? ""`), because a `type="date"` input rejects a full ISO timestamp.

- [ ] **Step 3: Write the three pages**

Same shape as Task 10 step 5, against `OfferService` and `/offers`.

- [ ] **Step 4: Verify in the browser**

As Task 10 step 6 (restart the dev server first — the `Offer` model is new since it last started), plus these offer-specific checks:
1. Creating a `PERCENTAGE` offer with value 15 shows "15% off" in the list.
2. Creating a `FLAT` offer with value 5000 shows "₹5,000 off".
3. Submitting a `PERCENTAGE` offer with value 150 shows the server's error toast ("a percentage discount cannot exceed 100") rather than succeeding.
4. Submitting with `validUntil` before `validFrom` shows the date-order error.
5. An offer saved with no `validUntil` shows "No end date".

Delete anything you created before finishing.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npx tsc --noEmit
npx eslint src
git add src/components/offers "src/app/(dashboard)/offers"
git commit -m "feat: add the offers dashboard UI"
```

---

## Task 12: Nav entries and OpenAPI documentation

**Files:**
- Modify: `src/components/dashboard/nav-config.ts`
- Modify: `src/lib/api/openapi.ts`
- Test: `tests/unit/openapi-scholarships-offers.test.ts`

**Do not** edit `src/app/api/v1/openapi.json/route.ts` or `openapi.yaml/route.ts`. Both are thin delegates that call `buildOpenApiDocument()` from `src/lib/api/openapi.ts` — the document lives in one place and both formats derive from it, so there is no drift to keep in sync.

**Interfaces:**
- Consumes: the four public routes from Tasks 5 and 9.

- [ ] **Step 1: Add the nav entries**

In `src/components/dashboard/nav-config.ts`, add `Award` and `Ticket` to the existing `lucide-react` import (both verified present in the installed version), then add two items to the **second** `INSTITUTION_NAV` group, after the `/fees` entry:

```ts
      { href: "/scholarships", label: "Scholarships", icon: Award, prefix: true, adminOnly: true },
      { href: "/offers", label: "Offers", icon: Ticket, prefix: true, adminOnly: true },
```

`prefix: true` so `/scholarships/new` and `/scholarships/<id>` keep the parent item highlighted. `adminOnly: true` mirrors each page's own guard — Counselor and Front Desk sessions must not see them.

- [ ] **Step 2: Write the failing OpenAPI test**

Create `tests/unit/openapi-scholarships-offers.test.ts`. The document is built by a pure function — the test never touches a route:

```ts
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";

const doc = buildOpenApiDocument({ origin: "https://admissions.test" }) as {
  paths: Record<string, Record<string, { tags?: string[]; security?: unknown[] }>>;
  components: { schemas: Record<string, unknown> };
};

describe("OpenAPI — scholarships and offers", () => {
  it("documents the public scholarships paths", () => {
    expect(doc.paths["/api/public/{institutionId}/scholarships"]?.get).toBeDefined();
    expect(doc.paths["/api/public/institutions/{slug}/scholarships"]?.get).toBeDefined();
  });

  it("documents the public offers paths", () => {
    expect(doc.paths["/api/public/{institutionId}/offers"]?.get).toBeDefined();
    expect(doc.paths["/api/public/institutions/{slug}/offers"]?.get).toBeDefined();
  });

  it("tags all four as Website and declares them credential-free", () => {
    for (const path of [
      "/api/public/{institutionId}/scholarships",
      "/api/public/institutions/{slug}/scholarships",
      "/api/public/{institutionId}/offers",
      "/api/public/institutions/{slug}/offers",
    ]) {
      expect(doc.paths[path]?.get?.tags).toContain("Website");
      expect(doc.paths[path]?.get?.security).toEqual([]);
    }
  });

  it("defines the response schemas the paths reference", () => {
    expect(doc.components.schemas).toHaveProperty("PublicScholarshipsResponse");
    expect(doc.components.schemas).toHaveProperty("PublicScholarship");
    expect(doc.components.schemas).toHaveProperty("PublicOffersResponse");
    expect(doc.components.schemas).toHaveProperty("PublicOffer");
  });
});
```

This mirrors `tests/unit/openapi-fee-structure.test.ts` exactly — read that file if anything above is unclear.

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run tests/unit/openapi-scholarships-offers.test.ts`
Expected: FAIL — the four paths are absent.

- [ ] **Step 4: Document the routes**

Edit `src/lib/api/openapi.ts`. Paths are keyed by template literal against two locals already defined near the top of `buildOpenApiDocument`: `publicBase` (either `/api/public/{institutionId}` or a concrete id when the caller scoped the doc to an institution) and `slugPath`. Add four entries alongside the existing `` [`${publicBase}/fees`] `` (around line 499) and `` [`${slugPath}/fees`] `` (around line 612):

```ts
      [`${publicBase}/scholarships`]: { /* … */ },
      [`${publicBase}/offers`]: { /* … */ },
```

and the two `slugPath` counterparts in the slug block.

Copy the `${publicBase}/fees` entry's exact shape for each: the `...(scoped ? {} : { parameters: [...] })` spread that adds the path parameter only when the doc is unscoped, then a `get` carrying `tags: ["Website"]`, `security: []`, a `summary`, an `operationId` (`listPublicScholarshipsById`, `listPublicScholarshipsBySlug`, `listPublicOffersById`, `listPublicOffersBySlug`), a 200 referencing the response schema, and `...errorResponses(["NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"])`. Omit `VALIDATION_ERROR` — unlike fees, neither route takes a query parameter, so there is nothing to fail validation.

Then add four component schemas next to `PublicFeeStructuresResponse` (around line 1286), following its exact two-part shape (a `…Response` wrapper with `success` + the array, and the item schema):

- `PublicScholarshipsResponse` → `scholarships: array of PublicScholarship`
- `PublicScholarship` → `name`, `criteria`, `amount`, `classOrCourse`, `publishedAt` (all `type: "string"`)
- `PublicOffersResponse` → `offers: array of PublicOffer`
- `PublicOffer` → `title`, `description`, `kind` (`enum: ["PERCENTAGE", "FLAT"]`), `value` (`type: "number"`), `code`, `classOrCourse`, `validFrom`, `validUntil`, `publishedAt`

The property lists must match Tasks 3 and 7's allow-lists exactly — a documented field the projection does not emit is a lie to every consumer reading the spec.

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/unit/openapi-scholarships-offers.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the nav in the browser**

Restart the dev server, log in as the institution admin, and confirm Scholarships and Offers appear in the sidebar after Fees, that clicking each lands on the right page, and that the item stays highlighted on `/scholarships/new`.

Then confirm the role guard: the nav items must be **absent** for a Counselor session. Check how `tests/` or the seed script creates a counselor, log in as one, and verify. If no counselor account exists in the seeded data, say so in the report rather than skipping the check silently.

- [ ] **Step 7: Full suite, lint, typecheck, commit**

```bash
npx vitest run
npx tsc --noEmit
npx eslint src
```

Expected: all tests pass; 0 lint errors; no more than 7 warnings.

```bash
git add src/components/dashboard/nav-config.ts src/lib/api/openapi.ts tests/unit/openapi-scholarships-offers.test.ts
git commit -m "feat: add scholarships and offers to the nav and OpenAPI document"
```

---

## Self-Review

**1. Spec coverage** — every section mapped to a task:

| Spec section | Task |
|---|---|
| §3.1 Constants | 1 |
| §3.2 Scholarship model | 2 |
| §3.3 Offer model | 6 |
| §4.1 Schemas | 2 (scholarship), 6 (offer) |
| §4.2 Invariants + publish gates | 2 (scholarship), 6 (offer) |
| §5.1 Label derivation | 4 (scholarship), 8 (offer) |
| §5.2 Tenant check on write | 1 (helper), 4 + 8 (use) |
| §5.3 Expiry derived, never stored | 8 |
| §6.1 Dashboard routes | 5 (scholarship), 9 (offer) |
| §6.2 Public routes | 5 (scholarship), 9 (offer) |
| §7 Public projections | 3 (scholarship), 7 (offer) |
| §8 UI + nav | 10, 11 (UI), 12 (nav) |
| §9 Testing (all six categories) | distributed; every task ends green |
| §10 Definition of done | 12 (full suite + lint + tsc) |

No gaps.

**2. Type consistency** — `ScholarshipDTO` (Task 4) and `OfferDTO` (Task 8) are declared once and consumed verbatim by Tasks 5/9 (routes) and 10/11 (UI). `assertOwnedAcademicUnit`'s signature is declared in Task 1 and used unchanged in Tasks 4 and 8. `toPublicScholarship`/`toPublicOffer` return types are named (`PublicScholarship`/`PublicOffer`) and imported by their services. Status types are `ScholarshipStatus`/`OfferStatus`, cast at UI call sites because DTOs carry `status: string` — stated explicitly in Task 10 Step 1.

**3. Deviations from the spec, decided while planning:**

- The spec's §12 said to extract the shared tenant check "if a third consumer appears in Phase 9". This plan extracts it in **Task 1 instead**, because Scholarship and Offer are already two consumers and writing it twice to extract it later is strictly more work than writing it once. `fee-structure.service.ts` keeps its own inline copy — refactoring it is out of scope and would touch a merged, tested surface for no behavioural gain.
- The spec did not mention per-institution document caps in §5. Tasks 4 and 8 enforce `SCHOLARSHIP_MAX_PER_INSTITUTION` / `OFFER_MAX_PER_INSTITUTION`, which §3.1 defines — a constant with no enforcement point would be dead code, so the check goes in `create`.
- The spec's §6.1 listed five dashboard routes per model. This plan adds a sixth, `GET /api/settings/{scholarships,offers}/[id]`, because the existing `/api/settings/fees/[feeId]` route has one and an asymmetric surface is a trap for the next consumer. The dashboard pages themselves read server-side via the service, so nothing in this phase consumes it.

**4. Claims verified at source while writing this plan** (rather than pattern-matched from memory — the failure mode that recurred across four briefs on the previous phase):

- `makeInstitution` / `makeProfiledInstitution` are **positional**, not object-form.
- `AcademicStructureService.update(institutionId, unitId, patch, actor)` — matches Task 4's test call exactly.
- `requiredText` is a `transform`+`refine` chain, not `.min()`; confirmed by running the real schema that it rejects whitespace-only input, strips unknown keys like `status`, and survives `.partial()` intact.
- `z.coerce.date()` parses `"2026-03-31"` under Zod 4.
- `Award` and `Ticket` exist in the installed `lucide-react`.
- `PUBLIC_READ_RATE_LIMIT`, `publicCorsPreflight`, `EmptyState`'s `actionLabel`/`actionHref`, `textarea.tsx`, and `models/index.ts`'s export style all exist as used.
- **The OpenAPI document is built by `buildOpenApiDocument()` in `src/lib/api/openapi.ts`, not in the route files** — my first draft of Task 12 had the implementer editing both route files and calling `GET()` in the test. Both were wrong; corrected.
- `{ validUntil: null }` matches absent **and** explicitly-null documents, so the expiry `$or` needs two clauses, not three (verified against mongodb-memory-server while writing the spec).
