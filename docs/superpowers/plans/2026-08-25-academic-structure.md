# Academic Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every institution a per-tenant academic structure — an ordered, editable tree whose shape is determined by the academic segments it runs — and derive the institution profile's published class/course lists from it.

**Architecture:** Three layers. Blueprints (code, stable) map each academic segment to an ordered list of level *names*. `AcademicUnit` (per-tenant data) is a self-referencing tree with denormalized `depth` and `pathLabel`. Consumers read units and know nothing about institution types. Phase 6 adds fee structures as a third consumer.

**Tech Stack:** Next.js 16 App Router, Mongoose 8, Zod 4, TypeScript, Vitest 3, react-hook-form, Radix/shadcn UI, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-25-academic-structure-design.md`

## Global Constraints

- **No institution-specific value strings in `src/`.** "Grade 1", "PCMB", "Computer Science & Engineering" and the like appear only as blueprint `example` placeholders and in test fixtures. No conditional anywhere branches on `institutionType` to decide a label — labels come from the blueprint.
- **`requireInstitution()` on every route.** A hard `role !== "INSTITUTION_ADMIN"` throw. Do **not** add entries to `ROLE_PERMISSIONS` and do **not** use `requirePermission()` — that table is Lead Follow-up's, and Phase 5 adds nothing to it.
- **404-never-403.** A unit id, or a `parentId`, belonging to another institution reads as `NOT_FOUND`, never `FORBIDDEN`. Every query is scoped by `institutionId` taken from the session, never from the request body.
- **`assertSameOrigin(request)` first in every mutating route handler**, before `requireInstitution()`, matching `src/app/api/settings/fees/route.ts`.
- **Phase 5 adds no public API path.** `tests/unit/api-contract.test.ts`'s public-path count stays at **9**. Do not touch `src/lib/api/openapi.ts`.
- **`FeeStructure` is not touched in this phase.** No file under `src/**/fee*` or `tests/**/fee*` is modified.
- **Segment order is always `ACADEMIC_SEGMENTS` declaration order**, never the order an institution ticked boxes in. Use `orderSegments()`.
- **Monochrome design system.** No hue-based colour outside `text-destructive` / `variant="destructive"`. Match `src/components/fees/*` exactly.
- **Test baseline is 557 passing tests in 63 files.** Every task states its expected new total; verify it.
- `npx tsc --noEmit` and `npm run lint` must be clean at the end of every task.
- Commit at the end of every task. Never commit to `main`; this plan runs on `feat/academic-structure`.

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/lib/academic/blueprints.ts` | The segment → level-list map, and the lookups over it |
| `src/lib/academic/offerings.ts` | `deriveOfferings(units, segments)` — pure, no database |
| `src/models/AcademicUnit.ts` | The tree document |
| `src/lib/validation/academic-structure.ts` | Request schemas |
| `src/services/academic-structure.service.ts` | All reads and writes, all tenant-scoped |
| `src/app/api/settings/academic-structure/route.ts` | `GET` the whole editor payload |
| `src/app/api/settings/academic-structure/segments/route.ts` | `PUT` the selection |
| `src/app/api/settings/academic-structure/units/route.ts` | `POST` create |
| `src/app/api/settings/academic-structure/units/[unitId]/route.ts` | `PATCH`, `DELETE` |
| `src/app/api/settings/academic-structure/reorder/route.ts` | `POST` a full sibling order |
| `src/app/api/settings/academic-structure/seed/route.ts` | `POST` the one-time profile import |
| `src/app/(dashboard)/academic-structure/page.tsx` | Server page + role guard |
| `src/components/academic/academic-structure-view.tsx` | Client shell: state, refresh, layout |
| `src/components/academic/segment-selector.tsx` | The segment checkbox row |
| `src/components/academic/unit-tree.tsx` | The indented tree and its row actions |

**Modify:** `src/lib/constants.ts` (segment/level enums), `src/models/Institution.ts` (`academic.segments`), `src/models/index.ts`, `src/lib/types.ts`, `src/lib/profile/public-projection.ts`, `src/services/institution.service.ts`, `src/components/dashboard/nav-config.ts`, `src/components/profile/sections/academic-section.tsx`, `tests/integration/admin-only-pages.test.ts`.

**Test:** `tests/unit/academic-blueprints.test.ts`, `tests/unit/academic-unit-model.test.ts`, `tests/unit/academic-structure-validation.test.ts`, `tests/unit/academic-offerings.test.ts`, `tests/integration/academic-structure-crud.test.ts`, `tests/integration/academic-structure-config.test.ts`, `tests/integration/academic-structure-routes.test.ts`, `tests/integration/academic-structure-profile.test.ts`.

## Test count chain

| After task | New | Total |
|---|---|---|
| baseline | — | 557 |
| 1 | +7 | 564 |
| 2 | +4 | 568 |
| 3 | +7 | 575 |
| 4 | +7 | 582 |
| 5 | +11 | 593 |
| 6 | +14 | 607 |
| 7 | +10 | 617 |
| 8 | +4 | 621 |
| 9 | +1 | 622 |
| 10 | +0 | 622 |
| 11 | +0 | 622 |

---

### Task 1: Segments, level keys, and blueprints

**Files:**
- Modify: `src/lib/constants.ts` (append at end of file)
- Create: `src/lib/academic/blueprints.ts`
- Test: `tests/unit/academic-blueprints.test.ts`

**Interfaces:**
- Consumes: `INSTITUTION_TYPES`, `InstitutionType` from `@/lib/constants`.
- Produces: `ACADEMIC_SEGMENTS`, `AcademicSegment`, `ACADEMIC_SEGMENT_LABELS`, `ACADEMIC_LEVEL_KEYS`, `AcademicLevelKey`, `ACADEMIC_UNIT_MAX_PER_INSTITUTION` (from `@/lib/constants`); `AcademicLevel`, `AcademicBlueprint`, `ACADEMIC_BLUEPRINTS`, `PATH_SEPARATOR`, `blueprintFor`, `levelFor`, `maxDepthFor`, `DEFAULT_SEGMENTS_FOR_TYPE`, `defaultSegmentsFor`, `orderSegments` (from `@/lib/academic/blueprints`).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/academic-blueprints.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ACADEMIC_LEVEL_KEYS,
  ACADEMIC_SEGMENTS,
  ACADEMIC_SEGMENT_LABELS,
  INSTITUTION_TYPES,
} from "@/lib/constants";
import {
  ACADEMIC_BLUEPRINTS,
  DEFAULT_SEGMENTS_FOR_TYPE,
  defaultSegmentsFor,
  levelFor,
  maxDepthFor,
  orderSegments,
} from "@/lib/academic/blueprints";

describe("academic blueprints", () => {
  it("gives every segment at least one level, a label, and a blueprint", () => {
    for (const segment of ACADEMIC_SEGMENTS) {
      expect(ACADEMIC_BLUEPRINTS[segment]).toBeDefined();
      expect(ACADEMIC_BLUEPRINTS[segment].levels.length).toBeGreaterThan(0);
      expect(ACADEMIC_SEGMENT_LABELS[segment]).toBeTruthy();
    }
  });

  it("keeps every offeringDepth inside its own level list", () => {
    // The off-by-one here would silently publish an empty offerings array
    // rather than fail loudly, so it is asserted rather than eyeballed.
    for (const segment of ACADEMIC_SEGMENTS) {
      const blueprint = ACADEMIC_BLUEPRINTS[segment];
      expect(blueprint.offeringDepth).toBeGreaterThanOrEqual(0);
      expect(blueprint.offeringDepth).toBeLessThan(blueprint.levels.length);
    }
  });

  it("uses only declared level keys, and declares no unused ones", () => {
    const used = new Set(
      ACADEMIC_SEGMENTS.flatMap((segment) =>
        ACADEMIC_BLUEPRINTS[segment].levels.map((level) => level.key),
      ),
    );
    for (const key of used) expect(ACADEMIC_LEVEL_KEYS).toContain(key);
    for (const key of ACADEMIC_LEVEL_KEYS) expect(used.has(key)).toBe(true);
  });

  it("maps every institution type to real segments", () => {
    for (const institutionType of INSTITUTION_TYPES) {
      const segments = DEFAULT_SEGMENTS_FOR_TYPE[institutionType];
      expect(segments, `no default for ${institutionType}`).toBeDefined();
      expect(segments.length).toBeGreaterThan(0);
      for (const segment of segments) expect(ACADEMIC_SEGMENTS).toContain(segment);
    }
  });

  it("returns null for a depth past the end of a blueprint", () => {
    expect(levelFor("SCHOOL", 0)?.key).toBe("CLASS");
    expect(levelFor("SCHOOL", 1)).toBeNull();
    expect(maxDepthFor("SCHOOL")).toBe(0);
    expect(maxDepthFor("UNIVERSITY")).toBe(3);
  });

  it("orders segments by declaration, not by the order they were given in", () => {
    expect(orderSegments(["PRE_UNIVERSITY", "SCHOOL"])).toEqual(["SCHOOL", "PRE_UNIVERSITY"]);
    expect(orderSegments(["OTHER", "DEGREE", "SCHOOL"])).toEqual(["SCHOOL", "DEGREE", "OTHER"]);
    expect(orderSegments(["NOT_A_SEGMENT"])).toEqual([]);
  });

  it("falls back to OTHER for an institution type it does not know", () => {
    expect(defaultSegmentsFor("SCHOOL")).toEqual(["SCHOOL"]);
    expect(defaultSegmentsFor("SOMETHING_NEW")).toEqual(["OTHER"]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/unit/academic-blueprints.test.ts`
Expected: FAIL — cannot resolve `@/lib/academic/blueprints`.

- [ ] **Step 3: Append the constants**

Append to the **end** of `src/lib/constants.ts`:

```ts
/**
 * What an institution actually runs. Curated so every entry is a genuinely
 * different *shape* — medical, nursing and B.Ed colleges all have the shape
 * `Course → Year / semester`, so they share `DEGREE` rather than each getting
 * an entry. This is not a list of institution types.
 */
export const ACADEMIC_SEGMENTS = [
  "SCHOOL",
  "PRE_UNIVERSITY",
  "DEGREE",
  "ENGINEERING",
  "POLYTECHNIC",
  "UNIVERSITY",
  "COACHING",
  "OTHER",
] as const;
export type AcademicSegment = (typeof ACADEMIC_SEGMENTS)[number];

export const ACADEMIC_SEGMENT_LABELS: Record<AcademicSegment, string> = {
  SCHOOL: "School (up to Class 10 / SSLC)",
  PRE_UNIVERSITY: "Pre-University (PUC)",
  DEGREE: "Degree college",
  ENGINEERING: "Engineering college",
  POLYTECHNIC: "Polytechnic / Diploma",
  UNIVERSITY: "University",
  COACHING: "Coaching / Training",
  OTHER: "Other",
};

/** A tier name, shared wherever the tier genuinely is the same thing. */
export const ACADEMIC_LEVEL_KEYS = [
  "CLASS",
  "PU_YEAR",
  "COMBINATION",
  "COURSE",
  "PROGRAMME",
  "BRANCH",
  "PROGRAMME_LEVEL",
  "SPECIALISATION",
  "YEAR",
  "BATCH",
] as const;
export type AcademicLevelKey = (typeof ACADEMIC_LEVEL_KEYS)[number];

/**
 * A rename rewrites its subtree in application code and a delete collects one
 * in memory. Both are correct at tens of nodes and neither is at thousands —
 * this is the guard that keeps the assumption true.
 */
export const ACADEMIC_UNIT_MAX_PER_INSTITUTION = 500;
```

- [ ] **Step 4: Write the blueprints**

Create `src/lib/academic/blueprints.ts`:

```ts
import {
  ACADEMIC_SEGMENTS,
  type AcademicLevelKey,
  type AcademicSegment,
  type InstitutionType,
} from "@/lib/constants";

export type AcademicLevel = {
  key: AcademicLevelKey;
  /** Singular, used as a field label: "Branch". */
  label: string;
  /** Used in headings and empty states: "Branches". */
  plural: string;
  /**
   * Placeholder text for the add input. This is the only place in `src/` where
   * a real-world value like "PCMB" is allowed to appear.
   */
  example: string;
};

export type AcademicBlueprint = {
  levels: AcademicLevel[];
  /**
   * The tier that answers "what do you offer" — the one worth publishing on a
   * profile. For a school that is the class; for a PU college the combination,
   * not the year; for an engineering college the branch, not the programme.
   */
  offeringDepth: number;
};

/**
 * Segment → the tiers it is made of. This map names *tiers*, never *values*:
 * adding a thirteenth institution type later is one entry here and no change to
 * the model, the service, the routes, the editor, or the fee module.
 */
export const ACADEMIC_BLUEPRINTS: Record<AcademicSegment, AcademicBlueprint> = {
  SCHOOL: {
    levels: [{ key: "CLASS", label: "Class", plural: "Classes", example: "Grade 1" }],
    offeringDepth: 0,
  },
  PRE_UNIVERSITY: {
    levels: [
      { key: "PU_YEAR", label: "PU year", plural: "PU years", example: "PUC 1st Year" },
      { key: "COMBINATION", label: "Combination", plural: "Combinations", example: "PCMB" },
    ],
    offeringDepth: 1,
  },
  DEGREE: {
    levels: [
      { key: "COURSE", label: "Course", plural: "Courses", example: "B.Com" },
      { key: "YEAR", label: "Year / semester", plural: "Years / semesters", example: "Year 1" },
    ],
    offeringDepth: 0,
  },
  ENGINEERING: {
    levels: [
      { key: "PROGRAMME", label: "Programme", plural: "Programmes", example: "B.E." },
      {
        key: "BRANCH",
        label: "Branch",
        plural: "Branches",
        example: "Computer Science & Engineering",
      },
      { key: "YEAR", label: "Year / semester", plural: "Years / semesters", example: "Year 1" },
    ],
    offeringDepth: 1,
  },
  POLYTECHNIC: {
    levels: [
      {
        key: "COURSE",
        label: "Diploma course",
        plural: "Diploma courses",
        example: "Diploma in Mechanical Engineering",
      },
      { key: "YEAR", label: "Year / semester", plural: "Years / semesters", example: "Year 1" },
    ],
    offeringDepth: 0,
  },
  UNIVERSITY: {
    levels: [
      {
        key: "PROGRAMME_LEVEL",
        label: "Programme level",
        plural: "Programme levels",
        example: "Undergraduate",
      },
      { key: "COURSE", label: "Course", plural: "Courses", example: "B.Sc" },
      {
        key: "SPECIALISATION",
        label: "Specialisation",
        plural: "Specialisations",
        example: "Computer Science",
      },
      { key: "YEAR", label: "Year / semester", plural: "Years / semesters", example: "Semester 1" },
    ],
    offeringDepth: 1,
  },
  COACHING: {
    levels: [
      { key: "PROGRAMME", label: "Programme", plural: "Programmes", example: "NEET Repeater" },
      { key: "BATCH", label: "Batch", plural: "Batches", example: "Morning Batch" },
    ],
    offeringDepth: 0,
  },
  OTHER: {
    levels: [
      { key: "PROGRAMME", label: "Programme", plural: "Programmes", example: "Certificate Course" },
    ],
    offeringDepth: 0,
  },
};

/**
 * The display separator between a unit and its parent. Defined here rather than
 * in the service because client components need it too, and the service is
 * `server-only` — a value import from there would pull `server-only` into the
 * client bundle and fail the build.
 */
export const PATH_SEPARATOR = " › ";

export function blueprintFor(segment: AcademicSegment): AcademicBlueprint {
  return ACADEMIC_BLUEPRINTS[segment];
}

/** `null` past the end of the blueprint — a depth no level exists for. */
export function levelFor(segment: AcademicSegment, depth: number): AcademicLevel | null {
  return ACADEMIC_BLUEPRINTS[segment].levels[depth] ?? null;
}

export function maxDepthFor(segment: AcademicSegment): number {
  return ACADEMIC_BLUEPRINTS[segment].levels.length - 1;
}

/**
 * Seeds the initial selection from the institution type an institution already
 * has. A default, never a constraint: the selection is stored and edited
 * independently, and changing `institutionType` later never rewrites it.
 */
export const DEFAULT_SEGMENTS_FOR_TYPE: Record<InstitutionType, AcademicSegment[]> = {
  SCHOOL: ["SCHOOL"],
  PU_COLLEGE: ["PRE_UNIVERSITY"],
  DEGREE_COLLEGE: ["DEGREE"],
  ENGINEERING_COLLEGE: ["ENGINEERING"],
  MEDICAL_COLLEGE: ["DEGREE"],
  UNIVERSITY: ["UNIVERSITY"],
  OTHER: ["OTHER"],
  B_ED_COLLEGE: ["DEGREE"],
  NURSING_COLLEGE: ["DEGREE"],
  POLYTECHNIC: ["POLYTECHNIC"],
  COACHING_INSTITUTION: ["COACHING"],
  TRAINING_INSTITUTION: ["COACHING"],
};

export function defaultSegmentsFor(institutionType: string): AcademicSegment[] {
  return DEFAULT_SEGMENTS_FOR_TYPE[institutionType as InstitutionType] ?? ["OTHER"];
}

/**
 * Declaration order, always. A stored selection is a set; only declaration
 * order is stable enough to derive a published array from. Unknown values are
 * dropped rather than passed through.
 */
export function orderSegments(segments: readonly string[]): AcademicSegment[] {
  return ACADEMIC_SEGMENTS.filter((segment) => segments.includes(segment));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/academic-blueprints.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Verify the whole suite and the types**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **564 tests passing**.

- [ ] **Step 7: Commit**

```bash
git add src/lib/constants.ts src/lib/academic/blueprints.ts tests/unit/academic-blueprints.test.ts
git commit -m "feat: add academic segments and their blueprints"
```

---

### Task 2: The AcademicUnit model

**Files:**
- Create: `src/models/AcademicUnit.ts`
- Modify: `src/models/index.ts`, `src/models/Institution.ts`, `src/lib/types.ts`
- Test: `tests/unit/academic-unit-model.test.ts`

**Interfaces:**
- Consumes: `ACADEMIC_SEGMENTS` from `@/lib/constants`.
- Produces: `AcademicUnit`, `AcademicUnitDoc` (re-exported from `@/models`); `Institution.academic.segments` as `string[] | undefined`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/academic-unit-model.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { AcademicUnit } from "@/models";

beforeAll(async () => {
  await startTestDatabase("academic-unit-model");
  // Mongoose builds indexes in the background; without waiting here the very
  // first duplicate write can race ahead of the unique index existing on the
  // server. Same pattern as fee-structure-model.test.ts.
  await AcademicUnit.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

const root = {
  institutionId: "INS0001",
  segment: "SCHOOL",
  parentId: null,
  depth: 0,
  name: "Grade 1",
  pathLabel: "Grade 1",
};

describe("AcademicUnit model", () => {
  it("creates a root that is active and sorted first by default", async () => {
    const created = await AcademicUnit.create(root);

    expect(created.active).toBe(true);
    expect(created.sortOrder).toBe(0);
    expect(created.parentId).toBeNull();
  });

  it("refuses two siblings with the same name under the same parent", async () => {
    await AcademicUnit.create(root);

    await expect(AcademicUnit.create(root)).rejects.toMatchObject({ code: 11000 });
  });

  it("allows the same name under two different parents", async () => {
    const first = await AcademicUnit.create({
      ...root,
      segment: "PRE_UNIVERSITY",
      name: "PUC 1st Year",
      pathLabel: "PUC 1st Year",
    });
    const second = await AcademicUnit.create({
      ...root,
      segment: "PRE_UNIVERSITY",
      name: "PUC 2nd Year",
      pathLabel: "PUC 2nd Year",
    });

    await AcademicUnit.create({
      institutionId: "INS0001",
      segment: "PRE_UNIVERSITY",
      parentId: first._id,
      depth: 1,
      name: "PCMB",
      pathLabel: "PUC 1st Year › PCMB",
    });

    await expect(
      AcademicUnit.create({
        institutionId: "INS0001",
        segment: "PRE_UNIVERSITY",
        parentId: second._id,
        depth: 1,
        name: "PCMB",
        pathLabel: "PUC 2nd Year › PCMB",
      }),
    ).resolves.toBeDefined();
  });

  it("allows the same name in two institutions and in two segments", async () => {
    await AcademicUnit.create(root);

    await expect(AcademicUnit.create({ ...root, institutionId: "INS0002" })).resolves.toBeDefined();
    await expect(AcademicUnit.create({ ...root, segment: "COACHING" })).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/unit/academic-unit-model.test.ts`
Expected: FAIL — `AcademicUnit` is not exported from `@/models`.

- [ ] **Step 3: Write the model**

Create `src/models/AcademicUnit.ts`:

```ts
import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { ACADEMIC_SEGMENTS } from "@/lib/constants";

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
    /**
     * Denormalized: validating that a unit is within its blueprint, and
     * rendering it at the right indent, would otherwise both need an ancestor
     * walk on every read.
     */
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

/**
 * Siblings cannot share a name. Enforced by the index rather than a pre-read,
 * which would race two browser tabs into creating both. Names compare as
 * stored — "Grade 1" and "grade 1" are distinct, deliberately: institutions
 * type their own names and normalising case surprises more than it helps.
 */
AcademicUnitSchema.index(
  { institutionId: 1, segment: 1, parentId: 1, name: 1 },
  { unique: true },
);

export type AcademicUnitDoc = InferSchemaType<typeof AcademicUnitSchema> & {
  _id: Types.ObjectId;
};

export const AcademicUnit: Model<AcademicUnitDoc> =
  (models.AcademicUnit as Model<AcademicUnitDoc>) ??
  model<AcademicUnitDoc>("AcademicUnit", AcademicUnitSchema);
```

- [ ] **Step 4: Register it and add the segment selection**

In `src/models/index.ts`, append after the `FeeStructure` line:

```ts
export { AcademicUnit, type AcademicUnitDoc } from "./AcademicUnit";
```

In `src/models/Institution.ts`, add `ACADEMIC_SEGMENTS` to the existing import from `@/lib/constants`, then add this as the **last field** of `AcademicSchema` (after `coursesOffered`):

```ts
    /**
     * Which academic segments this institution runs — one or more, because a
     * school with a PU college attached is the norm, not the exception.
     * `undefined` means "never chosen" and reads through
     * `defaultSegmentsFor(institutionType)`. Written only by the
     * academic-structure endpoint, never by a profile PATCH.
     */
    segments: { type: [String], enum: ACADEMIC_SEGMENTS, default: undefined },
```

In `src/lib/types.ts`, add to the `academic?: { ... }` block, after `coursesOffered?: string[];`:

```ts
    segments?: string[];
```

**Do not** add `segments` to `src/lib/validation/institution.ts`. It is absent from the profile schemas on purpose, so a profile PATCH can never smuggle a segment selection past the "does this segment still have units" guard.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/academic-unit-model.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify the whole suite and the types**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **568 tests passing**. If a profile test fails, you added `segments` to a validation schema — revert that.

- [ ] **Step 7: Commit**

```bash
git add src/models/AcademicUnit.ts src/models/index.ts src/models/Institution.ts src/lib/types.ts tests/unit/academic-unit-model.test.ts
git commit -m "feat: add the AcademicUnit model and the institution segment selection"
```

---

### Task 3: Request validation

**Files:**
- Create: `src/lib/validation/academic-structure.ts`
- Test: `tests/unit/academic-structure-validation.test.ts`

**Interfaces:**
- Consumes: `requiredText` from `./common`, `ACADEMIC_SEGMENTS` from `@/lib/constants`.
- Produces: `createAcademicUnitSchema`, `updateAcademicUnitSchema`, `reorderAcademicUnitsSchema`, `updateSegmentsSchema` and their inferred input types.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/academic-structure-validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createAcademicUnitSchema,
  reorderAcademicUnitsSchema,
  updateAcademicUnitSchema,
  updateSegmentsSchema,
} from "@/lib/validation/academic-structure";

const OID = "6a887abd755db527bea51204";

describe("academic structure validation", () => {
  it("requires a name, trims it, and caps it at 120", () => {
    expect(createAcademicUnitSchema.safeParse({ segment: "SCHOOL", name: "" }).success).toBe(false);
    expect(
      createAcademicUnitSchema.safeParse({ segment: "SCHOOL", name: "x".repeat(121) }).success,
    ).toBe(false);

    const parsed = createAcademicUnitSchema.parse({ segment: "SCHOOL", name: "  Grade 1  " });
    expect(parsed.name).toBe("Grade 1");
  });

  it("treats an absent parentId and an explicit null as the same thing", () => {
    expect(createAcademicUnitSchema.parse({ segment: "SCHOOL", name: "Grade 1" }).parentId)
      .toBeUndefined();
    expect(
      createAcademicUnitSchema.parse({ segment: "SCHOOL", name: "Grade 1", parentId: null })
        .parentId,
    ).toBeNull();
  });

  it("rejects a parentId that is not an object id, and an unknown segment", () => {
    expect(
      createAcademicUnitSchema.safeParse({ segment: "SCHOOL", name: "A", parentId: "nope" })
        .success,
    ).toBe(false);
    expect(createAcademicUnitSchema.safeParse({ segment: "MADE_UP", name: "A" }).success).toBe(
      false,
    );
  });

  it("strips segment and parentId from a patch instead of applying them", () => {
    // Same guarantee, and the same mechanism, as `status` being absent from
    // `updateFeeStructureSchema`: a patch can never move a unit and leave its
    // depth, level and every descendant's pathLabel stale.
    const parsed = updateAcademicUnitSchema.parse({
      name: "Renamed",
      segment: "UNIVERSITY",
      parentId: OID,
    }) as Record<string, unknown>;

    expect(parsed.name).toBe("Renamed");
    expect(parsed.segment).toBeUndefined();
    expect(parsed.parentId).toBeUndefined();
  });

  it("accepts a patch that only toggles active", () => {
    expect(updateAcademicUnitSchema.parse({ active: false })).toEqual({ active: false });
  });

  it("requires at least one segment and refuses duplicates", () => {
    expect(updateSegmentsSchema.safeParse({ segments: [] }).success).toBe(false);
    expect(updateSegmentsSchema.safeParse({ segments: ["SCHOOL", "SCHOOL"] }).success).toBe(false);
    expect(updateSegmentsSchema.safeParse({ segments: ["SCHOOL", "PRE_UNIVERSITY"] }).success).toBe(
      true,
    );
  });

  it("requires a non-empty, bounded, well-formed orderedIds list", () => {
    expect(
      reorderAcademicUnitsSchema.safeParse({ segment: "SCHOOL", orderedIds: [] }).success,
    ).toBe(false);
    expect(
      reorderAcademicUnitsSchema.safeParse({
        segment: "SCHOOL",
        orderedIds: Array.from({ length: 101 }, () => OID),
      }).success,
    ).toBe(false);
    expect(
      reorderAcademicUnitsSchema.safeParse({ segment: "SCHOOL", orderedIds: ["nope"] }).success,
    ).toBe(false);
    expect(
      reorderAcademicUnitsSchema.safeParse({
        segment: "SCHOOL",
        parentId: null,
        orderedIds: [OID],
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/unit/academic-structure-validation.test.ts`
Expected: FAIL — cannot resolve `@/lib/validation/academic-structure`.

- [ ] **Step 3: Write the schemas**

Create `src/lib/validation/academic-structure.ts`:

```ts
import { z } from "zod";
import { ACADEMIC_SEGMENTS } from "@/lib/constants";
import { requiredText } from "./common";

const REORDER_MAX_SIBLINGS = 100;

/** A 24-character hex id. Anything else is "no such unit", never a 500. */
const objectIdString = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");

export const createAcademicUnitSchema = z.object({
  segment: z.enum(ACADEMIC_SEGMENTS),
  /** Absent and explicit null both mean "a root". */
  parentId: objectIdString.nullish(),
  name: requiredText("Name", 120),
});
export type CreateAcademicUnitInput = z.infer<typeof createAcademicUnitSchema>;

/**
 * `segment` and `parentId` are absent on purpose, exactly as `status` is absent
 * from `updateFeeStructureSchema`: Zod strips an unknown key, so a patch can
 * never move a unit between parents or segments and leave its depth, its level
 * and every descendant's `pathLabel` stale. A misplaced unit is deleted and
 * recreated.
 */
export const updateAcademicUnitSchema = z.object({
  name: requiredText("Name", 120).optional(),
  active: z.boolean().optional(),
});
export type UpdateAcademicUnitInput = z.infer<typeof updateAcademicUnitSchema>;

export const reorderAcademicUnitsSchema = z.object({
  segment: z.enum(ACADEMIC_SEGMENTS),
  parentId: objectIdString.nullish(),
  orderedIds: z
    .array(objectIdString)
    .min(1, "Nothing to reorder")
    .max(REORDER_MAX_SIBLINGS, `Cannot reorder more than ${REORDER_MAX_SIBLINGS} at once`),
});
export type ReorderAcademicUnitsInput = z.infer<typeof reorderAcademicUnitsSchema>;

export const updateSegmentsSchema = z.object({
  segments: z
    .array(z.enum(ACADEMIC_SEGMENTS))
    .min(1, "Select at least one segment")
    .max(ACADEMIC_SEGMENTS.length)
    .refine((values) => new Set(values).size === values.length, {
      message: "Each segment can be selected only once",
    }),
});
export type UpdateSegmentsInput = z.infer<typeof updateSegmentsSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/academic-structure-validation.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify the whole suite and the types**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **575 tests passing**.

- [ ] **Step 6: Commit**

```bash
git add src/lib/validation/academic-structure.ts tests/unit/academic-structure-validation.test.ts
git commit -m "feat: add academic structure request validation"
```

---

### Task 4: Deriving offerings from the tree

**Files:**
- Create: `src/lib/academic/offerings.ts`
- Test: `tests/unit/academic-offerings.test.ts`

**Interfaces:**
- Consumes: `ACADEMIC_BLUEPRINTS`, `orderSegments` from `@/lib/academic/blueprints`; `AcademicSegment` from `@/lib/constants`.
- Produces: `OfferingUnit` (the minimum shape a unit must carry — `AcademicUnitDTO` from Task 5 is a superset and assignable to it), `DerivedOfferings`, `deriveOfferings(units, segments)`.

This is a **pure function with no database access**. That is the whole point of the split: the service loads units and calls this, so these stay real unit tests over fixtures.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/academic-offerings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveOfferings, type OfferingUnit } from "@/lib/academic/offerings";

let counter = 0;
function unit(overrides: Partial<OfferingUnit> & { name: string }): OfferingUnit {
  counter += 1;
  return {
    id: `id-${counter}`,
    segment: "SCHOOL",
    parentId: null,
    depth: 0,
    sortOrder: 0,
    active: true,
    ...overrides,
  };
}

describe("deriveOfferings", () => {
  it("reads a school tree into classesOffered and leaves coursesOffered empty", () => {
    const units = [
      unit({ name: "Grade 1", sortOrder: 0 }),
      unit({ name: "Grade 2", sortOrder: 1 }),
    ];

    expect(deriveOfferings(units, ["SCHOOL"])).toEqual({
      classesOffered: ["Grade 1", "Grade 2"],
      coursesOffered: [],
    });
  });

  it("reads a PU tree at the combination tier, not the year tier", () => {
    const year = unit({ name: "PUC 1st Year", segment: "PRE_UNIVERSITY" });
    const units = [
      year,
      unit({ name: "PCMB", segment: "PRE_UNIVERSITY", parentId: year.id, depth: 1, sortOrder: 0 }),
      unit({ name: "CEBA", segment: "PRE_UNIVERSITY", parentId: year.id, depth: 1, sortOrder: 1 }),
    ];

    expect(deriveOfferings(units, ["PRE_UNIVERSITY"])).toEqual({
      classesOffered: [],
      coursesOffered: ["PCMB", "CEBA"],
    });
  });

  it("reads an engineering tree at the branch tier, not the programme or year tier", () => {
    const programme = unit({ name: "B.E.", segment: "ENGINEERING" });
    const branch = unit({
      name: "Computer Science",
      segment: "ENGINEERING",
      parentId: programme.id,
      depth: 1,
    });
    const units = [
      programme,
      branch,
      unit({ name: "Year 1", segment: "ENGINEERING", parentId: branch.id, depth: 2 }),
    ];

    expect(deriveOfferings(units, ["ENGINEERING"]).coursesOffered).toEqual(["Computer Science"]);
  });

  it("excludes an active unit whose ancestor is inactive", () => {
    const year = unit({ name: "PUC 1st Year", segment: "PRE_UNIVERSITY", active: false });
    const live = unit({ name: "PUC 2nd Year", segment: "PRE_UNIVERSITY", sortOrder: 1 });
    const units = [
      year,
      live,
      unit({ name: "PCMB", segment: "PRE_UNIVERSITY", parentId: year.id, depth: 1 }),
      unit({ name: "CEBA", segment: "PRE_UNIVERSITY", parentId: live.id, depth: 1 }),
    ];

    expect(deriveOfferings(units, ["PRE_UNIVERSITY"]).coursesOffered).toEqual(["CEBA"]);
  });

  it("fills both arrays for a composite school and PU institution", () => {
    const year = unit({ name: "PUC 1st Year", segment: "PRE_UNIVERSITY" });
    const units = [
      unit({ name: "Grade 10" }),
      year,
      unit({ name: "PCMB", segment: "PRE_UNIVERSITY", parentId: year.id, depth: 1 }),
    ];

    expect(deriveOfferings(units, ["PRE_UNIVERSITY", "SCHOOL"])).toEqual({
      classesOffered: ["Grade 10"],
      coursesOffered: ["PCMB"],
    });
  });

  it("publishes a name shared by two parents only once", () => {
    const first = unit({ name: "PUC 1st Year", segment: "PRE_UNIVERSITY", sortOrder: 0 });
    const second = unit({ name: "PUC 2nd Year", segment: "PRE_UNIVERSITY", sortOrder: 1 });
    const units = [
      first,
      second,
      unit({ name: "PCMB", segment: "PRE_UNIVERSITY", parentId: first.id, depth: 1 }),
      unit({ name: "PCMB", segment: "PRE_UNIVERSITY", parentId: second.id, depth: 1 }),
    ];

    expect(deriveOfferings(units, ["PRE_UNIVERSITY"]).coursesOffered).toEqual(["PCMB"]);
  });

  it("orders by the whole ancestor chain, not by raw sortOrder", () => {
    // Both parents hold a child at sortOrder 0. Sorting on sortOrder alone
    // would interleave them; the second parent's children must all follow the
    // first parent's.
    const first = unit({ name: "PUC 1st Year", segment: "PRE_UNIVERSITY", sortOrder: 0 });
    const second = unit({ name: "PUC 2nd Year", segment: "PRE_UNIVERSITY", sortOrder: 1 });
    const units = [
      second,
      unit({ name: "B-second", segment: "PRE_UNIVERSITY", parentId: second.id, depth: 1, sortOrder: 0 }),
      unit({ name: "B-first", segment: "PRE_UNIVERSITY", parentId: first.id, depth: 1, sortOrder: 1 }),
      first,
      unit({ name: "A-first", segment: "PRE_UNIVERSITY", parentId: first.id, depth: 1, sortOrder: 0 }),
    ];

    expect(deriveOfferings(units, ["PRE_UNIVERSITY"]).coursesOffered).toEqual([
      "A-first",
      "B-first",
      "B-second",
    ]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/unit/academic-offerings.test.ts`
Expected: FAIL — cannot resolve `@/lib/academic/offerings`.

- [ ] **Step 3: Write the derivation**

Create `src/lib/academic/offerings.ts`:

```ts
import type { AcademicSegment } from "@/lib/constants";
import { ACADEMIC_BLUEPRINTS, orderSegments } from "./blueprints";

/** The minimum a unit must carry to be derived from. `AcademicUnitDTO` is a superset. */
export type OfferingUnit = {
  id: string;
  segment: string;
  parentId: string | null;
  depth: number;
  name: string;
  sortOrder: number;
  active: boolean;
};

export type DerivedOfferings = {
  classesOffered: string[];
  coursesOffered: string[];
};

/**
 * A unit counts only if it is active *and* every ancestor is active — the
 * read-time deactivation rule, so that hiding a subtree is one reversible write
 * rather than a cascade.
 *
 * The walk is bounded by the starting depth: a well-formed chain reaches a root
 * in exactly `depth` hops, so a corrupt parent link cannot loop forever. An
 * orphan — a parent id that resolves to nothing — reads as inactive, which is
 * the safe direction for something about to be published.
 */
function effectivelyActive(unit: OfferingUnit, byId: Map<string, OfferingUnit>): boolean {
  let current: OfferingUnit | undefined = unit;
  for (let hops = unit.depth; current && hops >= 0; hops -= 1) {
    if (!current.active) return false;
    if (current.parentId === null) return true;
    current = byId.get(current.parentId);
  }
  return false;
}

/**
 * A sort key covering the whole ancestor chain. `sortOrder` is only unique among
 * siblings, so sorting on it alone would interleave two parents' children.
 */
function sortKey(unit: OfferingUnit, byId: Map<string, OfferingUnit>): string {
  const parts: string[] = [];
  let current: OfferingUnit | undefined = unit;
  for (let hops = unit.depth; current && hops >= 0; hops -= 1) {
    parts.unshift(String(current.sortOrder).padStart(6, "0"));
    if (current.parentId === null) break;
    current = byId.get(current.parentId);
  }
  return parts.join(".");
}

/**
 * The names worth publishing on a profile, read from each selected segment's
 * `offeringDepth`. School names become `classesOffered`; every other segment's
 * become `coursesOffered`.
 */
export function deriveOfferings(
  units: OfferingUnit[],
  segments: readonly string[],
): DerivedOfferings {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const classesOffered: string[] = [];
  const coursesOffered: string[] = [];

  for (const segment of orderSegments(segments)) {
    const blueprint = ACADEMIC_BLUEPRINTS[segment as AcademicSegment];
    const target = segment === "SCHOOL" ? classesOffered : coursesOffered;

    const names = units
      .filter(
        (unit) =>
          unit.segment === segment &&
          unit.depth === blueprint.offeringDepth &&
          effectivelyActive(unit, byId),
      )
      .sort((a, b) => sortKey(a, byId).localeCompare(sortKey(b, byId)))
      .map((unit) => unit.name);

    // De-duplicated: a name offered under two parents is one public offering.
    for (const name of names) {
      if (!target.includes(name)) target.push(name);
    }
  }

  return { classesOffered, coursesOffered };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/academic-offerings.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify the whole suite and the types**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **582 tests passing**.

- [ ] **Step 6: Commit**

```bash
git add src/lib/academic/offerings.ts tests/unit/academic-offerings.test.ts
git commit -m "feat: derive publishable offerings from the academic tree"
```

---

### Task 5: The service — list, create, rename, delete

**Files:**
- Create: `src/services/academic-structure.service.ts`
- Test: `tests/integration/academic-structure-crud.test.ts`

**Interfaces:**
- Consumes: `AcademicUnit`, `Institution`, `AcademicUnitDoc` from `@/models`; `notFound`, `validationError` from `@/lib/api/errors`; `levelFor`, `ACADEMIC_BLUEPRINTS`, `defaultSegmentsFor`, `orderSegments` from `@/lib/academic/blueprints`; `ACADEMIC_UNIT_MAX_PER_INSTITUTION`, `AcademicSegment` from `@/lib/constants`; the Task 3 schemas; `ActivityService`.
- Produces: `AcademicStructureService` with `list`, `create`, `update`, `remove`; `AcademicUnitDTO`. Task 6 appends `reorder`, `getSegments`, `setSegments`, `seedFromProfile`, `hasProfileOfferings`, `offeringsFor` to the **same** object.

**Note for the implementer:** Task 6 adds four more methods and two helpers to this same file. Leave the module-level helpers (`toObjectId`, `findOwned`, `segmentsFor`, `pathLabelFor`, `serialize`, `rewriteDescendantPaths`, `subtreeIds`) exported-to-module scope so Task 6 can use them without restructuring.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/academic-structure-crud.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit } from "@/models";
import { AcademicStructureService } from "@/services/academic-structure.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(async () => {
  await startTestDatabase("academic-structure-crud");
  await AcademicUnit.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  // makeInstitution defaults institutionType to SCHOOL, so INS0001's default
  // segment selection is ["SCHOOL"] until a test overrides it.
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
  await makeInstitution("INS0003", { institutionType: "PU_COLLEGE" });
  await makeInstitution("INS0004", { institutionType: "ENGINEERING_COLLEGE" });
});

describe("AcademicStructureService CRUD", () => {
  it("creates a root at depth 0 with its name as the whole path", async () => {
    const created = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 1" },
      actor,
    );

    expect(created.depth).toBe(0);
    expect(created.parentId).toBeNull();
    expect(created.pathLabel).toBe("Grade 1");
    expect(created.sortOrder).toBe(0);
    expect(created.active).toBe(true);
    expect(created.levelKey).toBe("CLASS");
    expect(created.levelLabel).toBe("Class");
  });

  it("appends each new sibling after the last one", async () => {
    await AcademicStructureService.create("INS0001", { segment: "SCHOOL", name: "Grade 1" }, actor);
    const second = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 2" },
      actor,
    );

    expect(second.sortOrder).toBe(1);
  });

  it("creates a child at depth 1 with a joined path label", async () => {
    const year = await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", name: "PUC 1st Year" },
      actor,
    );
    const combination = await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", parentId: year.id, name: "PCMB" },
      actor,
    );

    expect(combination.depth).toBe(1);
    expect(combination.parentId).toBe(year.id);
    expect(combination.pathLabel).toBe("PUC 1st Year › PCMB");
    expect(combination.levelKey).toBe("COMBINATION");
  });

  it("refuses a duplicate sibling name via the unique index, not a pre-read", async () => {
    await AcademicStructureService.create("INS0001", { segment: "SCHOOL", name: "Grade 1" }, actor);

    await expect(
      AcademicStructureService.create("INS0001", { segment: "SCHOOL", name: "Grade 1" }, actor),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("allows the same name under two different parents", async () => {
    const first = await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", name: "PUC 1st Year" },
      actor,
    );
    const second = await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", name: "PUC 2nd Year" },
      actor,
    );

    await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", parentId: first.id, name: "PCMB" },
      actor,
    );
    await expect(
      AcademicStructureService.create(
        "INS0003",
        { segment: "PRE_UNIVERSITY", parentId: second.id, name: "PCMB" },
        actor,
      ),
    ).resolves.toBeDefined();
  });

  it("refuses a child deeper than the blueprint allows", async () => {
    const grade = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 1" },
      actor,
    );

    await expect(
      AcademicStructureService.create(
        "INS0001",
        { segment: "SCHOOL", parentId: grade.id, name: "Section A" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("refuses a parent that belongs to a different segment", async () => {
    await AcademicStructureService.setSegments("INS0004", ["ENGINEERING", "SCHOOL"], actor);
    const programme = await AcademicStructureService.create(
      "INS0004",
      { segment: "ENGINEERING", name: "B.E." },
      actor,
    );

    await expect(
      AcademicStructureService.create(
        "INS0004",
        { segment: "SCHOOL", parentId: programme.id, name: "Grade 1" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("refuses a segment the institution has not selected", async () => {
    await expect(
      AcademicStructureService.create("INS0001", { segment: "UNIVERSITY", name: "UG" }, actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("cascades a rename all the way down to grandchildren", async () => {
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
    const year = await AcademicStructureService.create(
      "INS0004",
      { segment: "ENGINEERING", parentId: branch.id, name: "Year 1" },
      actor,
    );

    await AcademicStructureService.update("INS0004", programme.id, { name: "B.Tech" }, actor);

    const units = await AcademicStructureService.list("INS0004");
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    expect(byId.get(programme.id)?.pathLabel).toBe("B.Tech");
    expect(byId.get(branch.id)?.pathLabel).toBe("B.Tech › Computer Science");
    expect(byId.get(year.id)?.pathLabel).toBe("B.Tech › Computer Science › Year 1");
  });

  it("deletes the whole subtree, not just the node", async () => {
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
    await AcademicStructureService.create(
      "INS0004",
      { segment: "ENGINEERING", parentId: branch.id, name: "Year 1" },
      actor,
    );

    const result = await AcademicStructureService.remove("INS0004", programme.id, actor);

    expect(result.deleted).toBe(3);
    expect(await AcademicStructureService.list("INS0004")).toHaveLength(0);
  });

  it("treats another institution's unit, and another institution's parent, as not found", async () => {
    const mine = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 1" },
      actor,
    );

    await expect(AcademicStructureService.update("INS0002", mine.id, { name: "X" }, actor))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(AcademicStructureService.remove("INS0002", mine.id, actor))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      AcademicStructureService.create(
        "INS0002",
        { segment: "SCHOOL", parentId: mine.id, name: "Grade 2" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A malformed id is the same answer, not a 500.
    await expect(AcademicStructureService.update("INS0001", "not-an-id", { name: "X" }, actor))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
```

**Note:** this test calls `AcademicStructureService.setSegments`, which Task 6 writes. Write a minimal `setSegments` in this task — Task 6 replaces it with the full version including the removal guard. The minimal version is:

```ts
  async setSegments(
    institutionId: string,
    segments: readonly string[],
    _actor: { id: string; name: string },
  ): Promise<AcademicSegment[]> {
    await connectToDatabase();
    const next = orderSegments(segments);
    await Institution.updateOne({ institutionId }, { $set: { "academic.segments": next } });
    return next;
  },
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/integration/academic-structure-crud.test.ts`
Expected: FAIL — cannot resolve `@/services/academic-structure.service`.

- [ ] **Step 3: Write the service**

Create `src/services/academic-structure.service.ts`:

```ts
import "server-only";
import { Types } from "mongoose";
import type { z } from "zod";
import { connectToDatabase } from "@/lib/db/mongoose";
import { AcademicUnit, Institution, type AcademicUnitDoc } from "@/models";
import { notFound, validationError } from "@/lib/api/errors";
import { ACADEMIC_UNIT_MAX_PER_INSTITUTION, type AcademicSegment } from "@/lib/constants";
import {
  ACADEMIC_BLUEPRINTS,
  PATH_SEPARATOR,
  defaultSegmentsFor,
  levelFor,
  orderSegments,
} from "@/lib/academic/blueprints";
import type {
  createAcademicUnitSchema,
  updateAcademicUnitSchema,
} from "@/lib/validation/academic-structure";
import { ActivityService } from "./activity.service";

type CreateInput = z.infer<typeof createAcademicUnitSchema>;
type UpdateInput = z.infer<typeof updateAcademicUnitSchema>;

const ENTITY_TYPE = "ACADEMIC_UNIT";

export type AcademicUnitDTO = {
  id: string;
  segment: AcademicSegment;
  parentId: string | null;
  depth: number;
  levelKey: string;
  levelLabel: string;
  name: string;
  pathLabel: string;
  sortOrder: number;
  active: boolean;
};

/** A malformed id must read as "no such unit", not as a 500. */
function toObjectId(unitId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(unitId)) throw notFound("Academic unit not found");
  return new Types.ObjectId(unitId);
}

function serialize(row: AcademicUnitDoc): AcademicUnitDTO {
  const segment = row.segment as AcademicSegment;
  const level = levelFor(segment, row.depth);
  return {
    id: String(row._id),
    segment,
    parentId: row.parentId ? String(row.parentId) : null,
    depth: row.depth,
    // A depth past the blueprint's end can only come from a blueprint edited
    // after the data was written; it renders as an unnamed tier rather than
    // crashing the page it appears on.
    levelKey: level?.key ?? "",
    levelLabel: level?.label ?? `Level ${row.depth + 1}`,
    name: row.name,
    pathLabel: row.pathLabel,
    sortOrder: row.sortOrder ?? 0,
    active: row.active !== false,
  };
}

/** Every read is scoped by institutionId, so a foreign id is simply not found. */
async function findOwned(institutionId: string, unitId: string): Promise<AcademicUnitDoc> {
  const row = await AcademicUnit.findOne({
    _id: toObjectId(unitId),
    institutionId,
  }).lean<AcademicUnitDoc>();
  if (!row) throw notFound("Academic unit not found");
  return row;
}

/** The stored selection, or the institution type's default when never chosen. */
async function segmentsFor(institutionId: string): Promise<AcademicSegment[]> {
  const institution = await Institution.findOne({ institutionId })
    .select("institutionType academic.segments")
    .lean();
  if (!institution) throw notFound("Institution not found");

  const stored = (institution.academic as { segments?: string[] } | undefined)?.segments;
  return stored?.length ? orderSegments(stored) : defaultSegmentsFor(institution.institutionType);
}

async function pathLabelFor(
  institutionId: string,
  parentId: Types.ObjectId | null,
  name: string,
): Promise<string> {
  if (!parentId) return name;
  const parent = await AcademicUnit.findOne({ _id: parentId, institutionId })
    .select("pathLabel")
    .lean();
  return parent ? `${parent.pathLabel}${PATH_SEPARATOR}${name}` : name;
}

/** `parentId` as the map key a root can also use. */
const parentKey = (parentId: Types.ObjectId | null | undefined): string =>
  parentId ? String(parentId) : "";

type TreeRow = {
  _id: Types.ObjectId;
  parentId: Types.ObjectId | null;
  name: string;
  pathLabel: string;
};

function childrenBucket(rows: TreeRow[]): Map<string, TreeRow[]> {
  const childrenOf = new Map<string, TreeRow[]>();
  for (const row of rows) {
    const key = parentKey(row.parentId);
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(row);
    else childrenOf.set(key, [row]);
  }
  return childrenOf;
}

/**
 * A rename changes every descendant's `pathLabel`. The segment is read once and
 * rewritten in one bulk write — correct at the tree sizes this design commits
 * to (tens of nodes), and `ACADEMIC_UNIT_MAX_PER_INSTITUTION` is what keeps it
 * there.
 */
async function rewriteDescendantPaths(
  institutionId: string,
  root: { _id: Types.ObjectId; segment: string; pathLabel: string },
): Promise<void> {
  const rows = await AcademicUnit.find({ institutionId, segment: root.segment })
    .select("_id parentId name pathLabel")
    .lean<TreeRow[]>();

  const childrenOf = childrenBucket(rows);
  // If this inferred type proves awkward, import `AnyBulkWriteOperation` from
  // mongoose and write `AnyBulkWriteOperation<AcademicUnitDoc>[]` instead. Do
  // not fall back to `any`.
  const operations: Parameters<typeof AcademicUnit.bulkWrite>[0] = [];
  const queue = [{ id: String(root._id), pathLabel: root.pathLabel }];

  while (queue.length > 0) {
    const current = queue.shift() as { id: string; pathLabel: string };
    for (const child of childrenOf.get(current.id) ?? []) {
      const pathLabel = `${current.pathLabel}${PATH_SEPARATOR}${child.name}`;
      if (pathLabel !== child.pathLabel) {
        operations.push({
          updateOne: {
            filter: { _id: child._id, institutionId },
            update: { $set: { pathLabel } },
          },
        });
      }
      // Queued whether or not it changed: a deeper descendant may still need
      // rewriting even when this one already matched.
      queue.push({ id: String(child._id), pathLabel });
    }
  }

  if (operations.length > 0) await AcademicUnit.bulkWrite(operations);
}

/** Every id in the subtree rooted at `root`, the root included. */
async function subtreeIds(
  institutionId: string,
  root: { _id: Types.ObjectId; segment: string },
): Promise<Types.ObjectId[]> {
  const rows = await AcademicUnit.find({ institutionId, segment: root.segment })
    .select("_id parentId name pathLabel")
    .lean<TreeRow[]>();

  const childrenOf = childrenBucket(rows);
  const ids: Types.ObjectId[] = [];
  const queue: Types.ObjectId[] = [root._id];

  while (queue.length > 0) {
    const id = queue.shift() as Types.ObjectId;
    ids.push(id);
    for (const child of childrenOf.get(String(id)) ?? []) queue.push(child._id);
  }
  return ids;
}

export const AcademicStructureService = {
  async list(institutionId: string): Promise<AcademicUnitDTO[]> {
    await connectToDatabase();
    const rows = await AcademicUnit.find({ institutionId })
      .sort({ segment: 1, depth: 1, sortOrder: 1 })
      .lean<AcademicUnitDoc[]>();
    return rows.map(serialize);
  },

  async create(
    institutionId: string,
    input: CreateInput,
    actor: { id: string; name: string },
  ): Promise<AcademicUnitDTO> {
    await connectToDatabase();

    const segments = await segmentsFor(institutionId);
    if (!segments.includes(input.segment)) {
      throw validationError(
        `segment: this institution has not selected ${input.segment} — add it before creating units under it`,
      );
    }

    let parentId: Types.ObjectId | null = null;
    let depth = 0;

    if (input.parentId) {
      // Scoped by institutionId, so a foreign parent reads as "no such parent"
      // — NOT_FOUND, never FORBIDDEN.
      const parent = await findOwned(institutionId, input.parentId);
      if (parent.segment !== input.segment) {
        throw validationError("parentId: the parent belongs to a different segment");
      }
      parentId = parent._id;
      depth = parent.depth + 1;
    }

    if (!levelFor(input.segment, depth)) {
      const { levels } = ACADEMIC_BLUEPRINTS[input.segment];
      throw validationError(
        `parentId: nothing goes beneath ${levels[levels.length - 1]?.label} in ${input.segment}`,
      );
    }

    const total = await AcademicUnit.countDocuments({ institutionId });
    if (total >= ACADEMIC_UNIT_MAX_PER_INSTITUTION) {
      throw validationError(
        `An institution can hold at most ${ACADEMIC_UNIT_MAX_PER_INSTITUTION} academic units`,
      );
    }

    // Appended last among its siblings. Two tabs racing here land on the same
    // sortOrder, which is cosmetic and fixed by one reorder — unlike a
    // duplicate name, which the unique index refuses outright.
    const last = await AcademicUnit.findOne({ institutionId, segment: input.segment, parentId })
      .sort({ sortOrder: -1 })
      .select("sortOrder")
      .lean();

    const created = await AcademicUnit.create({
      institutionId,
      segment: input.segment,
      parentId,
      depth,
      name: input.name,
      pathLabel: await pathLabelFor(institutionId, parentId, input.name),
      sortOrder: (last?.sortOrder ?? -1) + 1,
      active: true,
    });

    await ActivityService.record({
      institutionId,
      entityType: ENTITY_TYPE,
      entityId: created._id,
      entityRef: institutionId,
      action: "Academic unit created",
      description: created.pathLabel,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(created.toObject() as AcademicUnitDoc);
  },

  async update(
    institutionId: string,
    unitId: string,
    patch: UpdateInput,
    actor: { id: string; name: string },
  ): Promise<AcademicUnitDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, unitId);

    const set: Record<string, unknown> = {};
    if (patch.active !== undefined) set.active = patch.active;

    const renaming = patch.name !== undefined && patch.name !== before.name;
    if (renaming) {
      set.name = patch.name;
      set.pathLabel = await pathLabelFor(institutionId, before.parentId, patch.name as string);
    }

    const updated = await AcademicUnit.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<AcademicUnitDoc>();
    if (!updated) throw notFound("Academic unit not found");

    if (renaming) await rewriteDescendantPaths(institutionId, updated);

    await ActivityService.record({
      institutionId,
      entityType: ENTITY_TYPE,
      entityId: updated._id,
      entityRef: institutionId,
      action: renaming ? "Academic unit renamed" : "Academic unit updated",
      description: updated.pathLabel,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },

  async remove(
    institutionId: string,
    unitId: string,
    actor: { id: string; name: string },
  ): Promise<{ deleted: number }> {
    await connectToDatabase();
    const before = await findOwned(institutionId, unitId);

    // Phase 6 obligation (spec §15): once `FeeStructure.academicUnitId` exists,
    // a delete whose subtree is referenced by any fee structure must be refused
    // right here. Nothing references a unit in Phase 5, so this is unguarded.
    const ids = await subtreeIds(institutionId, before);
    await AcademicUnit.deleteMany({ _id: { $in: ids }, institutionId });

    await ActivityService.record({
      institutionId,
      entityType: ENTITY_TYPE,
      entityId: before._id,
      entityRef: institutionId,
      action: "Academic unit deleted",
      description:
        ids.length > 1
          ? `${before.pathLabel} and ${ids.length - 1} unit(s) beneath it`
          : before.pathLabel,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return { deleted: ids.length };
  },

  /**
   * Minimal for Task 5 — Task 6 replaces this with the version that refuses to
   * deselect a segment that still holds units, and records to the audit trail.
   */
  async setSegments(
    institutionId: string,
    segments: readonly string[],
    _actor: { id: string; name: string },
  ): Promise<AcademicSegment[]> {
    await connectToDatabase();
    const next = orderSegments(segments);
    await Institution.updateOne({ institutionId }, { $set: { "academic.segments": next } });
    return next;
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/integration/academic-structure-crud.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Mutation-check the depth guard**

Comment out the `if (!levelFor(input.segment, depth))` block, re-run
`npx vitest run tests/integration/academic-structure-crud.test.ts -t "deeper than the blueprint"`.
Expected: FAIL. Restore it and re-run: PASS. A guard whose test passes without it is not a tested guard.

- [ ] **Step 6: Verify the whole suite and the types**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **593 tests passing**.

- [ ] **Step 7: Commit**

```bash
git add src/services/academic-structure.service.ts tests/integration/academic-structure-crud.test.ts
git commit -m "feat: add academic structure list, create, rename and delete"
```

---

### Task 6: The service — reorder, segments, and seeding

**Files:**
- Modify: `src/services/academic-structure.service.ts`
- Test: `tests/integration/academic-structure-config.test.ts`

**Interfaces:**
- Consumes: everything Task 5 produced in this file, plus `deriveOfferings`/`DerivedOfferings` from `@/lib/academic/offerings` and `reorderAcademicUnitsSchema` from the Task 3 module.
- Produces: `AcademicStructureService.reorder`, `.getSegments`, `.setSegments` (full version, replacing Task 5's minimal one), `.seedFromProfile`, `.hasProfileOfferings`, `.offeringsFor`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/academic-structure-config.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit } from "@/models";
import { AcademicStructureService } from "@/services/academic-structure.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(async () => {
  await startTestDatabase("academic-structure-config");
  await AcademicUnit.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002", { institutionType: "PU_COLLEGE" });
});

async function grades(institutionId: string, ...names: string[]) {
  const created = [];
  for (const name of names) {
    created.push(
      await AcademicStructureService.create(institutionId, { segment: "SCHOOL", name }, actor),
    );
  }
  return created;
}

describe("AcademicStructureService reorder", () => {
  it("rewrites sortOrder to match the order it was given", async () => {
    const [one, two, three] = await grades("INS0001", "Grade 1", "Grade 2", "Grade 3");

    const reordered = await AcademicStructureService.reorder(
      "INS0001",
      { segment: "SCHOOL", parentId: null, orderedIds: [three.id, one.id, two.id] },
      actor,
    );

    expect(reordered.map((unit) => unit.name)).toEqual(["Grade 3", "Grade 1", "Grade 2"]);
    expect(reordered.map((unit) => unit.sortOrder)).toEqual([0, 1, 2]);
  });

  it("refuses a partial sibling list rather than silently interleaving", async () => {
    const [one] = await grades("INS0001", "Grade 1", "Grade 2");

    await expect(
      AcademicStructureService.reorder(
        "INS0001",
        { segment: "SCHOOL", parentId: null, orderedIds: [one.id] },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("refuses a list holding another institution's id", async () => {
    const [mine, alsoMine] = await grades("INS0001", "Grade 1", "Grade 2");
    // INS0002 is a PU college, so its unit lives in its own segment. What makes
    // this fail is ownership, not the segment: the id is simply not in INS0001's
    // sibling set, which is the tenant check and the completeness check at once.
    const theirs = await AcademicStructureService.create(
      "INS0002",
      { segment: "PRE_UNIVERSITY", name: "PUC 1st Year" },
      actor,
    );
    expect(theirs.id).not.toBe(mine.id);

    await expect(
      AcademicStructureService.reorder(
        "INS0001",
        { segment: "SCHOOL", parentId: null, orderedIds: [mine.id, theirs.id] },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // The legitimate sibling is untouched by the refusal.
    const after = await AcademicStructureService.list("INS0001");
    expect(after.find((unit) => unit.id === alsoMine.id)?.sortOrder).toBe(1);
  });
});

describe("AcademicStructureService segments", () => {
  it("falls back to the institution type's default until one is chosen", async () => {
    expect(await AcademicStructureService.getSegments("INS0001")).toEqual(["SCHOOL"]);
    expect(await AcademicStructureService.getSegments("INS0002")).toEqual(["PRE_UNIVERSITY"]);
  });

  it("stores a selection in declaration order, not the order it was given", async () => {
    const saved = await AcademicStructureService.setSegments(
      "INS0001",
      ["PRE_UNIVERSITY", "SCHOOL"],
      actor,
    );

    expect(saved).toEqual(["SCHOOL", "PRE_UNIVERSITY"]);
    expect(await AcademicStructureService.getSegments("INS0001")).toEqual([
      "SCHOOL",
      "PRE_UNIVERSITY",
    ]);
  });

  it("refuses to deselect a segment that still holds units", async () => {
    await AcademicStructureService.setSegments("INS0001", ["SCHOOL", "PRE_UNIVERSITY"], actor);
    await grades("INS0001", "Grade 1");

    await expect(
      AcademicStructureService.setSegments("INS0001", ["PRE_UNIVERSITY"], actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("allows deselecting a segment that holds nothing", async () => {
    await AcademicStructureService.setSegments("INS0001", ["SCHOOL", "PRE_UNIVERSITY"], actor);
    await grades("INS0001", "Grade 1");

    await expect(
      AcademicStructureService.setSegments("INS0001", ["SCHOOL"], actor),
    ).resolves.toEqual(["SCHOOL"]);
  });
});

describe("AcademicStructureService seeding", () => {
  it("seeds classes and courses into the segments spec §10 tabulates", async () => {
    await makeInstitution("INS0003", {
      institutionType: "SCHOOL",
      academic: {
        classesOffered: ["Grade 1", "Grade 2"],
        coursesOffered: ["PCMB"],
        segments: ["SCHOOL", "PRE_UNIVERSITY"],
      },
    });

    const result = await AcademicStructureService.seedFromProfile("INS0003", actor);
    expect(result).toEqual({ created: 3, skipped: 0 });

    const units = await AcademicStructureService.list("INS0003");
    expect(units.filter((unit) => unit.segment === "SCHOOL").map((unit) => unit.name)).toEqual([
      "Grade 1",
      "Grade 2",
    ]);
    expect(
      units.filter((unit) => unit.segment === "PRE_UNIVERSITY").map((unit) => unit.name),
    ).toEqual(["PCMB"]);
  });

  it("falls back to the only selected segment when the preferred one is not selected", async () => {
    await makeInstitution("INS0004", {
      institutionType: "PU_COLLEGE",
      academic: { classesOffered: ["Grade 1"], segments: ["PRE_UNIVERSITY"] },
    });

    await AcademicStructureService.seedFromProfile("INS0004", actor);

    const units = await AcademicStructureService.list("INS0004");
    expect(units).toHaveLength(1);
    expect(units[0].segment).toBe("PRE_UNIVERSITY");
  });

  it("skips blanks and repeats, and reports how many it skipped", async () => {
    await makeInstitution("INS0005", {
      academic: { classesOffered: ["Grade 1", "  ", "Grade 1", "Grade 2"], segments: ["SCHOOL"] },
    });

    expect(await AcademicStructureService.seedFromProfile("INS0005", actor)).toEqual({
      created: 2,
      skipped: 2,
    });
  });

  it("refuses a second run, leaving the first run's units untouched", async () => {
    await makeInstitution("INS0006", {
      academic: { classesOffered: ["Grade 1"], segments: ["SCHOOL"] },
    });
    await AcademicStructureService.seedFromProfile("INS0006", actor);

    await expect(AcademicStructureService.seedFromProfile("INS0006", actor)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(await AcademicStructureService.list("INS0006")).toHaveLength(1);
  });

  it("reports whether there is anything on the profile worth seeding", async () => {
    await makeInstitution("INS0007", { academic: { classesOffered: ["Grade 1"] } });

    expect(await AcademicStructureService.hasProfileOfferings("INS0007")).toBe(true);
    expect(await AcademicStructureService.hasProfileOfferings("INS0001")).toBe(false);
  });
});

describe("AcademicStructureService offeringsFor", () => {
  it("returns null with no tree, and derived arrays once one exists", async () => {
    expect(await AcademicStructureService.offeringsFor("INS0001")).toBeNull();

    await grades("INS0001", "Grade 1");
    expect(await AcademicStructureService.offeringsFor("INS0001")).toEqual({
      classesOffered: ["Grade 1"],
      coursesOffered: [],
    });
  });

  it("returns null once every unit has been deactivated", async () => {
    const [one] = await grades("INS0001", "Grade 1");
    await AcademicStructureService.update("INS0001", one.id, { active: false }, actor);

    expect(await AcademicStructureService.offeringsFor("INS0001")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/integration/academic-structure-config.test.ts`
Expected: FAIL — `reorder` is not a function.

- [ ] **Step 3: Extend the imports**

In `src/services/academic-structure.service.ts`, add to the validation import:

```ts
import type {
  createAcademicUnitSchema,
  reorderAcademicUnitsSchema,
  updateAcademicUnitSchema,
} from "@/lib/validation/academic-structure";
```

add the type alias beside the existing two:

```ts
type ReorderInput = z.infer<typeof reorderAcademicUnitsSchema>;
```

and add:

```ts
import { deriveOfferings, type DerivedOfferings } from "@/lib/academic/offerings";
```

- [ ] **Step 4: Replace `setSegments` and add the rest**

Replace Task 5's minimal `setSegments` with the version below, and add the other methods after it, all inside the same `AcademicStructureService` object:

```ts
  async reorder(
    institutionId: string,
    input: ReorderInput,
    actor: { id: string; name: string },
  ): Promise<AcademicUnitDTO[]> {
    await connectToDatabase();

    const parentId = input.parentId ? toObjectId(input.parentId) : null;
    const siblings = await AcademicUnit.find({
      institutionId,
      segment: input.segment,
      parentId,
    })
      .select("_id")
      .lean<{ _id: Types.ObjectId }[]>();

    const actual = new Set(siblings.map((row) => String(row._id)));
    const requested = new Set(input.orderedIds);

    // An exact set match, not a subset. A partial list would leave the
    // unmentioned siblings holding stale sortOrders and interleave them
    // silently; an id from another parent — or another tenant — is simply not
    // in `actual`, so this is the tenant check too.
    const matches =
      requested.size === input.orderedIds.length &&
      requested.size === actual.size &&
      input.orderedIds.every((id) => actual.has(id));
    if (!matches) {
      throw validationError("orderedIds: must list every sibling exactly once");
    }

    await AcademicUnit.bulkWrite(
      input.orderedIds.map((id, index) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(id), institutionId },
          update: { $set: { sortOrder: index } },
        },
      })),
    );

    await ActivityService.record({
      institutionId,
      entityType: ENTITY_TYPE,
      entityRef: institutionId,
      action: "Academic units reordered",
      description: `${input.orderedIds.length} unit(s) in ${input.segment}`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    const rows = await AcademicUnit.find({ institutionId, segment: input.segment, parentId })
      .sort({ sortOrder: 1 })
      .lean<AcademicUnitDoc[]>();
    return rows.map(serialize);
  },

  async getSegments(institutionId: string): Promise<AcademicSegment[]> {
    await connectToDatabase();
    return segmentsFor(institutionId);
  },

  async setSegments(
    institutionId: string,
    segments: readonly string[],
    actor: { id: string; name: string },
  ): Promise<AcademicSegment[]> {
    await connectToDatabase();

    const next = orderSegments(segments);
    const current = await segmentsFor(institutionId);
    const removed = current.filter((segment) => !next.includes(segment));

    if (removed.length > 0) {
      // Refused rather than cascaded: deselecting a segment is a configuration
      // change, and silently deleting a term's worth of structure behind it is
      // not something an unticked checkbox should be able to do.
      const blocking = await AcademicUnit.countDocuments({
        institutionId,
        segment: { $in: removed },
      });
      if (blocking > 0) {
        throw validationError(
          `segments: delete the ${blocking} unit(s) under ${removed.join(", ")} before deselecting`,
        );
      }
    }

    await Institution.updateOne({ institutionId }, { $set: { "academic.segments": next } });

    await ActivityService.record({
      institutionId,
      entityType: ENTITY_TYPE,
      entityRef: institutionId,
      action: "Academic segments updated",
      description: next.join(", "),
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return next;
  },

  /** Whether the profile still holds hand-typed offerings worth importing. */
  async hasProfileOfferings(institutionId: string): Promise<boolean> {
    await connectToDatabase();
    const institution = await Institution.findOne({ institutionId })
      .select("academic.classesOffered academic.coursesOffered")
      .lean();
    const academic = (institution?.academic ?? {}) as {
      classesOffered?: string[];
      coursesOffered?: string[];
    };
    return (academic.classesOffered?.length ?? 0) + (academic.coursesOffered?.length ?? 0) > 0;
  },

  /**
   * The one-time import that keeps removing two profile inputs from costing an
   * institution the data it already typed. Idempotent by construction: the
   * zero-units precondition means a second call finds units and refuses.
   */
  async seedFromProfile(
    institutionId: string,
    actor: { id: string; name: string },
  ): Promise<{ created: number; skipped: number }> {
    await connectToDatabase();

    const existing = await AcademicUnit.countDocuments({ institutionId });
    if (existing > 0) {
      throw validationError(
        "Seeding is only available while the academic structure is still empty",
      );
    }

    const institution = await Institution.findOne({ institutionId })
      .select("institutionType academic")
      .lean();
    if (!institution) throw notFound("Institution not found");

    const academic = (institution.academic ?? {}) as {
      classesOffered?: string[];
      coursesOffered?: string[];
      segments?: string[];
    };
    const classes = academic.classesOffered ?? [];
    const courses = academic.coursesOffered ?? [];
    if (classes.length === 0 && courses.length === 0) {
      throw validationError("There is nothing on the profile to seed from");
    }

    const segments = academic.segments?.length
      ? orderSegments(academic.segments)
      : defaultSegmentsFor(institution.institutionType);

    // Preferred segment per array, each with one fallback. `segments` always
    // holds at least one entry, so both always resolve and no entry is ever
    // left with nowhere to go.
    const fallback = segments[0] as AcademicSegment;
    const classSegment: AcademicSegment = segments.includes("SCHOOL") ? "SCHOOL" : fallback;
    const courseSegment: AcademicSegment =
      segments.find((segment) => segment !== "SCHOOL") ?? fallback;

    const pending = [
      ...classes.map((name) => ({ segment: classSegment, name })),
      ...courses.map((name) => ({ segment: courseSegment, name })),
    ];

    const seen = new Set<string>();
    const nextSortOrder = new Map<AcademicSegment, number>();
    const documents: Record<string, unknown>[] = [];
    let skipped = 0;

    for (const entry of pending) {
      const name = String(entry.name).trim();
      const key = `${entry.segment}:${name}`;
      if (name.length === 0 || seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);

      const sortOrder = nextSortOrder.get(entry.segment) ?? 0;
      nextSortOrder.set(entry.segment, sortOrder + 1);
      documents.push({
        institutionId,
        segment: entry.segment,
        parentId: null,
        depth: 0,
        name,
        pathLabel: name,
        sortOrder,
        active: true,
      });
    }

    if (documents.length > 0) await AcademicUnit.insertMany(documents);

    await ActivityService.record({
      institutionId,
      entityType: ENTITY_TYPE,
      entityRef: institutionId,
      action: "Academic structure seeded from profile",
      description: `${documents.length} created, ${skipped} skipped`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return { created: documents.length, skipped };
  },

  /**
   * `null` when there is nothing to derive. The public profile path then leaves
   * the stored arrays alone, so an institution that has not built a tree — or
   * has deactivated all of it — keeps publishing exactly what it publishes
   * today. Nothing disappears from a live profile on release day.
   */
  async offeringsFor(institutionId: string): Promise<DerivedOfferings | null> {
    await connectToDatabase();
    const units = await AcademicStructureService.list(institutionId);
    if (units.length === 0) return null;

    const offerings = deriveOfferings(units, await segmentsFor(institutionId));
    if (offerings.classesOffered.length === 0 && offerings.coursesOffered.length === 0) {
      return null;
    }
    return offerings;
  },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/integration/academic-structure-config.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Mutation-check the two guards that matter**

1. Change the reorder set match to `input.orderedIds.every((id) => actual.has(id))` alone (dropping the size checks), re-run `-t "partial sibling list"`. Expected: FAIL. Restore, re-run: PASS.
2. Delete the `if (blocking > 0)` throw, re-run `-t "still holds units"`. Expected: FAIL. Restore, re-run: PASS.

- [ ] **Step 7: Verify the whole suite and the types**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **607 tests passing**.

- [ ] **Step 8: Commit**

```bash
git add src/services/academic-structure.service.ts tests/integration/academic-structure-config.test.ts
git commit -m "feat: add academic structure reorder, segment selection and profile seeding"
```

---

### Task 7: The API routes

**Files:**
- Create: `src/app/api/settings/academic-structure/route.ts`, `.../segments/route.ts`, `.../units/route.ts`, `.../units/[unitId]/route.ts`, `.../reorder/route.ts`, `.../seed/route.ts`
- Test: `tests/integration/academic-structure-routes.test.ts`

**Interfaces:**
- Consumes: `requireInstitution` from `@/lib/tenant`; `assertSameOrigin` from `@/lib/api/csrf`; `handleApiError`, `jsonSuccess` from `@/lib/api/response`; every Task 3 schema; every Task 5/6 service method; `ACADEMIC_BLUEPRINTS` and `ACADEMIC_SEGMENTS`.
- Produces: the six route modules and their named handler exports.

**Do not** touch `src/lib/api/openapi.ts`. Phase 5 adds no public path; the `api-contract.test.ts` count stays at 9.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/academic-structure-routes.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { GET as getStructure } from "@/app/api/settings/academic-structure/route";
import { PUT as putSegments } from "@/app/api/settings/academic-structure/segments/route";
import { POST as createUnit } from "@/app/api/settings/academic-structure/units/route";
import {
  DELETE as deleteUnit,
  PATCH as patchUnit,
} from "@/app/api/settings/academic-structure/units/[unitId]/route";
import { POST as reorderUnits } from "@/app/api/settings/academic-structure/reorder/route";
import { POST as seedStructure } from "@/app/api/settings/academic-structure/seed/route";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { AcademicUnit } from "@/models";

function cookieRequest(init: { body?: unknown; origin?: string } = {}) {
  const url = new URL("http://localhost/api/settings/academic-structure");
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

const ORIGIN = "http://localhost";

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

/** Platform-admin session: no institutionId, role SUPER_ADMIN — the 403 case. */
async function signInPlatformAdmin(email = "platform-academic@example.test") {
  const user = await makeUser(undefined, "SUPER_ADMIN", email);
  const token = await signSession({
    sub: String(user._id),
    role: "SUPER_ADMIN",
    institutionId: undefined,
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
}

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };
const unitContext = (unitId: string) =>
  ({ params: Promise.resolve({ unitId }) }) as unknown as never;

beforeAll(async () => {
  await startTestDatabase("academic-structure-routes");
  await AcademicUnit.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("academic structure routes — admin access", () => {
  it("returns segments, every available segment, every blueprint, and the units", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    await AcademicStructureService.create("INS0001", { segment: "SCHOOL", name: "Grade 1" }, actor);

    const payload = await (await getStructure()).json();

    expect(payload.success).toBe(true);
    expect(payload.segments).toEqual(["SCHOOL"]);
    expect(payload.availableSegments).toContain("UNIVERSITY");
    // The whole map, not just the selected segments': the checkbox row has to
    // label segments the institution has not ticked.
    expect(payload.blueprints.UNIVERSITY.levels).toHaveLength(4);
    expect(payload.units).toHaveLength(1);
  });

  it("creates a unit — 201", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createUnit(
      cookieRequest({ body: { segment: "SCHOOL", name: "Grade 1" }, origin: ORIGIN }),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).unit.pathLabel).toBe("Grade 1");
  });

  it("patches, reorders, seeds and deletes for its own institution", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    const one = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 1" },
      actor,
    );
    const two = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 2" },
      actor,
    );

    const patched = await patchUnit(
      cookieRequest({ body: { name: "Class 1" }, origin: ORIGIN }),
      unitContext(one.id),
    );
    expect((await patched.json()).unit.name).toBe("Class 1");

    const reordered = await reorderUnits(
      cookieRequest({
        body: { segment: "SCHOOL", parentId: null, orderedIds: [two.id, one.id] },
        origin: ORIGIN,
      }),
    );
    expect((await reordered.json()).units.map((u: { name: string }) => u.name)).toEqual([
      "Grade 2",
      "Class 1",
    ]);

    const deleted = await deleteUnit(cookieRequest({ origin: ORIGIN }), unitContext(one.id));
    expect((await deleted.json()).deleted).toBe(1);
  });

  it("replaces the segment selection, and refuses to drop one still holding units", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    await AcademicStructureService.create("INS0001", { segment: "SCHOOL", name: "Grade 1" }, actor);

    const widened = await putSegments(
      cookieRequest({ body: { segments: ["PRE_UNIVERSITY", "SCHOOL"] }, origin: ORIGIN }),
    );
    expect((await widened.json()).segments).toEqual(["SCHOOL", "PRE_UNIVERSITY"]);

    const narrowed = await putSegments(
      cookieRequest({ body: { segments: ["PRE_UNIVERSITY"] }, origin: ORIGIN }),
    );
    expect(narrowed.status).toBe(400);
  });

  it("seeds from the profile", async () => {
    await makeInstitution("INS0009", { academic: { classesOffered: ["Grade 1", "Grade 2"] } });
    await signIn("INS0009", "INSTITUTION_ADMIN", "admin@ins0009.edu.in");

    const response = await seedStructure(cookieRequest({ origin: ORIGIN }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: 2, skipped: 0 });
  });
});

describe("academic structure routes — who is turned away", () => {
  it("rejects an anonymous caller on every route", async () => {
    expect((await getStructure()).status).toBe(401);
    expect((await createUnit(cookieRequest({ origin: ORIGIN }))).status).toBe(401);
    expect((await putSegments(cookieRequest({ origin: ORIGIN }))).status).toBe(401);
    expect((await reorderUnits(cookieRequest({ origin: ORIGIN }))).status).toBe(401);
    expect((await seedStructure(cookieRequest({ origin: ORIGIN }))).status).toBe(401);
    expect(
      (await patchUnit(cookieRequest({ origin: ORIGIN }), unitContext("6a887abd755db527bea51204")))
        .status,
    ).toBe(401);
    expect(
      (await deleteUnit(cookieRequest({ origin: ORIGIN }), unitContext("6a887abd755db527bea51204")))
        .status,
    ).toBe(401);
  });

  it("rejects a Counselor and a Front Desk session", async () => {
    await signIn("INS0001", "COUNSELOR", "counselor@infinityschool.edu.in");
    expect((await getStructure()).status).toBe(403);
    expect(
      (await createUnit(cookieRequest({ body: { segment: "SCHOOL", name: "X" }, origin: ORIGIN })))
        .status,
    ).toBe(403);

    (await cookies()).delete(SESSION_COOKIE);
    await signIn("INS0001", "FRONT_DESK", "desk@infinityschool.edu.in");
    expect((await getStructure()).status).toBe(403);
    expect((await putSegments(cookieRequest({ body: { segments: ["SCHOOL"] }, origin: ORIGIN })))
      .status).toBe(403);
  });

  it("rejects the platform admin, who has no route into tenant data", async () => {
    await signInPlatformAdmin();

    expect((await getStructure()).status).toBe(403);
    expect(
      (await createUnit(cookieRequest({ body: { segment: "SCHOOL", name: "X" }, origin: ORIGIN })))
        .status,
    ).toBe(403);
    expect((await seedStructure(cookieRequest({ origin: ORIGIN }))).status).toBe(403);
  });

  it("answers NOT_FOUND, never FORBIDDEN, for another institution's unit", async () => {
    const theirs = await AcademicStructureService.create(
      "INS0002",
      { segment: "SCHOOL", name: "Grade 1" },
      actor,
    );
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const patched = await patchUnit(
      cookieRequest({ body: { name: "Mine now" }, origin: ORIGIN }),
      unitContext(theirs.id),
    );
    expect(patched.status).toBe(404);
    expect((await patched.json()).error.code).toBe("NOT_FOUND");

    const deleted = await deleteUnit(cookieRequest({ origin: ORIGIN }), unitContext(theirs.id));
    expect(deleted.status).toBe(404);

    // A foreign parent is "no such parent", not "not yours".
    const created = await createUnit(
      cookieRequest({ body: { segment: "SCHOOL", parentId: theirs.id, name: "X" }, origin: ORIGIN }),
    );
    expect(created.status).toBe(404);
    expect((await created.json()).error.code).toBe("NOT_FOUND");
  });

  it("rejects a cross-origin write", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createUnit(
      cookieRequest({ body: { segment: "SCHOOL", name: "X" }, origin: "http://evil.test" }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/integration/academic-structure-routes.test.ts`
Expected: FAIL — none of the route modules resolve.

- [ ] **Step 3: Write the read route**

Create `src/app/api/settings/academic-structure/route.ts`:

```ts
import { requireInstitution } from "@/lib/tenant";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { ACADEMIC_BLUEPRINTS } from "@/lib/academic/blueprints";
import { ACADEMIC_SEGMENTS, ACADEMIC_SEGMENT_LABELS } from "@/lib/constants";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** One call feeds the whole editor: the selection, the vocabulary, and the data. */
export async function GET() {
  try {
    const { institution } = await requireInstitution();

    const [segments, units] = await Promise.all([
      AcademicStructureService.getSegments(institution.institutionId),
      AcademicStructureService.list(institution.institutionId),
    ]);

    return jsonSuccess({
      segments,
      // The full map, not just the selected segments': the segment checkbox row
      // has to label segments the institution has not ticked, and the editor
      // must never hardcode a level label.
      availableSegments: ACADEMIC_SEGMENTS,
      segmentLabels: ACADEMIC_SEGMENT_LABELS,
      blueprints: ACADEMIC_BLUEPRINTS,
      units,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: Write the five mutating routes**

`src/app/api/settings/academic-structure/segments/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateSegmentsSchema } from "@/lib/validation/academic-structure";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const { segments } = updateSegmentsSchema.parse(await request.json().catch(() => ({})));

    const saved = await AcademicStructureService.setSegments(
      institution.institutionId,
      segments,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ segments: saved });
  } catch (error) {
    return handleApiError(error);
  }
}
```

`src/app/api/settings/academic-structure/units/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { createAcademicUnitSchema } from "@/lib/validation/academic-structure";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = createAcademicUnitSchema.parse(await request.json().catch(() => ({})));

    const unit = await AcademicStructureService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ unit }, { status: 201 });
  } catch (error) {
    // A duplicate sibling name arrives here as a Mongo 11000, which
    // handleApiError already maps to CONFLICT.
    return handleApiError(error);
  }
}
```

`src/app/api/settings/academic-structure/units/[unitId]/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateAcademicUnitSchema } from "@/lib/validation/academic-structure";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/academic-structure/units/[unitId]">,
) {
  try {
    assertSameOrigin(request);
    const { unitId } = await context.params;
    const { user, institution } = await requireInstitution();
    const patch = updateAcademicUnitSchema.parse(await request.json().catch(() => ({})));

    const unit = await AcademicStructureService.update(
      institution.institutionId,
      unitId,
      patch,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ unit });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/academic-structure/units/[unitId]">,
) {
  try {
    assertSameOrigin(request);
    const { unitId } = await context.params;
    const { user, institution } = await requireInstitution();

    const { deleted } = await AcademicStructureService.remove(
      institution.institutionId,
      unitId,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ deleted });
  } catch (error) {
    return handleApiError(error);
  }
}
```

`src/app/api/settings/academic-structure/reorder/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { reorderAcademicUnitsSchema } from "@/lib/validation/academic-structure";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/**
 * Its own endpoint rather than a PATCH per unit: one atomic rewrite across a
 * sibling set. Issued as N patches, the order would be broken between requests.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = reorderAcademicUnitsSchema.parse(await request.json().catch(() => ({})));

    const units = await AcademicStructureService.reorder(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ units });
  } catch (error) {
    return handleApiError(error);
  }
}
```

`src/app/api/settings/academic-structure/seed/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();

    const result = await AcademicStructureService.seedFromProfile(institution.institutionId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess(result);
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/integration/academic-structure-routes.test.ts`
Expected: PASS, 10 tests.

If `unitContext` does not type-check against the generated `RouteContext`, cast it as the test already does (`as unknown as never`) — do **not** loosen the handler's own signature.

- [ ] **Step 6: Mutation-check the tenant boundary**

In `findOwned` (the service), drop `institutionId` from the filter. Re-run
`npx vitest run tests/integration/academic-structure-routes.test.ts -t "NOT_FOUND, never FORBIDDEN"`.
Expected: FAIL. Restore it and re-run: PASS.

- [ ] **Step 7: Verify the whole suite and the types**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **617 tests passing**. `tests/unit/api-contract.test.ts` must still pass unchanged — if it fails, you edited `openapi.ts`, which this task forbids.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/settings/academic-structure tests/integration/academic-structure-routes.test.ts
git commit -m "feat: add the academic structure admin API"
```

---

### Task 8: Derived offerings on the public profile

**Files:**
- Modify: `src/lib/profile/public-projection.ts`, `src/services/institution.service.ts`
- Test: `tests/integration/academic-structure-profile.test.ts`

**Interfaces:**
- Consumes: `AcademicStructureService.offeringsFor` from Task 6.
- Produces: `toPublicProfile(institution, offerings?)` — the second parameter **must** be optional. `toPublicProfile` has one production call site and eight call sites in `tests/unit/public-projection.test.ts`, and none of them may need editing.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/academic-structure-profile.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit } from "@/models";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { InstitutionService } from "@/services/institution.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

async function publishedInstitution(institutionId: string, overrides: Record<string, unknown> = {}) {
  return makeInstitution(institutionId, {
    active: true,
    profileStatus: "PUBLISHED",
    ...overrides,
  });
}

beforeAll(async () => {
  await startTestDatabase("academic-structure-profile");
  await AcademicUnit.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("public profile offerings", () => {
  it("keeps publishing the stored arrays while no tree exists", async () => {
    await publishedInstitution("INS0001", {
      academic: { classesOffered: ["Typed by hand"], coursesOffered: ["Also typed"] },
    });

    const profile = await InstitutionService.getPublicProfile({ institutionId: "INS0001" });

    expect(profile?.academic?.classesOffered).toEqual(["Typed by hand"]);
    expect(profile?.academic?.coursesOffered).toEqual(["Also typed"]);
  });

  it("publishes the derived values once a tree exists", async () => {
    await publishedInstitution("INS0002", {
      academic: { classesOffered: ["Stale"], coursesOffered: ["Also stale"] },
    });
    await AcademicStructureService.create("INS0002", { segment: "SCHOOL", name: "Grade 9" }, actor);
    await AcademicStructureService.create("INS0002", { segment: "SCHOOL", name: "Grade 10" }, actor);

    const profile = await InstitutionService.getPublicProfile({ institutionId: "INS0002" });

    expect(profile?.academic?.classesOffered).toEqual(["Grade 9", "Grade 10"]);
    expect(profile?.academic?.coursesOffered).toBeUndefined();
  });

  it("reads a PU tree at the combination tier", async () => {
    await publishedInstitution("INS0003", { institutionType: "PU_COLLEGE" });
    const year = await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", name: "PUC 1st Year" },
      actor,
    );
    await AcademicStructureService.create(
      "INS0003",
      { segment: "PRE_UNIVERSITY", parentId: year.id, name: "PCMB" },
      actor,
    );

    const profile = await InstitutionService.getPublicProfile({ institutionId: "INS0003" });

    expect(profile?.academic?.coursesOffered).toEqual(["PCMB"]);
    expect(profile?.academic?.classesOffered).toBeUndefined();
  });

  it("falls back to the stored arrays when every unit is deactivated", async () => {
    await publishedInstitution("INS0004", { academic: { classesOffered: ["Fallback"] } });
    const grade = await AcademicStructureService.create(
      "INS0004",
      { segment: "SCHOOL", name: "Grade 1" },
      actor,
    );
    await AcademicStructureService.update("INS0004", grade.id, { active: false }, actor);

    const profile = await InstitutionService.getPublicProfile({ institutionId: "INS0004" });

    expect(profile?.academic?.classesOffered).toEqual(["Fallback"]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/integration/academic-structure-profile.test.ts`
Expected: FAIL on the second test — the stored arrays are still published.

- [ ] **Step 3: Widen the projection**

In `src/lib/profile/public-projection.ts`, change the signature:

```ts
export function toPublicProfile(
  institution: Doc,
  /**
   * Offerings derived from the academic tree. Optional on purpose: without it
   * the stored arrays are used exactly as before, which is what an institution
   * that has not built a tree keeps publishing.
   */
  offerings?: { classesOffered: string[]; coursesOffered: string[] },
) {
```

and replace only the two `classesOffered` / `coursesOffered` lines inside the `academic` block:

```ts
    classesOffered: list(
      offerings
        ? offerings.classesOffered
        : (doc.academic as Record<string, unknown> | undefined)?.classesOffered,
    ),
    coursesOffered: list(
      offerings
        ? offerings.coursesOffered
        : (doc.academic as Record<string, unknown> | undefined)?.coursesOffered,
    ),
```

`list` still applies to both, so an empty array drops the key rather than publishing `[]` — unchanged behaviour. Leave every other line in the block exactly as it is.

- [ ] **Step 4: Supply them from the service**

In `src/services/institution.service.ts`, add the import:

```ts
import { AcademicStructureService } from "./academic-structure.service";
```

and in `getPublicProfile`, replace the final `return toPublicProfile(row as Record<string, unknown>);` with:

```ts
    // Derived offerings replace the stored arrays only when a tree exists, so
    // nothing disappears from a live public profile on release day.
    const offerings = await AcademicStructureService.offeringsFor(row.institutionId);
    return toPublicProfile(row as Record<string, unknown>, offerings ?? undefined);
```

There is no import cycle: `academic-structure.service` imports the `Institution` **model**, not this service.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/integration/academic-structure-profile.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify the whole suite and the types**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **621 tests passing**. `tests/unit/public-projection.test.ts` must pass **unedited** — if it does not, the second parameter is not optional.

- [ ] **Step 7: Commit**

```bash
git add src/lib/profile/public-projection.ts src/services/institution.service.ts tests/integration/academic-structure-profile.test.ts
git commit -m "feat: derive the public profile's offerings from the academic tree"
```

---

### Task 9: The editor page, segment selector, and navigation

**Files:**
- Create: `src/app/(dashboard)/academic-structure/page.tsx`, `src/components/academic/academic-structure-view.tsx`, `src/components/academic/segment-selector.tsx`, `src/components/academic/unit-tree.tsx`
- Modify: `src/components/dashboard/nav-config.ts`, `tests/integration/admin-only-pages.test.ts`

**Interfaces:**
- Consumes: `AcademicStructureService.getSegments`, `.list`, `.hasProfileOfferings`; `ACADEMIC_BLUEPRINTS`; `ACADEMIC_SEGMENTS`, `ACADEMIC_SEGMENT_LABELS`.
- Produces: `AcademicStructureView`, `SegmentSelector`, `UnitTree`, `flattenTree`. Task 10 adds the row actions to `UnitTree` in place.

**No browser is available in this environment.** Verify by `curl` against a running dev server with a real signed session cookie, and report honestly what curl cannot check (Radix Checkbox interaction, toast rendering).

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe` block in `tests/integration/admin-only-pages.test.ts`, after the `/fees` test:

```ts
  it("a Counselor loading /academic-structure is redirected to /dashboard", async () => {
    await signIn("COUNSELOR", "c@infinityschool.edu.in");
    const { default: AcademicStructurePage } = await import(
      "@/app/(dashboard)/academic-structure/page"
    );

    await expect(AcademicStructurePage()).rejects.toMatchObject({
      digest: expect.stringContaining("/dashboard"),
    });
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/integration/admin-only-pages.test.ts`
Expected: FAIL — the page module does not resolve.

- [ ] **Step 3: Write the tree renderer**

Create `src/components/academic/unit-tree.tsx`:

```tsx
"use client";

import { Badge } from "@/components/ui/badge";
import type { AcademicSegment } from "@/lib/constants";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";

/**
 * Rows in render order, each already carrying its own `depth` for indenting. A
 * flat list is easier to key and style than a nested render, and the tree is
 * tens of nodes.
 */
export function flattenTree(units: AcademicUnitDTO[]): AcademicUnitDTO[] {
  const childrenOf = new Map<string, AcademicUnitDTO[]>();
  for (const unit of units) {
    const key = unit.parentId ?? "";
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(unit);
    else childrenOf.set(key, [unit]);
  }
  for (const bucket of childrenOf.values()) bucket.sort((a, b) => a.sortOrder - b.sortOrder);

  const ordered: AcademicUnitDTO[] = [];
  const walk = (parentId: string) => {
    for (const unit of childrenOf.get(parentId) ?? []) {
      ordered.push(unit);
      walk(unit.id);
    }
  };
  walk("");
  return ordered;
}

/** A unit reads as inactive when it or any ancestor is — the read-time rule, made visible. */
export function inactiveIds(units: AcademicUnitDTO[]): Set<string> {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const inactive = new Set<string>();

  for (const unit of units) {
    let current: AcademicUnitDTO | undefined = unit;
    for (let hops = unit.depth; current && hops >= 0; hops -= 1) {
      if (!current.active) {
        inactive.add(unit.id);
        break;
      }
      if (current.parentId === null) break;
      current = byId.get(current.parentId);
    }
  }
  return inactive;
}

export function UnitTree({
  segment,
  units,
}: {
  segment: AcademicSegment;
  units: AcademicUnitDTO[];
  /** Task 10 wires this to a refresh once the rows become editable. */
  onChanged?: () => void;
}) {
  const rows = flattenTree(units);
  const dimmed = inactiveIds(units);

  if (rows.length === 0) return null;

  return (
    <div className="rounded-lg border border-border" data-segment={segment}>
      {rows.map((unit) => (
        <div
          key={unit.id}
          className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-0"
          style={{ paddingLeft: `${16 + unit.depth * 20}px` }}
        >
          <span
            className={`text-sm ${dimmed.has(unit.id) ? "text-muted-foreground line-through" : ""}`}
          >
            {unit.name}
          </span>
          <span className="text-xs text-muted-foreground">{unit.levelLabel}</span>
          {dimmed.has(unit.id) ? (
            <Badge variant="outline" className="text-xs">
              Inactive
            </Badge>
          ) : null}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Write the segment selector**

Create `src/components/academic/segment-selector.tsx`:

```tsx
"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ACADEMIC_SEGMENTS, ACADEMIC_SEGMENT_LABELS, type AcademicSegment } from "@/lib/constants";

/**
 * `Checkbox` wraps Radix's `Checkbox.Root` — a button, not a native input —
 * so it is driven by the controlled `checked`/`onCheckedChange` pair, the same
 * way `api-keys-panel.tsx` and the fee structure form drive it.
 */
export function SegmentSelector({
  selected,
  usedSegments,
  onSaved,
}: {
  selected: AcademicSegment[];
  /** Segments holding at least one unit. The server refuses to drop these. */
  usedSegments: Set<string>;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle(segment: AcademicSegment, checked: boolean) {
    const next = checked ? [...selected, segment] : selected.filter((value) => value !== segment);
    if (next.length === 0) {
      toast.error("Keep at least one segment selected.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/settings/academic-structure/segments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: next }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not save. Please try again.");
        return;
      }
      toast.success("Segments updated");
      onSaved();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-medium">What this institution runs</h2>
        <p className="text-xs text-muted-foreground">
          Pick every segment you offer. A school with a PU college attached picks both.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {ACADEMIC_SEGMENTS.map((segment) => {
          const isSelected = selected.includes(segment);
          // A segment holding units cannot be unticked — the server refuses it,
          // so the box is disabled with the reason rather than left to fail.
          const locked = isSelected && usedSegments.has(segment);
          return (
            <div key={segment} className="flex items-center gap-2">
              <Checkbox
                id={`segment-${segment}`}
                checked={isSelected}
                disabled={busy || locked}
                onCheckedChange={(checked) => toggle(segment, checked === true)}
              />
              <Label
                htmlFor={`segment-${segment}`}
                className="text-sm font-normal"
                title={locked ? "Delete its units before deselecting this segment." : undefined}
              >
                {ACADEMIC_SEGMENT_LABELS[segment]}
              </Label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write the page shell and the page**

Create `src/components/academic/academic-structure-view.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { SegmentSelector } from "@/components/academic/segment-selector";
import { UnitTree } from "@/components/academic/unit-tree";
import { ACADEMIC_BLUEPRINTS } from "@/lib/academic/blueprints";
import { ACADEMIC_SEGMENT_LABELS, type AcademicSegment } from "@/lib/constants";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";

export function AcademicStructureView({
  segments,
  units,
  canSeed,
}: {
  segments: AcademicSegment[];
  units: AcademicUnitDTO[];
  /** True only while the tree is empty and the profile still holds typed offerings. */
  canSeed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const refresh = () => router.refresh();

  async function seed() {
    setBusy(true);
    try {
      const response = await fetch("/api/settings/academic-structure/seed", { method: "POST" });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not import. Please try again.");
        return;
      }
      toast.success(
        payload.skipped > 0
          ? `Imported ${payload.created}, skipped ${payload.skipped}`
          : `Imported ${payload.created}`,
      );
      refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const usedSegments = new Set(units.map((unit) => unit.segment));

  return (
    <>
      <PageHeader
        title="Academic Structure"
        description="What you teach, in the shape your kind of institution actually has. Your public profile reads from this."
        actions={
          canSeed ? (
            <Button size="sm" variant="outline" onClick={seed} disabled={busy}>
              <Download className="size-3.5" />
              {busy ? "Importing…" : "Import from profile"}
            </Button>
          ) : null
        }
      />

      <div className="space-y-6">
        <SegmentSelector selected={segments} usedSegments={usedSegments} onSaved={refresh} />

        {segments.map((segment) => (
          <section key={segment} className="space-y-2">
            <div>
              <h2 className="text-sm font-medium">{ACADEMIC_SEGMENT_LABELS[segment]}</h2>
              {/* The tier names come from the blueprint, never from a conditional on institution type. */}
              <p className="text-xs text-muted-foreground">
                {ACADEMIC_BLUEPRINTS[segment].levels.map((level) => level.label).join(" → ")}
              </p>
            </div>
            <UnitTree
              segment={segment}
              units={units.filter((unit) => unit.segment === segment)}
              onChanged={refresh}
            />
          </section>
        ))}
      </div>
    </>
  );
}
```

Create `src/app/(dashboard)/academic-structure/page.tsx`:

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { AcademicStructureView } from "@/components/academic/academic-structure-view";

export const metadata: Metadata = { title: "Academic Structure" };
export const dynamic = "force-dynamic";

/**
 * Institute-admin only, matching Fees, Results and Staff exactly: the platform
 * admin has no route here, and neither does Counselor or Front Desk.
 */
export default async function AcademicStructurePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const [segments, units] = await Promise.all([
    AcademicStructureService.getSegments(institution.institutionId),
    AcademicStructureService.list(institution.institutionId),
  ]);

  // Offered only while there is nothing to overwrite and something to import.
  const canSeed =
    units.length === 0 &&
    (await AcademicStructureService.hasProfileOfferings(institution.institutionId));

  return <AcademicStructureView segments={segments} units={units} canSeed={canSeed} />;
}
```

- [ ] **Step 6: Add the nav item**

In `src/components/dashboard/nav-config.ts`, add `ListTree` to the `lucide-react` import (keeping the list alphabetical), and insert this **immediately before** the `/fees` entry in the second group — fees depend on the structure, so it reads in dependency order:

```ts
      { href: "/academic-structure", label: "Academic Structure", icon: ListTree, adminOnly: true },
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/integration/admin-only-pages.test.ts`
Expected: PASS, including the new redirect test.

- [ ] **Step 8: Verify by curl against a running dev server**

Start `npm run dev`, sign in as an institution admin, and check that `/academic-structure` returns 200 with the segment labels and the blueprint's tier chain present in the HTML. Report explicitly what curl could not verify.

- [ ] **Step 9: Verify the whole suite and the types**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **622 tests passing**.

- [ ] **Step 10: Commit**

```bash
git add src/app/\(dashboard\)/academic-structure src/components/academic src/components/dashboard/nav-config.ts tests/integration/admin-only-pages.test.ts
git commit -m "feat: add the academic structure page, segment selector and nav item"
```

---

### Task 10: Editing the tree

**Files:**
- Modify: `src/components/academic/unit-tree.tsx`

**Interfaces:**
- Consumes: `flattenTree`, `inactiveIds` (already in this file); `ACADEMIC_BLUEPRINTS`, `levelFor`; the Task 7 routes.
- Produces: no new exports — `UnitTree` gains its actions in place, and `onChanged` stops being optional.

This task adds add / rename / move / activate / delete to the rows Task 9 rendered. There are no new automated tests: the behaviour is browser interaction, and this environment has no browser. Verify by curl that the page still renders, and by reading the diff that every mutation targets the Task 7 routes with the right method and body.

- [ ] **Step 1: Replace the component**

Replace **everything below `inactiveIds`** in `src/components/academic/unit-tree.tsx` with the following. Keep `flattenTree` and `inactiveIds` exactly as they are, and add the new imports at the top of the file.

New imports to add:

```tsx
import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ACADEMIC_BLUEPRINTS, PATH_SEPARATOR, levelFor } from "@/lib/academic/blueprints";
```

The component:

```tsx
const BASE = "/api/settings/academic-structure";

/** Siblings under one parent, in their stored order. */
function siblingsOf(units: AcademicUnitDTO[], parentId: string | null): AcademicUnitDTO[] {
  return units.filter((unit) => unit.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder);
}

export function UnitTree({
  segment,
  units,
  onChanged,
}: {
  segment: AcademicSegment;
  units: AcademicUnitDTO[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  /** `""` means "adding a root"; a unit id means "adding under that unit". */
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AcademicUnitDTO | null>(null);

  const rows = flattenTree(units);
  const dimmed = inactiveIds(units);
  const blueprint = ACADEMIC_BLUEPRINTS[segment];
  const rootLevel = blueprint.levels[0];

  /** One place for the fetch/toast/refresh cycle every action shares. */
  async function send(
    url: string,
    init: RequestInit,
    successMessage: string,
    failureMessage: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      const response = await fetch(url, {
        ...init,
        headers: init.body ? { "Content-Type": "application/json" } : undefined,
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? failureMessage);
        return false;
      }
      toast.success(successMessage);
      onChanged();
      return true;
    } catch {
      toast.error("Could not reach the server. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addUnit() {
    const name = draftName.trim();
    if (name.length === 0) return;

    const ok = await send(
      `${BASE}/units`,
      {
        method: "POST",
        body: JSON.stringify({ segment, parentId: addingUnder === "" ? null : addingUnder, name }),
      },
      "Added",
      "Could not add. Please try again.",
    );
    if (ok) {
      setDraftName("");
      setAddingUnder(null);
    }
  }

  async function rename(unit: AcademicUnitDTO) {
    const name = renameValue.trim();
    if (name.length === 0 || name === unit.name) {
      setRenamingId(null);
      return;
    }

    const ok = await send(
      `${BASE}/units/${unit.id}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
      "Renamed",
      "Could not rename. Please try again.",
    );
    if (ok) setRenamingId(null);
  }

  async function toggleActive(unit: AcademicUnitDTO) {
    await send(
      `${BASE}/units/${unit.id}`,
      { method: "PATCH", body: JSON.stringify({ active: !unit.active }) },
      unit.active ? "Hidden" : "Shown",
      "Could not update. Please try again.",
    );
  }

  /**
   * Sends the whole resulting sibling order, never a delta — the endpoint takes
   * a complete sibling set and refuses anything partial.
   */
  async function move(unit: AcademicUnitDTO, direction: -1 | 1) {
    const siblings = siblingsOf(units, unit.parentId);
    const index = siblings.findIndex((sibling) => sibling.id === unit.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= siblings.length) return;

    const ordered = [...siblings];
    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved);

    await send(
      `${BASE}/reorder`,
      {
        method: "POST",
        body: JSON.stringify({
          segment,
          parentId: unit.parentId,
          orderedIds: ordered.map((sibling) => sibling.id),
        }),
      },
      "Reordered",
      "Could not reorder. Please try again.",
    );
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const ok = await send(
      `${BASE}/units/${pendingDelete.id}`,
      { method: "DELETE" },
      "Deleted",
      "Could not delete. Please try again.",
    );
    if (ok) setPendingDelete(null);
  }

  // Prefixed with the separator, not a bare space: "B.E. Civil" is a sibling of
  // "B.E.", not a descendant, and a bare-space prefix match would count it.
  const descendantCount = pendingDelete
    ? units.filter((unit) =>
        unit.pathLabel.startsWith(`${pendingDelete.pathLabel}${PATH_SEPARATOR}`),
      ).length
    : 0;

  /** `addingUnder` already holds the target parent, so this only needs the level. */
  function addRow(level: { label: string; example: string }) {
    return (
      <div className="flex items-center gap-2 px-4 py-2">
        <Input
          autoFocus
          value={draftName}
          placeholder={level.example}
          disabled={busy}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void addUnit();
            if (event.key === "Escape") setAddingUnder(null);
          }}
          className="h-8 max-w-xs"
          aria-label={`New ${level.label}`}
        />
        <Button size="sm" onClick={addUnit} disabled={busy || draftName.trim().length === 0}>
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAddingUnder(null)} disabled={busy}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border" data-segment={segment}>
      {rows.length === 0 && addingUnder === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No {rootLevel.plural.toLowerCase()} yet.
        </p>
      ) : null}

      {rows.map((unit) => {
        const childLevel = levelFor(segment, unit.depth + 1);
        const siblings = siblingsOf(units, unit.parentId);
        const index = siblings.findIndex((sibling) => sibling.id === unit.id);
        const isDimmed = dimmed.has(unit.id);

        return (
          <div key={unit.id} className="border-b border-border last:border-0">
            <div
              className="flex items-center gap-2 py-2 pr-3"
              style={{ paddingLeft: `${16 + unit.depth * 20}px` }}
            >
              {renamingId === unit.id ? (
                <>
                  <Input
                    autoFocus
                    value={renameValue}
                    disabled={busy}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void rename(unit);
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                    className="h-8 max-w-xs"
                    aria-label={`Rename ${unit.name}`}
                  />
                  <Button size="sm" onClick={() => rename(unit)} disabled={busy}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRenamingId(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <span
                    className={`text-sm ${isDimmed ? "text-muted-foreground line-through" : ""}`}
                  >
                    {unit.name}
                  </span>
                  <span className="text-xs text-muted-foreground">{unit.levelLabel}</span>
                  {isDimmed ? (
                    <Badge variant="outline" className="text-xs">
                      Inactive
                    </Badge>
                  ) : null}

                  <div className="ml-auto flex items-center gap-0.5">
                    {childLevel ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setDraftName("");
                          setAddingUnder(unit.id);
                        }}
                      >
                        <Plus className="size-3.5" />
                        {childLevel.label}
                      </Button>
                    ) : null}
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Move ${unit.name} up`}
                      disabled={busy || index <= 0}
                      onClick={() => move(unit, -1)}
                    >
                      <ChevronUp className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Move ${unit.name} down`}
                      disabled={busy || index < 0 || index >= siblings.length - 1}
                      onClick={() => move(unit, 1)}
                    >
                      <ChevronDown className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Rename ${unit.name}`}
                      disabled={busy}
                      onClick={() => {
                        setRenameValue(unit.name);
                        setRenamingId(unit.id);
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={unit.active ? `Hide ${unit.name}` : `Show ${unit.name}`}
                      disabled={busy}
                      onClick={() => toggleActive(unit)}
                    >
                      {unit.active ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      aria-label={`Delete ${unit.name}`}
                      disabled={busy}
                      onClick={() => setPendingDelete(unit)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </>
              )}
            </div>

            {addingUnder === unit.id && childLevel ? addRow(childLevel) : null}
          </div>
        );
      })}

      {addingUnder === "" ? (
        addRow(rootLevel)
      ) : (
        <div className="px-4 py-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setDraftName("");
              setAddingUnder("");
            }}
          >
            <Plus className="size-3.5" />
            Add {rootLevel.label.toLowerCase()}
          </Button>
        </div>
      )}

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>
              {descendantCount > 0
                ? `Delete ${pendingDelete?.name} and the ${descendantCount} unit(s) beneath it?`
                : `Delete ${pendingDelete?.name}?`}
            </DialogTitle>
            <DialogDescription>
              This cannot be undone. Anything published from it disappears from your public profile.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)} disabled={busy}>
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

`onChanged` is now required. `AcademicStructureView` already passes it, so no change is needed there — confirm that rather than assuming it.

- [ ] **Step 2: Verify the types and the suite**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **622 tests passing** (no new tests in this task).

- [ ] **Step 3: Verify by curl and by reading the diff**

Start `npm run dev`, sign in as an institution admin, confirm `/academic-structure` returns 200 and the add/rename/move controls are present in the HTML. Then re-read your own diff and confirm each mutation hits the right route:
add → `POST /units`, rename and activate → `PATCH /units/{id}`, move → `POST /reorder` with the **whole** sibling list, delete → `DELETE /units/{id}`.
Report explicitly what curl cannot verify: dialog open state, toast rendering, and every click handler.

- [ ] **Step 4: Commit**

```bash
git add src/components/academic/unit-tree.tsx
git commit -m "feat: add, rename, reorder, hide and delete academic units"
```

---

### Task 11: Retire the hand-typed offerings from the profile

**Files:**
- Modify: `src/components/profile/sections/academic-section.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. This task only removes two inputs and adds a pointer.

The stored `academic.classesOffered` / `academic.coursesOffered` arrays stay in the database untouched — they are the fallback the public profile uses until a tree exists, and the source `seedFromProfile` reads. Removing the fields from `defaultValues` means the profile PATCH stops carrying them, so the service leaves them alone. **Do not** remove them from `src/lib/validation/institution.ts` or from the model.

- [ ] **Step 1: Drop the two fields from the form state**

In `src/components/profile/sections/academic-section.tsx`, remove these two lines from `defaultValues.academic`:

```ts
        classesOffered: profile.academic?.classesOffered ?? [],
        coursesOffered: profile.academic?.coursesOffered ?? [],
```

- [ ] **Step 2: Replace the two inputs with a pointer**

Remove both `<Controller ... name="academic.classesOffered" ...>` and
`<Controller ... name="academic.coursesOffered" ...>` blocks in full, and add
this in their place, after the `academic.medium` Controller:

```tsx
        {/*
          Classes and courses used to be typed here. They are now derived from
          the academic structure — one source of truth, and the shape follows
          the kind of institution rather than being two free-text lists.
        */}
        <div className="rounded-md border border-border p-3">
          <p className="text-sm font-medium">Classes and courses</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            These are published from your academic structure, so they stay in step with what you
            actually offer.
          </p>
          <Button asChild size="sm" variant="outline" className="mt-2">
            <Link href="/academic-structure">Edit academic structure</Link>
          </Button>
        </div>
```

Add the two imports at the top of the file:

```tsx
import Link from "next/link";
import { Button } from "@/components/ui/button";
```

Update the `FieldGroup`'s `description` — it currently promises array-replacement semantics that now only apply to `medium`:

```tsx
      <FieldGroup
        title="What you teach"
        description="Saving replaces the medium list in full — that is how the API treats arrays."
      >
```

- [ ] **Step 3: Verify the types and the suite**

Run: `npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: clean, **622 tests passing**.

If a profile test fails asserting on those inputs, read it before changing it: a test asserting the *fields render* is now correctly obsolete and should be removed; a test asserting the *stored values survive a patch* is load-bearing and must keep passing.

- [ ] **Step 4: Verify by curl**

Start `npm run dev`, sign in as an institution admin, and confirm `/profile` returns 200 with the new pointer text and without the two tag inputs. Report what curl cannot verify.

- [ ] **Step 5: Commit**

```bash
git add src/components/profile/sections/academic-section.tsx
git commit -m "feat: publish classes and courses from the academic structure instead of the profile form"
```

---

## Definition of done

Verify all of these on the finished branch before the final review:

- `npx tsc --noEmit` clean, `npm run lint` clean, `npm test -- --run` at **622 passing**.
- No institution-specific value string ("Grade 1", "PCMB", a branch name) appears in `src/` outside blueprint `example` fields. Check with:
  `grep -rn "PCMB\|Grade 1\|CEBA" src/ | grep -v "example:"` — expect no output.
- No `ROLE_PERMISSIONS` entry was added: `git diff main -- src/lib/auth` is empty.
- `src/lib/api/openapi.ts` is untouched: `git diff main --stat -- src/lib/api/openapi.ts` is empty.
- No fee file was touched: `git diff main --stat -- 'src/**/fee*' 'tests/**/fee*'` is empty.
- `tests/unit/public-projection.test.ts` passes unedited.
- Every guard added in this plan has been mutation-checked as its task specified.
