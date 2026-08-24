# I-DAP Phase 2 — Results Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an institution publish aggregate exam-cycle results — pass rates, score bands and consented toppers — and serve them through the same credential-free public API pattern Phase 1 established for profiles.

**Architecture:** A new tenant-scoped `results` collection with a per-record publish lifecycle, sitting behind a three-layer split identical to Phase 1: routes do auth/CSRF/Zod/envelope, `ResultService` is the only module that touches the database or storage, and `toPublicResult()` is the sole path from a stored document to a public response. Nothing in Phase 1's schema, projection or tests is modified.

**Tech Stack:** Next.js 16 App Router, Mongoose 8, Zod 4, TypeScript, Vitest 3, `mongodb-memory-server`, Vercel Blob (public store).

**Spec:** `docs/superpowers/specs/2026-08-24-idap-results-management-design.md`

## Global Constraints

Copied from the spec. Every task's requirements implicitly include these.

- **The projection is an allow-list.** `toPublicResult()` is built field-by-field. Never a spread, never a deny-list. A field added to the schema must be invisible publicly until someone adds it to the projection on purpose.
- **`passPercentage` is computed, never stored.** It exists only as projection output.
- **A topper without `consentAcknowledged: true` is dropped from public output entirely** — omitted from the array, not blanked and not anonymised. Consent can be withdrawn *after* publication, so this check lives in the projection and runs on every read, not only at the publish transition.
- **`photoUrl` is never client-settable.** It is written only by the photo upload endpoint. It must not appear in any create or patch schema. (Phase 1's Critical finding was an attacker-supplied `logoUrl` reaching a cross-tenant blob delete; this module closes that by construction rather than by guard — and keeps the guard anyway.)
- **Topper photo keys live under `media/<institutionId>/…`** so the existing `isOwnedMediaUrl()` provenance guard covers them unmodified. Every deletion path calls that guard first.
- **404-never-403 on public reads.** A draft result, an archived result, a suspended institution and a nonexistent institution are indistinguishable to a public caller. Do not write a 403 branch.
- **404-never-403 on cross-tenant access.** A `resultId` belonging to another institution returns 404 from every institute-admin route.
- **The platform admin gets no route to results.** Nothing is added to `SUPER_ADMIN_NAV`, and no admin API route is created. `requireInstitution()` already rejects `SUPER_ADMIN`.
- **Public reads are rate limited** with `PUBLIC_READ_RATE_LIMIT` (60/min), keyed on **IP only** — never on `institutionId` or slug, so one institution's traffic cannot exhaust another's allowance.
- **Public reads send `Cache-Control: public, max-age=300`** — identical to the profile endpoint.
- **Services touch storage; routes never do.** Mirrors `InstitutionService.addMedia`.
- **Every guard is verified by mutation.** Remove the guard, confirm the test fails, restore it. A test that still passes with its guard deleted is not evidence of anything.
- **The 297 pre-existing tests must stay green** at every commit.

---

## File Structure

**Extracted for reuse (Task 1 — pure refactor, no behaviour change):**

| File | Responsibility |
|---|---|
| `src/lib/media/image.ts` | `MAX_IMAGE_BYTES`, `IMAGE_EXTENSIONS`, `sniffImage`, `validateImage`. Moved out of `institution.service.ts` so both services share one upload guard. |
| `src/lib/media/ownership.ts` | `isOwnedMediaUrl`. Moved out of `institution.service.ts`; has zero external consumers today, so the move is clean. |

**New — results module:**

| File | Responsibility |
|---|---|
| `src/models/Result.ts` | Schema, sub-schemas, four indexes. |
| `src/lib/validation/result.ts` | Zod shapes plus the two pure invariant functions. |
| `src/lib/results/public-projection.ts` | `toPublicResult()` — the sole public path. |
| `src/services/result.service.ts` | All database and storage access for results. |
| `src/app/api/settings/results/route.ts` | GET list, POST create. |
| `src/app/api/settings/results/[resultId]/route.ts` | GET, PATCH, DELETE one. |
| `src/app/api/settings/results/[resultId]/publish/route.ts` | POST publish/unpublish. |
| `src/app/api/settings/results/[resultId]/toppers/[topperId]/photo/route.ts` | POST, DELETE topper photo. |
| `src/app/api/public/[institutionId]/results/route.ts` | Public read by institution id. |
| `src/app/api/public/institutions/[slug]/results/route.ts` | Public read by slug. |
| `src/app/(dashboard)/results/page.tsx` | Cycle list. |
| `src/app/(dashboard)/results/[resultId]/page.tsx` | Cycle editor. |
| `src/components/results/*.tsx` | Editor sections, band editor, topper editor, publish dialog. |

**Modified:** `src/lib/constants.ts`, `src/models/index.ts`, `src/services/index.ts`, `src/services/institution.service.ts` (imports only), `src/lib/api/openapi.ts`, `src/components/dashboard/nav-config.ts`.

---

### Task 1: Extract the shared media helpers

A pure refactor with no behaviour change, done first so Tasks 8 and 10 have one upload guard to call rather than a duplicated one. `validateImage`, `sniffImage`, `IMAGE_EXTENSIONS`, `MAX_IMAGE_BYTES` and `isOwnedMediaUrl` are currently module-private (or near-private) inside `src/services/institution.service.ts`.

**Files:**
- Create: `src/lib/media/image.ts`
- Create: `src/lib/media/ownership.ts`
- Modify: `src/services/institution.service.ts` (delete the moved definitions, import them instead)
- Test: existing suite only — this task adds no new test

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `validateImage(input: { contentType: string; bytes: Buffer }): { extension: string }` — throws `validationError` on bad type/empty/oversize/failed magic-number sniff
  - `MAX_IMAGE_BYTES: number` (5 MB)
  - `isOwnedMediaUrl(url: string | null | undefined, institutionId: string): boolean`

- [ ] **Step 1: Create `src/lib/media/image.ts`**

Move the code verbatim — do not "improve" it while moving; a refactor that also changes behaviour cannot be reviewed as a refactor.

```ts
import { validationError } from "@/lib/api/errors";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** Magic-number check so a renamed executable cannot pose as an allowed image type. */
function sniffImage(bytes: Buffer, contentType: string): boolean {
  if (bytes.byteLength < 4) return false;
  if (contentType === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (contentType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/webp") {
    return (
      bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP"
    );
  }
  return false;
}

/**
 * Upload guard for public institution media: JPEG/PNG/WebP only (no PDF branch —
 * this is never a document), size bounded, and the sniff must agree with the
 * declared content type.
 */
export function validateImage(input: { contentType: string; bytes: Buffer }): {
  extension: string;
} {
  const extension = IMAGE_EXTENSIONS[input.contentType];
  if (!extension) {
    throw validationError("file: only JPG, PNG and WEBP images can be uploaded");
  }
  if (input.bytes.byteLength <= 0) {
    throw validationError("file: the file is empty");
  }
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw validationError("file: files must be 5 MB or smaller");
  }
  if (!sniffImage(input.bytes, input.contentType)) {
    throw validationError("file: the file contents do not match the declared file type");
  }
  return { extension };
}
```

- [ ] **Step 2: Create `src/lib/media/ownership.ts`**

Move `isOwnedMediaUrl` verbatim, keeping its full doc comment — the comment explains why the guard exists (it closed a Critical cross-tenant deletion finding) and must not be lost in the move.

```ts
/**
 * True only when `url` names a public media object this platform minted for this
 * institution. Every upload is stored under the key `media/<institutionId>/…`,
 * and both adapters keep that path in the handle they hand back: the local
 * adapter returns `/api/media/media/<institutionId>/…`, and Vercel Blob returns
 * a blob URL whose pathname is `/media/<institutionId>/<id>-<random><ext>`.
 *
 * This is a provenance check, not a cosmetic one. A stored media URL can be
 * attacker-influenced, so a cleanup delete that trusted it would delete a
 * different tenant's object out of the shared store — neither adapter's
 * `deletePublic` is tenant-scoped.
 *
 * Only the path is matched: a query string or fragment can carry any substring.
 * A percent-encoded or traversing path is refused outright — a key this platform
 * minted contains neither.
 */
export function isOwnedMediaUrl(url: string | null | undefined, institutionId: string): boolean {
  if (!url) return false;

  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      path = new URL(url).pathname;
    } catch {
      return false;
    }
  } else {
    path = url.split(/[?#]/, 1)[0] ?? "";
  }

  if (path.includes("%") || path.includes("..")) return false;
  return path.includes(`/media/${institutionId}/`);
}
```

- [ ] **Step 3: Update `src/services/institution.service.ts`**

Delete the moved definitions (`MAX_IMAGE_BYTES`, `IMAGE_EXTENSIONS`, `sniffImage`, `validateImage`, and the exported `isOwnedMediaUrl`) and import them instead. Add to the existing import block near the top:

```ts
import { validateImage } from "@/lib/media/image";
import { isOwnedMediaUrl } from "@/lib/media/ownership";
```

Then re-export `isOwnedMediaUrl` from this module so any future import of it from here still resolves:

```ts
export { isOwnedMediaUrl };
```

- [ ] **Step 4: Verify nothing changed**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: typecheck clean, **297 passed**. This task is complete only if the count is unchanged — a refactor that changes a test outcome is not a refactor.

- [ ] **Step 5: Commit**

```bash
git add src/lib/media src/services/institution.service.ts
git commit -m "refactor: extract shared image validation and media ownership helpers"
```

---

### Task 2: Constants and the Result model

**Files:**
- Modify: `src/lib/constants.ts` (append; do not reorder existing tuples — Phase 1's decision register forbids it, since stored values reference them by string)
- Create: `src/models/Result.ts`
- Modify: `src/models/index.ts`
- Test: `tests/unit/result-model.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `RESULT_BOARDS`, `ResultBoard`, `RESULT_BOARD_LABELS`
  - `RESULT_LEVELS`, `ResultLevel`, `RESULT_LEVEL_LABELS`
  - `RESULT_STREAMS`, `ResultStream`, `RESULT_STREAM_LABELS`
  - `RESULT_STATUSES`, `ResultStatus`, `RESULT_STATUS_LABELS`
  - `RESULT_MAX_BANDS = 8`, `RESULT_MAX_TOPPERS = 25`
  - `BOARD_NAME_REQUIRED: ReadonlySet<ResultBoard>` — boards whose display name must be supplied
  - `Result` model, `ResultDoc` type

- [ ] **Step 1: Write the failing test**

Create `tests/unit/result-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Result } from "@/models/Result";
import { RESULT_BOARDS, RESULT_LEVELS, RESULT_STATUSES } from "@/lib/constants";

describe("Result model", () => {
  it("defaults a new result to DRAFT with no publishedAt", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 10,
      passed: 10,
    });

    expect(doc.status).toBe("DRAFT");
    expect(doc.publishedAt).toBeUndefined();
    expect(doc.stream).toBeNull();
  });

  it("keeps an _id on each topper so the photo endpoint can address it", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      toppers: [{ name: "Priya S", percentage: 98.6 }],
    });

    expect(doc.toppers?.[0]?._id).toBeDefined();
  });

  it("does not give bands their own _id", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "CBSE",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
      bands: [{ label: "90% and above", minPercentage: 90, maxPercentage: 100, count: 1 }],
    });

    expect((doc.bands?.[0] as unknown as { _id?: unknown })?._id).toBeUndefined();
  });

  it("rejects a board, level or status outside its enum", () => {
    const doc = new Result({
      institutionId: "INS0001",
      board: "NOT_A_BOARD",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 1,
      passed: 1,
    });

    expect(doc.validateSync()?.errors.board).toBeDefined();
  });

  it("declares the unique cycle index and the reserved discovery index", () => {
    const indexes = Result.schema.indexes();

    const unique = indexes.find(([, options]) => options?.unique === true);
    expect(unique?.[0]).toEqual({
      institutionId: 1,
      board: 1,
      level: 1,
      stream: 1,
      academicYear: 1,
    });

    const discovery = indexes.find(
      ([fields]) =>
        fields.status === 1 && fields.board === 1 && fields.level === 1 && !("institutionId" in fields),
    );
    expect(discovery).toBeDefined();
  });

  it("exposes the constant tuples the UI and validation share", () => {
    expect(RESULT_BOARDS).toContain("STATE_BOARD");
    expect(RESULT_LEVELS).toContain("CLASS_12");
    expect(RESULT_STATUSES).toEqual(["DRAFT", "PUBLISHED", "ARCHIVED"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/result-model.test.ts
```

Expected: FAIL — cannot resolve `@/models/Result`.

- [ ] **Step 3: Append the constants**

Append to the end of `src/lib/constants.ts`, following the existing tuple → derived type → labels-map shape:

```ts
export const RESULT_BOARDS = [
  "CBSE",
  "ICSE",
  "ISC",
  "IB",
  "IGCSE",
  "STATE_BOARD",
  "UNIVERSITY",
  "AUTONOMOUS",
  "OTHER",
] as const;
export type ResultBoard = (typeof RESULT_BOARDS)[number];

export const RESULT_BOARD_LABELS: Record<ResultBoard, string> = {
  CBSE: "CBSE",
  ICSE: "ICSE",
  ISC: "ISC",
  IB: "International Baccalaureate",
  IGCSE: "IGCSE",
  STATE_BOARD: "State board",
  UNIVERSITY: "University",
  AUTONOMOUS: "Autonomous",
  OTHER: "Other",
};

/**
 * Boards whose enum member does not name the awarding body on its own. For
 * these, `boardName` carries the real name (e.g. "Karnataka State Board") and
 * is required.
 */
export const BOARD_NAME_REQUIRED: ReadonlySet<ResultBoard> = new Set<ResultBoard>([
  "STATE_BOARD",
  "UNIVERSITY",
  "AUTONOMOUS",
  "OTHER",
]);

export const RESULT_LEVELS = [
  "CLASS_10",
  "CLASS_12",
  "PUC_1",
  "PUC_2",
  "UG",
  "PG",
  "DIPLOMA",
  "OTHER",
] as const;
export type ResultLevel = (typeof RESULT_LEVELS)[number];

export const RESULT_LEVEL_LABELS: Record<ResultLevel, string> = {
  CLASS_10: "Class 10",
  CLASS_12: "Class 12",
  PUC_1: "PUC I",
  PUC_2: "PUC II",
  UG: "Undergraduate",
  PG: "Postgraduate",
  DIPLOMA: "Diploma",
  OTHER: "Other",
};

export const RESULT_STREAMS = ["SCIENCE", "COMMERCE", "ARTS"] as const;
export type ResultStream = (typeof RESULT_STREAMS)[number];

export const RESULT_STREAM_LABELS: Record<ResultStream, string> = {
  SCIENCE: "Science",
  COMMERCE: "Commerce",
  ARTS: "Arts",
};

export const RESULT_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const RESULT_STATUS_LABELS: Record<ResultStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export const RESULT_MAX_BANDS = 8;
export const RESULT_MAX_TOPPERS = 25;
```

- [ ] **Step 4: Create `src/models/Result.ts`**

```ts
import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { RESULT_BOARDS, RESULT_LEVELS, RESULT_STATUSES, RESULT_STREAMS } from "@/lib/constants";

/** No _id: bands are replaced wholesale, never addressed individually. */
const BandSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    minPercentage: { type: Number, required: true, min: 0, max: 100 },
    maxPercentage: { type: Number, required: true, min: 0, max: 100 },
    count: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

/** Keeps its _id — the topper photo endpoint addresses toppers by it. */
const TopperSchema = new Schema({
  name: { type: String, required: true, trim: true },
  percentage: { type: Number, required: true, min: 0, max: 100 },
  rank: { type: Number, min: 1 },
  note: { type: String, trim: true },
  /**
   * Written only by the photo upload endpoint, never accepted from a create or
   * patch body. A client-settable media URL is exactly the shape that produced
   * Phase 1's cross-tenant deletion finding.
   */
  photoUrl: { type: String, trim: true },
  consentAcknowledged: { type: Boolean, default: false },
});

const ResultSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },

    board: { type: String, enum: RESULT_BOARDS, required: true },
    boardName: { type: String, trim: true },
    level: { type: String, enum: RESULT_LEVELS, required: true },
    /**
     * Stored as an explicit null rather than omitted, so the unique cycle index
     * treats "no stream" as one consistent value across every document.
     */
    stream: { type: String, enum: [...RESULT_STREAMS, null], default: null },
    academicYear: { type: String, required: true, trim: true },
    examLabel: { type: String, trim: true },

    appeared: { type: Number, required: true, min: 0 },
    passed: { type: Number, required: true, min: 0 },
    averageScore: { type: Number, min: 0, max: 100 },
    highestScore: { type: Number, min: 0, max: 100 },

    bands: { type: [BandSchema], default: undefined },
    toppers: { type: [TopperSchema], default: undefined },

    status: { type: String, enum: RESULT_STATUSES, default: "DRAFT" },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

ResultSchema.index({ institutionId: 1, createdAt: -1 });
ResultSchema.index({ institutionId: 1, status: 1, academicYear: -1 });

/** One record per exam cycle. Duplicates are refused by the index, not by a pre-read. */
ResultSchema.index(
  { institutionId: 1, board: 1, level: 1, stream: 1, academicYear: 1 },
  { unique: true },
);

/**
 * Serves no query in this phase. It exists so the cross-institution discovery
 * API PassPercent needs is a purely additive change later — no migration, and
 * no index build against a populated collection.
 */
ResultSchema.index({ status: 1, board: 1, level: 1, academicYear: -1 });

export type ResultDoc = InferSchemaType<typeof ResultSchema> & { _id: Types.ObjectId };

export const Result: Model<ResultDoc> =
  (models.Result as Model<ResultDoc>) ?? model<ResultDoc>("Result", ResultSchema);
```

- [ ] **Step 5: Export from the model barrel**

Add to `src/models/index.ts`, following the existing export style in that file:

```ts
export { Result, type ResultDoc } from "./Result";
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run tests/unit/result-model.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/constants.ts src/models/Result.ts src/models/index.ts tests/unit/result-model.test.ts
git commit -m "feat: add the Result model, its constants and its cycle-uniqueness index"
```

---

### Task 3: Validation schemas and the invariant functions

Cross-field invariants cannot live in the Zod patch schema, because a PATCH is partial: a body carrying only `bands` has no `appeared` to compare against. So the split is deliberate — **Zod validates shapes and per-field ranges; two pure functions validate the merged record.** The service calls those functions after merging, which is the only point at which the whole truth exists.

**Files:**
- Create: `src/lib/validation/result.ts`
- Test: `tests/unit/results-validation.test.ts`

**Interfaces:**
- Consumes: `RESULT_BOARDS`, `RESULT_LEVELS`, `RESULT_STREAMS`, `RESULT_MAX_BANDS`, `RESULT_MAX_TOPPERS`, `BOARD_NAME_REQUIRED` from Task 2; `requiredText`, `optionalText` from `@/lib/validation/common`; `validationError` from `@/lib/api/errors`.
- Produces:
  - `createResultSchema` — full create body
  - `updateResultSchema` — partial patch body (**no `photoUrl`, no `status`**)
  - `resultQuerySchema` — public filter query
  - `type ResultInvariantInput` — the merged shape the invariant functions accept
  - `assertResultInvariants(input: ResultInvariantInput): void`
  - `assertPublishable(input: ResultInvariantInput): void`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/results-validation.test.ts`. Every invariant is asserted by its violation — a test that only proves the happy path proves nothing about a guard.

```ts
import { describe, expect, it } from "vitest";
import {
  assertPublishable,
  assertResultInvariants,
  createResultSchema,
  updateResultSchema,
} from "@/lib/validation/result";

const base = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  academicYear: "2025-26",
  appeared: 100,
  passed: 100,
};

describe("result invariants", () => {
  it("accepts a coherent record", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        bands: [
          { label: "90%+", minPercentage: 90, maxPercentage: 100, count: 30 },
          { label: "75-90%", minPercentage: 75, maxPercentage: 89, count: 40 },
        ],
      }),
    ).not.toThrow();
  });

  it("refuses more passes than appeared", () => {
    expect(() => assertResultInvariants({ ...base, appeared: 10, passed: 11 })).toThrow(
      /cannot exceed/i,
    );
  });

  it("refuses overlapping bands", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        bands: [
          { label: "A", minPercentage: 80, maxPercentage: 100, count: 1 },
          { label: "B", minPercentage: 75, maxPercentage: 85, count: 1 },
        ],
      }),
    ).toThrow(/overlap/i);
  });

  it("refuses a band whose minimum exceeds its maximum", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        bands: [{ label: "A", minPercentage: 90, maxPercentage: 80, count: 1 }],
      }),
    ).toThrow(/lower than/i);
  });

  it("refuses band counts adding up to more than appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        appeared: 10,
        passed: 10,
        bands: [
          { label: "A", minPercentage: 90, maxPercentage: 100, count: 6 },
          { label: "B", minPercentage: 75, maxPercentage: 89, count: 6 },
        ],
      }),
    ).toThrow(/more students than appeared/i);
  });

  it("requires boardName when the board does not name itself", () => {
    expect(() => assertResultInvariants({ ...base, board: "STATE_BOARD" })).toThrow(/boardName/);
    expect(() =>
      assertResultInvariants({ ...base, board: "STATE_BOARD", boardName: "Karnataka State Board" }),
    ).not.toThrow();
  });

  it("does not require boardName for a board that names itself", () => {
    expect(() => assertResultInvariants({ ...base, board: "CBSE" })).not.toThrow();
  });
});

describe("publish gate", () => {
  it("refuses to publish a cycle with nobody appearing", () => {
    expect(() => assertPublishable({ ...base, appeared: 0, passed: 0 })).toThrow(/appeared/i);
  });

  it("refuses to publish while any topper lacks acknowledged consent", () => {
    expect(() =>
      assertPublishable({
        ...base,
        toppers: [
          { name: "Priya S", percentage: 98.6, consentAcknowledged: true },
          { name: "Rahul K", percentage: 97.8, consentAcknowledged: false },
        ],
      }),
    ).toThrow(/Rahul K/);
  });

  it("publishes when every topper has acknowledged consent", () => {
    expect(() =>
      assertPublishable({
        ...base,
        toppers: [{ name: "Priya S", percentage: 98.6, consentAcknowledged: true }],
      }),
    ).not.toThrow();
  });

  it("still applies the ordinary invariants at publish time", () => {
    expect(() => assertPublishable({ ...base, appeared: 10, passed: 11 })).toThrow(/cannot exceed/i);
  });
});

describe("result schemas", () => {
  it("accepts a minimal create body", () => {
    const parsed = createResultSchema.parse({
      board: "CBSE",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 100,
      passed: 98,
    });
    expect(parsed.stream).toBeNull();
  });

  it("normalises a missing stream to null so the unique index sees one value", () => {
    expect(createResultSchema.parse({ ...base }).stream).toBeNull();
  });

  it("refuses a photoUrl on create — photos are set only by the upload endpoint", () => {
    const parsed = createResultSchema.parse({
      ...base,
      toppers: [{ name: "Priya S", percentage: 98.6, photoUrl: "https://evil.example/x.png" }],
    });
    expect(parsed.toppers?.[0]).not.toHaveProperty("photoUrl");
  });

  it("refuses a photoUrl on patch", () => {
    const parsed = updateResultSchema.parse({
      toppers: [{ name: "Priya S", percentage: 98.6, photoUrl: "https://evil.example/x.png" }],
    });
    expect(parsed.toppers?.[0]).not.toHaveProperty("photoUrl");
  });

  it("refuses a status on patch — status moves only through the publish route", () => {
    const parsed = updateResultSchema.parse({ status: "PUBLISHED" });
    expect(parsed).not.toHaveProperty("status");
  });

  it("rejects a percentage outside 0-100", () => {
    expect(() => createResultSchema.parse({ ...base, averageScore: 101 })).toThrow();
  });

  it("caps the number of toppers", () => {
    const toppers = Array.from({ length: 26 }, (_, i) => ({ name: `S${i}`, percentage: 90 }));
    expect(() => createResultSchema.parse({ ...base, toppers })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/results-validation.test.ts
```

Expected: FAIL — cannot resolve `@/lib/validation/result`.

- [ ] **Step 3: Create `src/lib/validation/result.ts`**

```ts
import { z } from "zod";
import {
  BOARD_NAME_REQUIRED,
  RESULT_BOARDS,
  RESULT_LEVELS,
  RESULT_MAX_BANDS,
  RESULT_MAX_TOPPERS,
  RESULT_STREAMS,
  type ResultBoard,
} from "@/lib/constants";
import { validationError } from "@/lib/api/errors";
import { optionalText, requiredText } from "./common";

const percentage = z.number().min(0, "Must be 0 or more").max(100, "Must be 100 or less");

const bandSchema = z.object({
  label: requiredText("Band label", 40),
  minPercentage: percentage,
  maxPercentage: percentage,
  count: z.number().int().min(0),
});

/**
 * `photoUrl` is deliberately absent. A topper's photo is written only by the
 * upload endpoint; accepting it here would let a caller point the field at
 * another tenant's blob, which is the shape of Phase 1's Critical finding.
 */
const topperSchema = z.object({
  name: requiredText("Topper name", 120),
  percentage,
  rank: z.number().int().min(1).optional(),
  note: optionalText(200),
  consentAcknowledged: z.boolean().optional(),
});

const cycleFields = {
  board: z.enum(RESULT_BOARDS),
  boardName: optionalText(120),
  level: z.enum(RESULT_LEVELS),
  stream: z.enum(RESULT_STREAMS).nullish(),
  academicYear: requiredText("Academic year", 20),
  examLabel: optionalText(120),
};

const outcomeFields = {
  appeared: z.number().int().min(0),
  passed: z.number().int().min(0),
  averageScore: percentage.optional(),
  highestScore: percentage.optional(),
  bands: z.array(bandSchema).max(RESULT_MAX_BANDS).optional(),
  toppers: z.array(topperSchema).max(RESULT_MAX_TOPPERS).optional(),
};

export const createResultSchema = z
  .object({ ...cycleFields, ...outcomeFields })
  // A missing stream becomes an explicit null so the unique cycle index sees
  // one consistent value rather than a mix of null and absent.
  .transform((value) => ({ ...value, stream: value.stream ?? null }));

/**
 * `status` is absent on purpose: a result changes state only through the
 * publish route, so a PATCH can never smuggle a cycle into PUBLISHED and skip
 * the consent gate.
 */
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
});

export const resultQuerySchema = z.object({
  academicYear: optionalText(20),
  level: z.enum(RESULT_LEVELS).optional(),
  board: z.enum(RESULT_BOARDS).optional(),
});

export type ResultInvariantInput = {
  board: ResultBoard;
  boardName?: string | null;
  appeared: number;
  passed: number;
  bands?: { label: string; minPercentage: number; maxPercentage: number; count: number }[] | null;
  toppers?: { name: string; consentAcknowledged?: boolean | null }[] | null;
};

/**
 * Cross-field rules, checked against the MERGED record rather than the request
 * body — a PATCH carrying only `bands` has no `appeared` of its own to compare
 * against, so the service merges first and calls this second.
 */
export function assertResultInvariants(input: ResultInvariantInput): void {
  if (input.passed > input.appeared) {
    throw validationError("passed: the number who passed cannot exceed the number who appeared");
  }

  if (BOARD_NAME_REQUIRED.has(input.board) && !input.boardName?.trim()) {
    throw validationError("boardName: name the board that awarded these results");
  }

  const bands = input.bands ?? [];

  for (const band of bands) {
    if (band.minPercentage > band.maxPercentage) {
      throw validationError(
        `bands: "${band.label}" has a minimum higher than its maximum — the minimum must be lower than or equal to the maximum`,
      );
    }
  }

  const sorted = [...bands].sort((a, b) => a.minPercentage - b.minPercentage);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && current.minPercentage <= previous.maxPercentage) {
      throw validationError(
        `bands: "${previous.label}" and "${current.label}" overlap — each band must cover a distinct range`,
      );
    }
  }

  const counted = bands.reduce((total, band) => total + band.count, 0);
  if (counted > input.appeared) {
    throw validationError("bands: the bands account for more students than appeared");
  }
}

/**
 * The publish gate. Stricter than `assertResultInvariants`, which a draft may
 * still satisfy while incomplete.
 */
export function assertPublishable(input: ResultInvariantInput): void {
  assertResultInvariants(input);

  if (input.appeared <= 0) {
    throw validationError("appeared: enter how many students appeared before publishing");
  }

  const unconsented = (input.toppers ?? []).filter((topper) => topper.consentAcknowledged !== true);
  if (unconsented.length > 0) {
    const names = unconsented.map((topper) => topper.name).join(", ");
    throw validationError(
      `toppers: confirm consent to publish for ${names} before publishing this result`,
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/unit/results-validation.test.ts
```

Expected: PASS, 18 tests.

- [ ] **Step 5: Mutation-check the guards**

For each of these, make the change, run the test, confirm the named test **fails**, then revert:

| Mutation | Test that must fail |
|---|---|
| Delete the `passed > appeared` throw | `refuses more passes than appeared` |
| Delete the overlap loop | `refuses overlapping bands` |
| Delete the `counted > appeared` throw | `refuses band counts adding up to more than appeared` |
| Delete the `BOARD_NAME_REQUIRED` throw | `requires boardName when the board does not name itself` |
| Delete the `unconsented` throw in `assertPublishable` | `refuses to publish while any topper lacks acknowledged consent` |
| Add `photoUrl: z.string().optional()` to `topperSchema` | `refuses a photoUrl on create` and `refuses a photoUrl on patch` |

- [ ] **Step 6: Commit**

```bash
git add src/lib/validation/result.ts tests/unit/results-validation.test.ts
git commit -m "feat: add result validation schemas and merged-record invariants"
```

---

### Task 4: The public projection

The single most security-sensitive file in this module. It is the only path from a stored result to a public response, and it is where consent withdrawal is caught.

**Files:**
- Create: `src/lib/results/public-projection.ts`
- Test: `tests/unit/results-projection.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (it reads plain documents).
- Produces:
  - `toPublicResult(result: Record<string, unknown>): PublicResult | null` — returns `null` for anything not `PUBLISHED`
  - `type PublicResult = NonNullable<ReturnType<typeof toPublicResult>>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/results-projection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toPublicResult } from "@/lib/results/public-projection";

const published = {
  _id: "6a887abc755db527bea511e6",
  institutionId: "INS0001",
  board: "CBSE",
  boardName: undefined,
  level: "CLASS_10",
  stream: null,
  academicYear: "2025-26",
  examLabel: undefined,
  appeared: 142,
  passed: 140,
  averageScore: 82.4,
  highestScore: 98.6,
  bands: [{ label: "90% and above", minPercentage: 90, maxPercentage: 100, count: 38 }],
  toppers: [
    { _id: "aaa", name: "Priya S", percentage: 98.6, rank: 1, consentAcknowledged: true },
    { _id: "bbb", name: "Rahul K", percentage: 97.8, rank: 2, consentAcknowledged: false },
  ],
  status: "PUBLISHED",
  publishedAt: new Date("2026-05-10T00:00:00.000Z"),
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-10T00:00:00.000Z"),
};

describe("toPublicResult", () => {
  it("emits exactly the allowed top-level keys and no others", () => {
    const result = toPublicResult(published);

    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        "academicYear",
        "appeared",
        "averageScore",
        "bands",
        "board",
        "boardLabel",
        "highestScore",
        "level",
        "passPercentage",
        "passed",
        "publishedAt",
        "stream",
        "toppers",
      ].sort(),
    );
  });

  it("never emits internal fields", () => {
    const result = toPublicResult(published) as Record<string, unknown>;

    expect(result).not.toHaveProperty("_id");
    expect(result).not.toHaveProperty("institutionId");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("drops a topper who has not acknowledged consent", () => {
    const result = toPublicResult(published);

    expect(result?.toppers).toHaveLength(1);
    expect(result?.toppers?.[0]?.name).toBe("Priya S");
    expect(JSON.stringify(result)).not.toContain("Rahul K");
  });

  it("never emits consentAcknowledged itself, nor a topper _id", () => {
    const topper = toPublicResult(published)?.toppers?.[0] as Record<string, unknown>;

    expect(topper).not.toHaveProperty("consentAcknowledged");
    expect(topper).not.toHaveProperty("_id");
  });

  it("computes passPercentage rather than reading a stored one", () => {
    expect(toPublicResult(published)?.passPercentage).toBe(98.6);
  });

  it("returns a null passPercentage rather than dividing by zero", () => {
    const result = toPublicResult({ ...published, appeared: 0, passed: 0 });
    expect(result?.passPercentage).toBeNull();
  });

  it("ignores a stored passPercentage that disagrees with the arithmetic", () => {
    const result = toPublicResult({ ...published, passPercentage: 12 });
    expect(result?.passPercentage).toBe(98.6);
  });

  it("returns null for a result that is not published", () => {
    expect(toPublicResult({ ...published, status: "DRAFT" })).toBeNull();
    expect(toPublicResult({ ...published, status: "ARCHIVED" })).toBeNull();
    expect(toPublicResult({ ...published, status: undefined })).toBeNull();
  });

  it("prefers boardName over the enum label when the board does not name itself", () => {
    const result = toPublicResult({
      ...published,
      board: "STATE_BOARD",
      boardName: "Karnataka State Board",
    });
    expect(result?.boardLabel).toBe("Karnataka State Board");
  });

  it("falls back to the enum label when boardName is absent", () => {
    expect(toPublicResult(published)?.boardLabel).toBe("CBSE");
  });

  it("omits an empty toppers or bands array rather than emitting []", () => {
    const result = toPublicResult({ ...published, toppers: [], bands: [] });
    expect(result?.toppers).toBeUndefined();
    expect(result?.bands).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/results-projection.test.ts
```

Expected: FAIL — cannot resolve `@/lib/results/public-projection`.

- [ ] **Step 3: Create `src/lib/results/public-projection.ts`**

```ts
/**
 * The only path from a Result document to a public response.
 *
 * This is an allow-list: it names the fields that may leave. A field added to
 * the schema is private until someone deliberately adds it here. Rewriting this
 * as a spread with deletions would leak every future field on the day it was
 * added — a test exists specifically to catch that.
 *
 * Two rules live here and nowhere else:
 *
 *  1. Only a PUBLISHED result projects at all. Callers already filter, so this
 *     is defence in depth on the module's highest-risk boundary.
 *  2. A topper without acknowledged consent is dropped. This is NOT redundant
 *     with the publish-time gate: consent can be withdrawn after publication,
 *     and withdrawal must take that topper off the API on the very next read
 *     without the institution having to unpublish the whole cycle.
 */
import { RESULT_BOARD_LABELS, type ResultBoard } from "@/lib/constants";

type Doc = Record<string, unknown>;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const rows = (value: unknown): Doc[] => (Array.isArray(value) ? (value as Doc[]) : []);

/** Drops an array entirely when it has no members, so `[]` never reaches a consumer. */
const listOrUndefined = <T>(values: T[]): T[] | undefined =>
  values.length > 0 ? values : undefined;

export type PublicResult = NonNullable<ReturnType<typeof toPublicResult>>;

export function toPublicResult(result: Doc) {
  const doc = result ?? {};

  if (doc.status !== "PUBLISHED") return null;

  const appeared = num(doc.appeared) ?? 0;
  const passed = num(doc.passed) ?? 0;

  // Computed here and only here. A stored value would drift the moment someone
  // corrected `appeared` or `passed` without recomputing it.
  const passPercentage =
    appeared > 0 ? Math.round((passed / appeared) * 1000) / 10 : null;

  const board = text(doc.board);
  const boardLabel =
    text(doc.boardName) ??
    (board ? RESULT_BOARD_LABELS[board as ResultBoard] ?? board : undefined);

  const bands = rows(doc.bands).map((band) => ({
    label: text(band.label),
    minPercentage: num(band.minPercentage),
    maxPercentage: num(band.maxPercentage),
    count: num(band.count),
  }));

  const toppers = rows(doc.toppers)
    .filter((topper) => topper.consentAcknowledged === true)
    .map((topper) => ({
      name: text(topper.name),
      percentage: num(topper.percentage),
      rank: num(topper.rank),
      note: text(topper.note),
      photoUrl: text(topper.photoUrl),
    }));

  const publishedAt = doc.publishedAt;

  return {
    board,
    boardLabel,
    level: text(doc.level),
    stream: text(doc.stream) ?? null,
    academicYear: text(doc.academicYear),

    appeared,
    passed,
    passPercentage,
    averageScore: num(doc.averageScore),
    highestScore: num(doc.highestScore),

    bands: listOrUndefined(bands),
    toppers: listOrUndefined(toppers),

    publishedAt: publishedAt instanceof Date ? publishedAt.toISOString() : text(publishedAt),
  };
}
```

Note the deliberate omission of `examLabel` from the emitted keys — it is an internal display aid for the editor, and the exhaustive-key test in Step 1 encodes that decision. If a later task wants it public, that test must be changed on purpose.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/unit/results-projection.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Mutation-check the guards**

| Mutation | Test that must fail |
|---|---|
| Delete the `doc.status !== "PUBLISHED"` early return | `returns null for a result that is not published` |
| Delete the `.filter(topper => topper.consentAcknowledged === true)` | `drops a topper who has not acknowledged consent` |
| Add `...doc` as the first line of the returned object | `emits exactly the allowed top-level keys and no others` |
| Add `consentAcknowledged: topper.consentAcknowledged` to the topper map | `never emits consentAcknowledged itself, nor a topper _id` |

- [ ] **Step 6: Commit**

```bash
git add src/lib/results/public-projection.ts tests/unit/results-projection.test.ts
git commit -m "feat: add the results public projection allow-list"
```

---

### Task 5: ResultService — CRUD

**Files:**
- Create: `src/services/result.service.ts`
- Modify: `src/services/index.ts`
- Test: `tests/integration/results-crud.test.ts`

**Interfaces:**
- Consumes: `Result`, `ResultDoc` (Task 2); `createResultSchema`, `updateResultSchema`, `assertResultInvariants` (Task 3).
- Produces:
  - `type ResultDTO` — the institute-admin shape (everything, `_id` serialised to `id`)
  - `ResultService.list(institutionId: string): Promise<ResultDTO[]>`
  - `ResultService.get(institutionId: string, resultId: string): Promise<ResultDTO>` — throws `notFound` for a foreign or missing id
  - `ResultService.create(institutionId, input: z.infer<typeof createResultSchema>, actor: { id: string; name: string }): Promise<ResultDTO>`
  - `ResultService.update(institutionId, resultId, patch: z.infer<typeof updateResultSchema>, actor): Promise<ResultDTO>`
  - `ResultService.remove(institutionId, resultId, actor): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/results-crud.test.ts`:

```ts
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { ResultService } from "@/services/result.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

const cycle = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  stream: null,
  academicYear: "2025-26",
  appeared: 142,
  passed: 140,
};

beforeAll(() => startTestDatabase("results-crud"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("ResultService CRUD", () => {
  it("creates a cycle and reads it back", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);

    expect(created.id).toBeDefined();
    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();

    const read = await ResultService.get("INS0001", created.id);
    expect(read.academicYear).toBe("2025-26");
  });

  it("refuses a duplicate cycle via the unique index, not a pre-read", async () => {
    await ResultService.create("INS0001", cycle, actor);

    // A duplicate surfaces as a Mongo 11000, which handleApiError maps to CONFLICT.
    await expect(ResultService.create("INS0001", cycle, actor)).rejects.toMatchObject({
      code: 11000,
    });
  });

  it("lets two institutions hold the same cycle independently", async () => {
    await ResultService.create("INS0001", cycle, actor);
    await expect(ResultService.create("INS0002", cycle, actor)).resolves.toBeDefined();
  });

  it("treats a differing stream as a different cycle", async () => {
    await ResultService.create("INS0001", { ...cycle, level: "CLASS_12", stream: "SCIENCE" }, actor);
    await expect(
      ResultService.create("INS0001", { ...cycle, level: "CLASS_12", stream: "COMMERCE" }, actor),
    ).resolves.toBeDefined();
  });

  it("merges a partial patch without erasing untouched fields", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, averageScore: 82.4, highestScore: 98.6 },
      actor,
    );

    const updated = await ResultService.update("INS0001", created.id, { passed: 141 }, actor);

    expect(updated.passed).toBe(141);
    expect(updated.averageScore).toBe(82.4);
    expect(updated.highestScore).toBe(98.6);
  });

  it("validates invariants against the merged record, not the patch alone", async () => {
    const created = await ResultService.create("INS0001", { ...cycle, appeared: 10, passed: 5 }, actor);

    // The patch carries no `appeared`; the merged record still must hold.
    await expect(
      ResultService.update("INS0001", created.id, { passed: 11 }, actor),
    ).rejects.toThrow(/cannot exceed/i);
  });

  it("replaces arrays wholesale rather than merging them element by element", async () => {
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        bands: [
          { label: "A", minPercentage: 90, maxPercentage: 100, count: 5 },
          { label: "B", minPercentage: 75, maxPercentage: 89, count: 5 },
        ],
      },
      actor,
    );

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      { bands: [{ label: "Only", minPercentage: 60, maxPercentage: 100, count: 1 }] },
      actor,
    );

    expect(updated.bands).toHaveLength(1);
    expect(updated.bands?.[0]?.label).toBe("Only");
  });

  it("returns NOT_FOUND, never FORBIDDEN, for another institution's result", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);

    await expect(ResultService.get("INS0002", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      ResultService.update("INS0002", created.id, { passed: 1 }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ResultService.remove("INS0002", created.id, actor)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lists only the calling institution's cycles, newest academic year first", async () => {
    await ResultService.create("INS0001", { ...cycle, academicYear: "2024-25" }, actor);
    await ResultService.create("INS0001", { ...cycle, academicYear: "2025-26" }, actor);
    await ResultService.create("INS0002", cycle, actor);

    const list = await ResultService.list("INS0001");

    expect(list).toHaveLength(2);
    expect(list[0]?.academicYear).toBe("2025-26");
  });

  it("deletes a cycle", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.remove("INS0001", created.id, actor);

    await expect(ResultService.get("INS0001", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects a malformed resultId as NOT_FOUND rather than throwing a cast error", async () => {
    await expect(ResultService.get("INS0001", "not-an-object-id")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/results-crud.test.ts
```

Expected: FAIL — cannot resolve `@/services/result.service`.

- [ ] **Step 3: Create `src/services/result.service.ts`**

```ts
import "server-only";
import { Types } from "mongoose";
import type { z } from "zod";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Result, type ResultDoc } from "@/models";
import { notFound } from "@/lib/api/errors";
import {
  assertResultInvariants,
  type createResultSchema,
  type updateResultSchema,
} from "@/lib/validation/result";
import { ActivityService } from "./activity.service";

type CreateInput = z.infer<typeof createResultSchema>;
type UpdateInput = z.infer<typeof updateResultSchema>;

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
  status: string;
  publishedAt?: string;
  updatedAt?: string;
};

/**
 * A malformed id must read as "no such result", not as a 500. Every lookup
 * goes through here so a cast error can never escape as an internal error.
 */
function toObjectId(resultId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(resultId)) throw notFound("Result not found");
  return new Types.ObjectId(resultId);
}

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
    bands: row.bands?.length
      ? row.bands.map((band) => ({
          label: band.label,
          minPercentage: band.minPercentage,
          maxPercentage: band.maxPercentage,
          count: band.count,
        }))
      : undefined,
    toppers: row.toppers?.length
      ? row.toppers.map((topper) => ({
          id: String(topper._id),
          name: topper.name,
          percentage: topper.percentage,
          rank: topper.rank ?? undefined,
          note: topper.note ?? undefined,
          photoUrl: topper.photoUrl ?? undefined,
          consentAcknowledged: topper.consentAcknowledged === true,
        }))
      : undefined,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString(),
    updatedAt: (row as ResultDoc & { updatedAt?: Date }).updatedAt?.toISOString(),
  };
}

/** Every read is scoped by institutionId, so a foreign id is simply not found. */
async function findOwned(institutionId: string, resultId: string): Promise<ResultDoc> {
  const row = await Result.findOne({ _id: toObjectId(resultId), institutionId }).lean<ResultDoc>();
  if (!row) throw notFound("Result not found");
  return row;
}

export const ResultService = {
  async list(institutionId: string): Promise<ResultDTO[]> {
    await connectToDatabase();
    const rows = await Result.find({ institutionId })
      .sort({ academicYear: -1, createdAt: -1 })
      .lean<ResultDoc[]>();
    return rows.map(serialize);
  },

  async get(institutionId: string, resultId: string): Promise<ResultDTO> {
    await connectToDatabase();
    return serialize(await findOwned(institutionId, resultId));
  },

  async create(
    institutionId: string,
    input: CreateInput,
    actor: { id: string; name: string },
  ): Promise<ResultDTO> {
    await connectToDatabase();

    assertResultInvariants({
      board: input.board,
      boardName: input.boardName,
      appeared: input.appeared,
      passed: input.passed,
      bands: input.bands,
      toppers: input.toppers,
    });

    // Duplicate cycles are refused by the unique index rather than a pre-read:
    // a read-then-write races two browser tabs and creates both.
    const created = await Result.create({ ...input, institutionId, status: "DRAFT" });

    await ActivityService.record({
      institutionId,
      entityType: "RESULT",
      entityId: created._id,
      entityRef: institutionId,
      action: "Result created",
      description: `${input.board} ${input.level} ${input.academicYear} created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(created.toObject() as ResultDoc);
  },

  async update(
    institutionId: string,
    resultId: string,
    patch: UpdateInput,
    actor: { id: string; name: string },
  ): Promise<ResultDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, resultId);

    // Invariants hold against the MERGED record: a patch carrying only `passed`
    // must still be checked against the stored `appeared`.
    const merged = { ...before, ...stripUndefined(patch) };
    assertResultInvariants({
      board: merged.board,
      boardName: merged.boardName,
      appeared: merged.appeared ?? 0,
      passed: merged.passed ?? 0,
      bands: merged.bands,
      toppers: merged.toppers,
    });

    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: stripUndefined(patch) },
      { new: true },
    ).lean<ResultDoc>();
    if (!updated) throw notFound("Result not found");

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

  async remove(
    institutionId: string,
    resultId: string,
    actor: { id: string; name: string },
  ): Promise<void> {
    await connectToDatabase();
    const before = await findOwned(institutionId, resultId);

    await Result.deleteOne({ _id: before._id, institutionId });

    await ActivityService.record({
      institutionId,
      entityType: "RESULT",
      entityId: before._id,
      entityRef: institutionId,
      action: "Result deleted",
      description: `${before.board} ${before.level} ${before.academicYear} deleted`,
      performedBy: actor.id,
      performedByName: actor.name,
    });
  },
};

/**
 * A key absent from a patch arrives as `undefined` and must be left alone —
 * `$set: { averageScore: undefined }` would otherwise erase a stored value the
 * caller never mentioned. Arrays replace wholesale; they never merge.
 */
function stripUndefined<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
```

Note: `remove` deletes owned topper photos too — that behaviour is added in Task 7, once the photo helpers exist. Leaving it out here keeps this task's diff reviewable, and Task 7's test covers the gap.

- [ ] **Step 4: Export from the service barrel**

Add to `src/services/index.ts`, matching the existing export style:

```ts
export { ResultService, type ResultDTO } from "./result.service";
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tests/integration/results-crud.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Mutation-check the guards**

| Mutation | Test that must fail |
|---|---|
| Drop `institutionId` from the `findOwned` filter | `returns NOT_FOUND, never FORBIDDEN, for another institution's result` |
| Delete the `Types.ObjectId.isValid` check | `rejects a malformed resultId as NOT_FOUND rather than throwing a cast error` |
| Call `assertResultInvariants` on `patch` instead of `merged` | `validates invariants against the merged record, not the patch alone` |
| Delete the `stripUndefined` call in `update` | `merges a partial patch without erasing untouched fields` |

- [ ] **Step 7: Commit**

```bash
git add src/services/result.service.ts src/services/index.ts tests/integration/results-crud.test.ts
git commit -m "feat: add ResultService create, read, update, delete"
```

---

### Task 6: ResultService — publish and unpublish

**Files:**
- Modify: `src/services/result.service.ts`
- Test: `tests/integration/results-publish.test.ts`

**Interfaces:**
- Consumes: `ResultService`, `ResultDTO`, `findOwned`, `serialize` (Task 5); `assertPublishable` (Task 3).
- Produces: `ResultService.setStatus(institutionId, resultId, action: "publish" | "unpublish" | "archive", actor): Promise<ResultDTO>`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/results-publish.test.ts`:

```ts
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { ResultService } from "@/services/result.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };
const cycle = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  stream: null,
  academicYear: "2025-26",
  appeared: 142,
  passed: 140,
};

beforeAll(() => startTestDatabase("results-publish"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("publish lifecycle", () => {
  it("publishes a valid cycle and stamps publishedAt", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const published = await ResultService.setStatus("INS0001", created.id, "publish", actor);

    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).toBeDefined();
  });

  it("refuses to publish a cycle with nobody appearing", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, appeared: 0, passed: 0 },
      actor,
    );

    await expect(
      ResultService.setStatus("INS0001", created.id, "publish", actor),
    ).rejects.toThrow(/appeared/i);
  });

  it("refuses to publish while a topper lacks acknowledged consent", async () => {
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        toppers: [
          { name: "Priya S", percentage: 98.6, consentAcknowledged: true },
          { name: "Rahul K", percentage: 97.8, consentAcknowledged: false },
        ],
      },
      actor,
    );

    await expect(
      ResultService.setStatus("INS0001", created.id, "publish", actor),
    ).rejects.toThrow(/Rahul K/);
  });

  it("keeps publishedAt at the FIRST publication across a republish", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const first = await ResultService.setStatus("INS0001", created.id, "publish", actor);

    await ResultService.setStatus("INS0001", created.id, "unpublish", actor);
    const again = await ResultService.setStatus("INS0001", created.id, "publish", actor);

    expect(again.publishedAt).toBe(first.publishedAt);
  });

  it("unpublishing returns the cycle to DRAFT without losing data", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, averageScore: 82.4 },
      actor,
    );
    await ResultService.setStatus("INS0001", created.id, "publish", actor);
    const drafted = await ResultService.setStatus("INS0001", created.id, "unpublish", actor);

    expect(drafted.status).toBe("DRAFT");
    expect(drafted.averageScore).toBe(82.4);
    expect(drafted.publishedAt).toBeDefined();
  });

  it("archives a published cycle", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.setStatus("INS0001", created.id, "publish", actor);
    const archived = await ResultService.setStatus("INS0001", created.id, "archive", actor);

    expect(archived.status).toBe("ARCHIVED");
  });

  it("refuses to change another institution's result", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);

    await expect(
      ResultService.setStatus("INS0002", created.id, "publish", actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/results-publish.test.ts
```

Expected: FAIL — `ResultService.setStatus is not a function`.

- [ ] **Step 3: Add `setStatus` to `src/services/result.service.ts`**

Import `assertPublishable` alongside the existing `assertResultInvariants` import, then add this method to the `ResultService` object:

```ts
  async setStatus(
    institutionId: string,
    resultId: string,
    action: "publish" | "unpublish" | "archive",
    actor: { id: string; name: string },
  ): Promise<ResultDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, resultId);

    const status = action === "publish" ? "PUBLISHED" : action === "archive" ? "ARCHIVED" : "DRAFT";

    if (action === "publish") {
      assertPublishable({
        board: before.board,
        boardName: before.boardName,
        appeared: before.appeared ?? 0,
        passed: before.passed ?? 0,
        bands: before.bands,
        toppers: before.toppers,
      });
    }

    const set: Record<string, unknown> = { status };
    // Stamped on first publication and never moved: it records when this cycle
    // was first made public, not when it was last touched.
    if (action === "publish" && !before.publishedAt) set.publishedAt = new Date();

    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<ResultDoc>();
    if (!updated) throw notFound("Result not found");

    await ActivityService.record({
      institutionId,
      entityType: "RESULT",
      entityId: updated._id,
      entityRef: institutionId,
      action: `Result ${action}ed`,
      description: `${updated.board} ${updated.level} ${updated.academicYear}`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/integration/results-publish.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-check the guards**

| Mutation | Test that must fail |
|---|---|
| Delete the `if (action === "publish") assertPublishable(...)` block | `refuses to publish while a topper lacks acknowledged consent` |
| Change the stamp to `set.publishedAt = new Date()` unconditionally | `keeps publishedAt at the FIRST publication across a republish` |

- [ ] **Step 6: Commit**

```bash
git add src/services/result.service.ts tests/integration/results-publish.test.ts
git commit -m "feat: add result publish, unpublish and archive transitions"
```

---

### Task 7: ResultService — topper photos

The module's second security-sensitive surface. Photos land under `media/<institutionId>/…` so the existing `isOwnedMediaUrl()` guard covers them, and every delete path checks provenance before calling `deletePublic`.

**Files:**
- Modify: `src/services/result.service.ts`
- Test: `tests/integration/results-media.test.ts`

**Interfaces:**
- Consumes: `validateImage` and `MAX_IMAGE_BYTES` from `@/lib/media/image`, `isOwnedMediaUrl` from `@/lib/media/ownership` (Task 1); `storage` from `@/lib/storage`.
- Produces:
  - `ResultService.setTopperPhoto(institutionId, resultId, topperId, input: { contentType: string; bytes: Buffer }, actor): Promise<ResultDTO>`
  - `ResultService.removeTopperPhoto(institutionId, resultId, topperId, actor): Promise<ResultDTO>`
  - `ResultService.remove` gains owned-photo cleanup.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/results-media.test.ts`. A real 1×1 PNG is used so the magic-number sniff in `validateImage` passes.

```ts
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { ResultService } from "@/services/result.service";
import { Result } from "@/models";
import { storage } from "@/lib/storage";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };
const cycle = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  stream: null,
  academicYear: "2025-26",
  appeared: 10,
  passed: 10,
  toppers: [{ name: "Priya S", percentage: 98.6, consentAcknowledged: true }],
};

/** Smallest valid PNG — the upload guard sniffs magic numbers, so this must be real. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(() => startTestDatabase("results-media"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("topper photos", () => {
  it("stores a photo under the calling institution's owned media prefix", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    const updated = await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );

    const photoUrl = updated.toppers?.[0]?.photoUrl as string;
    expect(photoUrl).toBeDefined();
    expect(photoUrl).toContain("/media/INS0001/");
  });

  it("rejects a file whose bytes do not match its declared type", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    await expect(
      ResultService.setTopperPhoto(
        "INS0001",
        created.id,
        topperId,
        { contentType: "image/png", bytes: Buffer.from("not a png at all") },
        actor,
      ),
    ).rejects.toThrow(/do not match the declared file type/i);
  });

  it("rejects a content type that is not an allowed image", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    await expect(
      ResultService.setTopperPhoto(
        "INS0001",
        created.id,
        topperId,
        { contentType: "application/pdf", bytes: PNG },
        actor,
      ),
    ).rejects.toThrow(/JPG, PNG and WEBP/i);
  });

  it("replaces a photo and deletes the one it replaced", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    const first = await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const firstUrl = first.toppers?.[0]?.photoUrl as string;

    const second = await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const secondUrl = second.toppers?.[0]?.photoUrl as string;

    expect(secondUrl).not.toBe(firstUrl);
    // The replaced object is gone from the public store.
    expect(await storage.get(firstUrl.replace("/api/media/", ""))).toBeNull();
  });

  it("removes a photo and clears the field", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const cleared = await ResultService.removeTopperPhoto("INS0001", created.id, topperId, actor);

    expect(cleared.toppers?.[0]?.photoUrl).toBeUndefined();
  });

  it("never deletes a stored URL that this institution does not own", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    // Simulate a foreign URL reaching the stored field by any route.
    const foreign = "/api/media/media/INS0002/somebody-elses-photo.png";
    await Result.updateOne(
      { _id: created.id, "toppers._id": topperId },
      { $set: { "toppers.$.photoUrl": foreign } },
    );

    // Put a real object at the foreign key so its survival is observable.
    await storage.putPublic({
      key: "media/INS0002/somebody-elses-photo.png",
      body: PNG,
      contentType: "image/png",
    });

    await ResultService.removeTopperPhoto("INS0001", created.id, topperId, actor);

    // The foreign object must still exist — the guard refused to delete it.
    const survivor = await storage.get("media/INS0002/somebody-elses-photo.png");
    expect(survivor).not.toBeNull();
  });

  it("deleting a result cleans up only the photos it owns", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    const withPhoto = await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const ownUrl = withPhoto.toppers?.[0]?.photoUrl as string;

    await ResultService.remove("INS0001", created.id, actor);

    expect(await storage.get(ownUrl.replace("/api/media/", ""))).toBeNull();
  });

  it("refuses to touch another institution's result", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    await expect(
      ResultService.setTopperPhoto(
        "INS0002",
        created.id,
        topperId,
        { contentType: "image/png", bytes: PNG },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns NOT_FOUND for a topper id that is not on this result", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);

    await expect(
      ResultService.setTopperPhoto(
        "INS0001",
        created.id,
        "6a887abd755db527bea51204",
        { contentType: "image/png", bytes: PNG },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/results-media.test.ts
```

Expected: FAIL — `ResultService.setTopperPhoto is not a function`.

- [ ] **Step 3: Add the photo methods to `src/services/result.service.ts`**

Add these imports at the top:

```ts
import { storage } from "@/lib/storage";
import { validateImage } from "@/lib/media/image";
import { isOwnedMediaUrl } from "@/lib/media/ownership";
```

Add this module-level helper below `findOwned`:

```ts
/**
 * Deletes a stored public object only when it provably belongs to this
 * institution. A stored URL can be attacker-influenced, and `deletePublic` is
 * not tenant-scoped, so an unguarded cleanup would delete another tenant's
 * object out of the shared store. A URL that fails the check is left alone —
 * never deleted, and never allowed to block the operation that triggered it.
 */
async function deleteOwnedPhoto(url: string | null | undefined, institutionId: string) {
  if (!isOwnedMediaUrl(url, institutionId)) return;
  await storage.deletePublic(url as string).catch(() => undefined);
}
```

Add these two methods to the `ResultService` object:

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

    const topper = before.toppers?.find((row) => String(row._id) === topperId);
    if (!topper) throw notFound("Topper not found");

    const { extension } = validateImage(input);

    // Never derived from a client-supplied filename, and always under the
    // institution's own prefix so isOwnedMediaUrl covers it.
    const objectId = new Types.ObjectId();
    const key = `media/${institutionId}/results/${String(before._id)}/${objectId.toHexString()}${extension}`;
    const stored = await storage.putPublic({
      key,
      body: input.bytes,
      contentType: input.contentType,
    });

    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId, "toppers._id": topper._id },
      { $set: { "toppers.$.photoUrl": stored.key } },
      { new: true },
    ).lean<ResultDoc>();
    if (!updated) throw notFound("Result not found");

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

  async removeTopperPhoto(
    institutionId: string,
    resultId: string,
    topperId: string,
    actor: { id: string; name: string },
  ): Promise<ResultDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, resultId);

    const topper = before.toppers?.find((row) => String(row._id) === topperId);
    if (!topper) throw notFound("Topper not found");

    const updated = await Result.findOneAndUpdate(
      { _id: before._id, institutionId, "toppers._id": topper._id },
      { $unset: { "toppers.$.photoUrl": "" } },
      { new: true },
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

- [ ] **Step 4: Add photo cleanup to `remove`**

In `ResultService.remove`, insert this between the `deleteOne` call and the activity record:

```ts
    for (const topper of before.toppers ?? []) {
      await deleteOwnedPhoto(topper.photoUrl, institutionId);
    }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tests/integration/results-media.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Mutation-check the guards**

| Mutation | Test that must fail |
|---|---|
| Replace `deleteOwnedPhoto` body with a bare `storage.deletePublic(url)` | `never deletes a stored URL that this institution does not own` |
| Delete the `validateImage(input)` call | `rejects a file whose bytes do not match its declared type` |
| Change the key to `media/${topperId}${extension}` (dropping the institution prefix) | `stores a photo under the calling institution's owned media prefix` |
| Delete the topper-photo loop in `remove` | `deleting a result cleans up only the photos it owns` |

- [ ] **Step 7: Run the whole suite and commit**

```bash
npm test -- --run
git add src/services/result.service.ts tests/integration/results-media.test.ts
git commit -m "feat: add topper photo upload and removal with provenance-guarded cleanup"
```

---

### Task 8: Institute-admin routes

**Files:**
- Create: `src/app/api/settings/results/route.ts`
- Create: `src/app/api/settings/results/[resultId]/route.ts`
- Create: `src/app/api/settings/results/[resultId]/publish/route.ts`
- Test: `tests/integration/results-routes.test.ts`

**Interfaces:**
- Consumes: `ResultService` (Tasks 5–6); `createResultSchema`, `updateResultSchema` (Task 3); `requireInstitution`, `assertSameOrigin`, `jsonSuccess`, `handleApiError`, `validationError`.
- Produces: the six institute-admin endpoints. Response envelopes: `{ success: true, results }` for the list, `{ success: true, result }` for a single record.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/results-routes.test.ts`. Follow the calling convention already used by `tests/integration/profile-routes.test.ts` for building a session — read that file first and mirror its helper usage rather than inventing a new one.

```ts
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { ResultService } from "@/services/result.service";

const cycle = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  stream: null,
  academicYear: "2025-26",
  appeared: 142,
  passed: 140,
};

/**
 * Routes resolve the caller through requireInstitution(); the tests drive that
 * seam directly rather than minting cookies, exactly as profile-routes.test.ts
 * does. Read that file and copy its mocking approach verbatim.
 */
vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    requireInstitution: vi.fn(),
  };
});

const { requireInstitution } = await import("@/lib/tenant");
const asInstitution = (institutionId: string) =>
  vi.mocked(requireInstitution).mockResolvedValue({
    user: { id: "6a887abd755db527bea51204", name: "Infinity Admissions", role: "INSTITUTION_ADMIN" },
    institution: { institutionId, active: true },
  } as never);

beforeAll(() => startTestDatabase("results-routes"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
  vi.clearAllMocks();
});

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("institute-admin results routes", () => {
  it("creates a cycle over HTTP", async () => {
    asInstitution("INS0001");
    const { POST } = await import("@/app/api/settings/results/route");

    const response = await POST(post("http://localhost/api/settings/results", cycle) as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.result.status).toBe("DRAFT");
  });

  it("maps a duplicate cycle to CONFLICT rather than a 500", async () => {
    asInstitution("INS0001");
    const { POST } = await import("@/app/api/settings/results/route");

    await POST(post("http://localhost/api/settings/results", cycle) as never);
    const response = await POST(post("http://localhost/api/settings/results", cycle) as never);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("CONFLICT");
  });

  it("rejects a body that violates an invariant", async () => {
    asInstitution("INS0001");
    const { POST } = await import("@/app/api/settings/results/route");

    const response = await POST(
      post("http://localhost/api/settings/results", { ...cycle, appeared: 10, passed: 11 }) as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("lists only the caller's cycles", async () => {
    await ResultService.create("INS0001", cycle, { id: "u", name: "n" });
    await ResultService.create("INS0002", cycle, { id: "u", name: "n" });

    asInstitution("INS0001");
    const { GET } = await import("@/app/api/settings/results/route");

    const payload = await (await GET()).json();
    expect(payload.results).toHaveLength(1);
  });

  it("returns 404 for another institution's result", async () => {
    const created = await ResultService.create("INS0001", cycle, { id: "u", name: "n" });

    asInstitution("INS0002");
    const { GET } = await import("@/app/api/settings/results/[resultId]/route");

    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ resultId: created.id }),
    } as never);

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  it("publishes through the publish route", async () => {
    const created = await ResultService.create("INS0001", cycle, { id: "u", name: "n" });

    asInstitution("INS0001");
    const { POST } = await import("@/app/api/settings/results/[resultId]/publish/route");

    const response = await POST(
      post("http://localhost/publish", { action: "publish" }) as never,
      { params: Promise.resolve({ resultId: created.id }) } as never,
    );

    expect((await response.json()).result.status).toBe("PUBLISHED");
  });

  it("rejects an unknown publish action", async () => {
    const created = await ResultService.create("INS0001", cycle, { id: "u", name: "n" });

    asInstitution("INS0001");
    const { POST } = await import("@/app/api/settings/results/[resultId]/publish/route");

    const response = await POST(
      post("http://localhost/publish", { action: "delete-everything" }) as never,
      { params: Promise.resolve({ resultId: created.id }) } as never,
    );

    expect(response.status).toBe(400);
  });

  it("rejects a SUPER_ADMIN caller — the platform admin has no route to results", async () => {
    vi.mocked(requireInstitution).mockRejectedValue(
      Object.assign(new Error("forbidden"), { code: "FORBIDDEN", status: 403 }),
    );
    const { GET } = await import("@/app/api/settings/results/route");

    const response = await GET();
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/results-routes.test.ts
```

Expected: FAIL — cannot resolve the route modules.

- [ ] **Step 3: Create `src/app/api/settings/results/route.ts`**

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { createResultSchema } from "@/lib/validation/result";
import { ResultService } from "@/services/result.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const results = await ResultService.list(institution.institutionId);
    return jsonSuccess({ results });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = createResultSchema.parse(await request.json().catch(() => ({})));

    const result = await ResultService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ result });
  } catch (error) {
    // A duplicate cycle arrives here as a Mongo 11000, which handleApiError
    // already maps to CONFLICT — the unique index is the check, not a pre-read.
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: Create `src/app/api/settings/results/[resultId]/route.ts`**

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateResultSchema } from "@/lib/validation/result";
import { ResultService } from "@/services/result.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/settings/results/[resultId]">,
) {
  try {
    const { resultId } = await context.params;
    const { institution } = await requireInstitution();
    const result = await ResultService.get(institution.institutionId, resultId);
    return jsonSuccess({ result });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/results/[resultId]">,
) {
  try {
    assertSameOrigin(request);
    const { resultId } = await context.params;
    const { user, institution } = await requireInstitution();
    const patch = updateResultSchema.parse(await request.json().catch(() => ({})));

    const result = await ResultService.update(institution.institutionId, resultId, patch, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ result });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/results/[resultId]">,
) {
  try {
    assertSameOrigin(request);
    const { resultId } = await context.params;
    const { user, institution } = await requireInstitution();

    await ResultService.remove(institution.institutionId, resultId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: Create `src/app/api/settings/results/[resultId]/publish/route.ts`**

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { ResultService } from "@/services/result.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const ACTIONS = ["publish", "unpublish", "archive"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/settings/results/[resultId]/publish">,
) {
  try {
    assertSameOrigin(request);
    const { resultId } = await context.params;
    const { user, institution } = await requireInstitution();

    const body = (await request.json().catch(() => ({}))) as { action?: string };
    if (!ACTIONS.includes(body.action as Action)) {
      throw validationError(`action: must be one of ${ACTIONS.join(", ")}`);
    }

    const result = await ResultService.setStatus(
      institution.institutionId,
      resultId,
      body.action as Action,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ result });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run tests/integration/results-routes.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/settings/results tests/integration/results-routes.test.ts
git commit -m "feat: add institute-admin results routes"
```

---

### Task 9: Topper photo routes

**Files:**
- Create: `src/app/api/settings/results/[resultId]/toppers/[topperId]/photo/route.ts`
- Test: append to `tests/integration/results-media.test.ts`

**Interfaces:**
- Consumes: `ResultService.setTopperPhoto`, `ResultService.removeTopperPhoto` (Task 7); `MAX_IMAGE_BYTES` from `@/lib/media/image` (Task 1).
- Produces: `POST` and `DELETE` at `/api/settings/results/:resultId/toppers/:topperId/photo`, both returning `{ success: true, result }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/results-media.test.ts`:

```ts
describe("topper photo routes", () => {
  it("accepts a multipart upload and returns the updated result", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    const form = new FormData();
    form.append("file", new File([new Uint8Array(PNG)], "priya.png", { type: "image/png" }));

    const { POST } = await import(
      "@/app/api/settings/results/[resultId]/toppers/[topperId]/photo/route"
    );
    const response = await POST(
      new Request("http://localhost/photo", { method: "POST", body: form }) as never,
      { params: Promise.resolve({ resultId: created.id, topperId }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.result.toppers[0].photoUrl).toContain("/media/INS0001/");
  });

  it("rejects a request with no file", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    const { POST } = await import(
      "@/app/api/settings/results/[resultId]/toppers/[topperId]/photo/route"
    );
    const response = await POST(
      new Request("http://localhost/photo", { method: "POST", body: new FormData() }) as never,
      { params: Promise.resolve({ resultId: created.id, topperId }) } as never,
    );

    expect(response.status).toBe(400);
  });
});
```

This test needs the same `requireInstitution` mock the routes test uses; add the identical `vi.mock("@/lib/tenant", …)` block and `asInstitution("INS0001")` helper to the top of this file, copied verbatim from `tests/integration/results-routes.test.ts`, and call `asInstitution("INS0001")` at the start of each of the two tests above.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/results-media.test.ts
```

Expected: FAIL — cannot resolve the photo route module.

- [ ] **Step 3: Create the route**

`src/app/api/settings/results/[resultId]/toppers/[topperId]/photo/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { ResultService } from "@/services/result.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";
import { MAX_IMAGE_BYTES } from "@/lib/media/image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Multipart photo upload for one topper on one of the caller's own results. */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/settings/results/[resultId]/toppers/[topperId]/photo">,
) {
  try {
    assertSameOrigin(request);
    const { resultId, topperId } = await context.params;
    const { user, institution } = await requireInstitution();

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw validationError("file: choose a file to upload");
    if (file.size <= 0) throw validationError("file: the file is empty");
    if (file.size > MAX_IMAGE_BYTES) throw validationError("file: files must be 5 MB or smaller");

    const result = await ResultService.setTopperPhoto(
      institution.institutionId,
      resultId,
      topperId,
      { contentType: file.type, bytes: Buffer.from(await file.arrayBuffer()) },
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ result });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/results/[resultId]/toppers/[topperId]/photo">,
) {
  try {
    assertSameOrigin(request);
    const { resultId, topperId } = await context.params;
    const { user, institution } = await requireInstitution();

    const result = await ResultService.removeTopperPhoto(
      institution.institutionId,
      resultId,
      topperId,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ result });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/integration/results-media.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/settings/results/[resultId]/toppers" tests/integration/results-media.test.ts
git commit -m "feat: add topper photo upload and delete routes"
```

---

### Task 10: Public results endpoints

The module's public face. Every rule in the Global Constraints about 404-never-403, rate limiting and caching lands here.

**Files:**
- Modify: `src/services/result.service.ts` (add `listPublic`)
- Create: `src/app/api/public/[institutionId]/results/route.ts`
- Create: `src/app/api/public/institutions/[slug]/results/route.ts`
- Test: `tests/integration/results-public.test.ts`

**Interfaces:**
- Consumes: `toPublicResult` (Task 4); `Institution` model; `consumeRateLimit`, `rateLimitHeaders`, `getClientIp`, `PUBLIC_READ_RATE_LIMIT`, `publicCorsPreflight`.
- Produces: `ResultService.listPublic(query: { institutionId?: string; slug?: string; academicYear?: string; level?: string; board?: string }): Promise<PublicResult[] | null>` — `null` means the institution is not publicly visible (the caller turns that into a 404); an empty array means it is visible but has no matching published results.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/results-public.test.ts`:

```ts
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { ResultService } from "@/services/result.service";
import { Institution, Result } from "@/models";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };
const cycle = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  stream: null,
  academicYear: "2025-26",
  appeared: 142,
  passed: 140,
};

const call = async (institutionId: string, query = "") => {
  const { GET } = await import("@/app/api/public/[institutionId]/results/route");
  return GET(new Request(`http://localhost/api/public/${institutionId}/results${query}`) as never, {
    params: Promise.resolve({ institutionId }),
  } as never);
};

/** A publicly visible institution needs both flags, exactly like the profile endpoint. */
async function publishInstitution(institutionId: string, slug: string) {
  await Institution.updateOne(
    { institutionId },
    { $set: { slug, profileStatus: "PUBLISHED", active: true } },
  );
}

beforeAll(() => startTestDatabase("results-public"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await publishInstitution("INS0001", "infinity-school");
});

describe("public results endpoint", () => {
  it("returns a published cycle with a computed pass percentage", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.setStatus("INS0001", created.id, "publish", actor);

    const response = await call("INS0001");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].passPercentage).toBe(98.6);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("is reachable by slug and returns the same payload", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.setStatus("INS0001", created.id, "publish", actor);

    const { GET } = await import("@/app/api/public/institutions/[slug]/results/route");
    const response = await GET(
      new Request("http://localhost/api/public/institutions/infinity-school/results") as never,
      { params: Promise.resolve({ slug: "infinity-school" }) } as never,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).results).toHaveLength(1);
  });

  it("hides a draft cycle without revealing that it exists", async () => {
    await ResultService.create("INS0001", cycle, actor);

    const payload = await (await call("INS0001")).json();
    expect(payload.results).toHaveLength(0);
  });

  it("hides an archived cycle", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.setStatus("INS0001", created.id, "publish", actor);
    await ResultService.setStatus("INS0001", created.id, "archive", actor);

    expect((await (await call("INS0001")).json()).results).toHaveLength(0);
  });

  it("returns 404, never 403, for an institution that is not publicly visible", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.setStatus("INS0001", created.id, "publish", actor);

    await Institution.updateOne({ institutionId: "INS0001" }, { $set: { active: false } });

    const response = await call("INS0001");
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns 404 for an institution whose profile is still a draft", async () => {
    await Institution.updateOne({ institutionId: "INS0001" }, { $set: { profileStatus: "DRAFT" } });

    expect((await call("INS0001")).status).toBe(404);
  });

  it("returns 404 for an institution that does not exist", async () => {
    expect((await call("INS9999")).status).toBe(404);
  });

  it("omits a topper who has not acknowledged consent", async () => {
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        toppers: [
          { name: "Priya S", percentage: 98.6, consentAcknowledged: true },
          { name: "Rahul K", percentage: 97.8, consentAcknowledged: true },
        ],
      },
      actor,
    );
    await ResultService.setStatus("INS0001", created.id, "publish", actor);

    const body = JSON.stringify(await (await call("INS0001")).json());
    expect(body).toContain("Priya S");
    expect(body).toContain("Rahul K");
  });

  it("drops a topper on the very next read when consent is withdrawn after publication", async () => {
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        toppers: [
          { name: "Priya S", percentage: 98.6, consentAcknowledged: true },
          { name: "Rahul K", percentage: 97.8, consentAcknowledged: true },
        ],
      },
      actor,
    );
    await ResultService.setStatus("INS0001", created.id, "publish", actor);

    // Consent withdrawn while the cycle stays PUBLISHED.
    await Result.updateOne(
      { _id: created.id, "toppers.name": "Rahul K" },
      { $set: { "toppers.$.consentAcknowledged": false } },
    );

    const body = JSON.stringify(await (await call("INS0001")).json());
    expect(body).toContain("Priya S");
    expect(body).not.toContain("Rahul K");
  });

  it("never leaks internal fields", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.setStatus("INS0001", created.id, "publish", actor);

    const body = JSON.stringify(await (await call("INS0001")).json());
    expect(body).not.toContain("institutionId");
    expect(body).not.toContain("consentAcknowledged");
    expect(body).not.toContain("_id");
  });

  it("filters by academicYear, level and board", async () => {
    for (const year of ["2024-25", "2025-26"]) {
      const created = await ResultService.create("INS0001", { ...cycle, academicYear: year }, actor);
      await ResultService.setStatus("INS0001", created.id, "publish", actor);
    }

    expect((await (await call("INS0001", "?academicYear=2025-26")).json()).results).toHaveLength(1);
    expect((await (await call("INS0001", "?level=CLASS_10")).json()).results).toHaveLength(2);
    expect((await (await call("INS0001", "?board=CBSE")).json()).results).toHaveLength(2);
  });

  it("returns an empty list, not an error, for a filter that matches nothing", async () => {
    const response = await call("INS0001", "?academicYear=1999-00");

    expect(response.status).toBe(200);
    expect((await response.json()).results).toHaveLength(0);
  });

  it("rejects an unknown filter value as a validation error", async () => {
    expect((await call("INS0001", "?level=NOT_A_LEVEL")).status).toBe(400);
  });

  it("blocks a burst of reads from one IP once the limit is spent", async () => {
    const { PUBLIC_READ_RATE_LIMIT } = await import("@/lib/constants");

    let last = await call("INS0001");
    for (let i = 0; i < PUBLIC_READ_RATE_LIMIT.limit + 1; i += 1) {
      last = await call("INS0001");
    }

    expect(last.status).toBe(429);
    expect((await last.json()).error.code).toBe("RATE_LIMITED");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/results-public.test.ts
```

Expected: FAIL — cannot resolve the public route modules.

- [ ] **Step 3: Add `listPublic` to `src/services/result.service.ts`**

Add these imports:

```ts
import { Institution } from "@/models";
import { toPublicResult, type PublicResult } from "@/lib/results/public-projection";
```

Add this method to the `ResultService` object:

```ts
  /**
   * Returns null when the institution is not publicly visible at all — the
   * caller turns that into a 404. An empty array means "visible, but nothing
   * published", which is a 200. Keeping the two apart here is what lets the
   * route stay free of a 403 branch.
   *
   * The visibility gate is deliberately identical to the profile endpoint's, so
   * results can never be reachable on an institution whose profile 404s.
   */
  async listPublic(query: {
    institutionId?: string;
    slug?: string;
    academicYear?: string;
    level?: string;
    board?: string;
  }): Promise<PublicResult[] | null> {
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
    if (query.level) filter.level = query.level;
    if (query.board) filter.board = query.board;

    const rows = await Result.find(filter)
      .sort({ academicYear: -1, createdAt: -1 })
      .lean<ResultDoc[]>();

    // The projection is the allow-list; it also re-checks PUBLISHED and drops
    // unconsented toppers, so a filter mistake here cannot leak either.
    return rows
      .map((row) => toPublicResult(row as unknown as Record<string, unknown>))
      .filter((row): row is PublicResult => row !== null);
  },
```

- [ ] **Step 4: Create `src/app/api/public/[institutionId]/results/route.ts`**

```ts
import { ResultService } from "@/services/result.service";
import { resultQuerySchema } from "@/lib/validation/result";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "public, max-age=300" };

/**
 * Credential-free. A draft result, an archived result, a suspended institution
 * and a nonexistent institution are indistinguishable here: there is no 403
 * branch to write, because none exists.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/public/[institutionId]/results">,
) {
  try {
    const { institutionId } = await context.params;

    // Keyed on IP only — never on institutionId, so one institution's traffic
    // cannot exhaust another's allowance.
    const limit = await consumeRateLimit(
      `public-results:${getClientIp(request)}`,
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
    const query = resultQuerySchema.parse({
      academicYear: url.searchParams.get("academicYear") ?? undefined,
      level: url.searchParams.get("level") ?? undefined,
      board: url.searchParams.get("board") ?? undefined,
    });

    const results = await ResultService.listPublic({ institutionId, ...query });
    if (results === null) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: HEADERS });
    }

    return jsonSuccess({ results }, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, HEADERS);
  }
}

export async function OPTIONS() {
  return publicCorsPreflight();
}
```

- [ ] **Step 5: Create `src/app/api/public/institutions/[slug]/results/route.ts`**

Identical apart from the lookup key. The duplication is deliberate and matches Phase 1: two addressing schemes, two thin routes, one service method.

```ts
import { ResultService } from "@/services/result.service";
import { resultQuerySchema } from "@/lib/validation/result";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "public, max-age=300" };

export async function GET(
  request: Request,
  context: RouteContext<"/api/public/institutions/[slug]/results">,
) {
  try {
    const { slug } = await context.params;

    const limit = await consumeRateLimit(
      `public-results:${getClientIp(request)}`,
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
    const query = resultQuerySchema.parse({
      academicYear: url.searchParams.get("academicYear") ?? undefined,
      level: url.searchParams.get("level") ?? undefined,
      board: url.searchParams.get("board") ?? undefined,
    });

    const results = await ResultService.listPublic({ slug, ...query });
    if (results === null) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: HEADERS });
    }

    return jsonSuccess({ results }, { headers: HEADERS });
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
npx vitest run tests/integration/results-public.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 7: Mutation-check the guards**

| Mutation | Test that must fail |
|---|---|
| Drop `active: true` from the `listPublic` institution lookup | `returns 404, never 403, for an institution that is not publicly visible` |
| Drop `profileStatus: "PUBLISHED"` from the lookup | `returns 404 for an institution whose profile is still a draft` |
| Drop `status: "PUBLISHED"` from the result filter | `hides a draft cycle without revealing that it exists` |
| Return `[]` instead of `null` for a missing institution | `returns 404 for an institution that does not exist` |
| Delete the `consumeRateLimit` block | `blocks a burst of reads from one IP once the limit is spent` |
| Key the rate limit on `institutionId` instead of IP | (no test fails — this is why the key is called out in the code comment; verify by reading, not by test) |

- [ ] **Step 8: Run the whole suite and commit**

```bash
npm test -- --run
git add src/services/result.service.ts "src/app/api/public/[institutionId]/results" "src/app/api/public/institutions/[slug]/results" tests/integration/results-public.test.ts
git commit -m "feat: add credential-free public results endpoints by id and slug"
```

---

### Task 11: OpenAPI

**Files:**
- Modify: `src/lib/api/openapi.ts`
- Test: `tests/unit/openapi-results.test.ts`

**Interfaces:**
- Consumes: the public paths from Task 10.
- Produces: two documented paths under the existing `Website` tag, plus a `PublicResultsResponse` schema.

Read `tests/unit/openapi-profile.test.ts` first and mirror its structure — it is the closest precedent, and it also shows how the generator is invoked in a test.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/openapi-results.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";

const doc = buildOpenApiDocument({ origin: "https://admissions.test" }) as {
  paths: Record<string, Record<string, { tags?: string[]; security?: unknown[] }>>;
  components: { schemas: Record<string, unknown> };
};

describe("OpenAPI — results", () => {
  it("documents the public results path by institution id", () => {
    expect(doc.paths["/api/public/{institutionId}/results"]?.get).toBeDefined();
  });

  it("documents the public results path by slug", () => {
    expect(doc.paths["/api/public/institutions/{slug}/results"]?.get).toBeDefined();
  });

  it("tags both as Website and declares them credential-free", () => {
    for (const path of [
      "/api/public/{institutionId}/results",
      "/api/public/institutions/{slug}/results",
    ]) {
      const operation = doc.paths[path]?.get;
      expect(operation?.tags).toContain("Website");
      expect(operation?.security).toEqual([]);
    }
  });

  it("defines the response schema", () => {
    expect(doc.components.schemas.PublicResultsResponse).toBeDefined();
  });

  it("never documents an institute-admin results route in the public spec", () => {
    const adminPaths = Object.keys(doc.paths).filter((path) =>
      path.startsWith("/api/settings/results"),
    );
    expect(adminPaths).toEqual([]);
  });
});
```

If `buildOpenApiDocument` is not the exported name in `src/lib/api/openapi.ts`, use whatever `tests/unit/openapi-profile.test.ts` imports — match that file exactly rather than guessing.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/openapi-results.test.ts
```

Expected: FAIL — the paths are absent.

- [ ] **Step 3: Add the paths**

In `src/lib/api/openapi.ts`, alongside the existing `` [`${publicBase}/profile`] `` entry, add:

```ts
    [`${publicBase}/results`]: {
      ...(scoped ? {} : { parameters: [{ name: "institutionId", in: "path", required: true, schema: { type: "string" }, description: "Institution id, e.g. INS0001" }] }),
      get: {
        tags: ["Website"],
        summary: "List the institution's published exam results",
        description:
          "Published exam-cycle results, newest academic year first. Toppers appear only where the institution has confirmed consent to publish. Cached for five minutes.",
        operationId: "listPublicResultsById",
        security: [],
        parameters: [
          { name: "academicYear", in: "query", required: false, schema: { type: "string" }, example: "2025-26" },
          { name: "level", in: "query", required: false, schema: { type: "string", enum: [...RESULT_LEVELS] } },
          { name: "board", in: "query", required: false, schema: { type: "string", enum: [...RESULT_BOARDS] } },
        ],
        responses: {
          "200": {
            description: "Published results for this institution",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PublicResultsResponse" },
              },
            },
          },
          ...errorResponses(["VALIDATION_ERROR", "NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"]),
        },
      },
    },
```

And beside the existing `slugPath` entry, the same operation with `operationId: "listPublicResultsBySlug"` at `` [`${slugPath}/results`] ``.

Import the two constant tuples at the top of the file:

```ts
import { RESULT_BOARDS, RESULT_LEVELS } from "@/lib/constants";
```

Add to `components.schemas`:

```ts
    PublicResultsResponse: {
      type: "object",
      properties: {
        success: { type: "boolean", example: true },
        results: {
          type: "array",
          items: { $ref: "#/components/schemas/PublicResult" },
        },
      },
    },
    PublicResult: {
      type: "object",
      properties: {
        board: { type: "string", example: "CBSE" },
        boardLabel: { type: "string", example: "CBSE" },
        level: { type: "string", example: "CLASS_10" },
        stream: { type: "string", nullable: true, example: null },
        academicYear: { type: "string", example: "2025-26" },
        appeared: { type: "integer", example: 142 },
        passed: { type: "integer", example: 140 },
        passPercentage: { type: "number", nullable: true, example: 98.6 },
        averageScore: { type: "number", example: 82.4 },
        highestScore: { type: "number", example: 98.6 },
        bands: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", example: "90% and above" },
              minPercentage: { type: "number", example: 90 },
              maxPercentage: { type: "number", example: 100 },
              count: { type: "integer", example: 38 },
            },
          },
        },
        toppers: {
          type: "array",
          description: "Only toppers whose consent to publish the institution has confirmed.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", example: "Priya S" },
              percentage: { type: "number", example: 98.6 },
              rank: { type: "integer", example: 1 },
              note: { type: "string", example: "School topper" },
              photoUrl: { type: "string", example: "https://cdn.example/media/INS0001/results/…" },
            },
          },
        },
        publishedAt: { type: "string", format: "date-time" },
      },
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/unit/openapi-results.test.ts tests/unit/openapi-profile.test.ts tests/unit/api-contract.test.ts
```

Expected: PASS. `api-contract.test.ts` may assert a path or schema count — if it fails only on a count, update that count; it is a meta-test whose whole job is to notice this change.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/openapi.ts tests/unit/openapi-results.test.ts
git commit -m "feat: document the public results endpoints in the OpenAPI spec"
```

---

### Task 12: Results list page and navigation

**Files:**
- Create: `src/app/(dashboard)/results/page.tsx`
- Create: `src/app/(dashboard)/results/loading.tsx`
- Create: `src/components/results/results-list-view.tsx`
- Create: `src/components/results/result-status-badge.tsx`
- Create: `src/lib/results/label.ts`
- Modify: `src/components/dashboard/nav-config.ts`
- Test: `tests/unit/result-label.test.ts`

**Interfaces:**
- Consumes: `ResultService.list` (Task 5); `ResultDTO` (Task 5); `RESULT_*_LABELS` (Task 2).
- Produces: `describeCycle(result: { board: string; boardName?: string; level: string; stream?: string | null; academicYear: string; examLabel?: string }): string` — the one place a cycle's human label is built, shared by the list, the editor, and the publish dialog.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/result-label.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeCycle } from "@/lib/results/label";

describe("describeCycle", () => {
  it("names board, level and year", () => {
    expect(
      describeCycle({ board: "CBSE", level: "CLASS_10", stream: null, academicYear: "2025-26" }),
    ).toBe("CBSE · Class 10 · 2025-26");
  });

  it("includes the stream when there is one", () => {
    expect(
      describeCycle({
        board: "CBSE",
        level: "CLASS_12",
        stream: "SCIENCE",
        academicYear: "2025-26",
      }),
    ).toBe("CBSE · Class 12 · Science · 2025-26");
  });

  it("prefers boardName when the board does not name itself", () => {
    expect(
      describeCycle({
        board: "STATE_BOARD",
        boardName: "Karnataka State Board",
        level: "PUC_2",
        stream: null,
        academicYear: "2025-26",
      }),
    ).toBe("Karnataka State Board · PUC II · 2025-26");
  });

  it("uses examLabel verbatim when the institution supplied one", () => {
    expect(
      describeCycle({
        board: "CBSE",
        level: "CLASS_10",
        stream: null,
        academicYear: "2025-26",
        examLabel: "AISSE 2026",
      }),
    ).toBe("AISSE 2026");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/result-label.test.ts
```

Expected: FAIL — cannot resolve `@/lib/results/label`.

- [ ] **Step 3: Create `src/lib/results/label.ts`**

```ts
import {
  RESULT_BOARD_LABELS,
  RESULT_LEVEL_LABELS,
  RESULT_STREAM_LABELS,
  type ResultBoard,
  type ResultLevel,
  type ResultStream,
} from "@/lib/constants";

/**
 * The one place a cycle's human label is built. The list, the editor header and
 * the publish dialog all read from here, so a cycle never reads one way in the
 * table and another in the dialog that publishes it.
 */
export function describeCycle(result: {
  board: string;
  boardName?: string | null;
  level: string;
  stream?: string | null;
  academicYear: string;
  examLabel?: string | null;
}): string {
  const custom = result.examLabel?.trim();
  if (custom) return custom;

  const board =
    result.boardName?.trim() ||
    RESULT_BOARD_LABELS[result.board as ResultBoard] ||
    result.board;
  const level = RESULT_LEVEL_LABELS[result.level as ResultLevel] || result.level;
  const stream = result.stream
    ? RESULT_STREAM_LABELS[result.stream as ResultStream] || result.stream
    : null;

  return [board, level, stream, result.academicYear].filter(Boolean).join(" · ");
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/unit/result-label.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Create `src/components/results/result-status-badge.tsx`**

Follow the tone vocabulary already established in `src/components/shared/status-badge.tsx` — read that file first; this palette is monochrome and encodes state by fill weight, not hue.

```tsx
import { cn } from "@/lib/utils";
import { RESULT_STATUS_LABELS, type ResultStatus } from "@/lib/constants";

const TONE: Record<ResultStatus, string> = {
  DRAFT: "border-foreground/25 bg-background text-foreground",
  PUBLISHED: "border-transparent bg-foreground text-background",
  ARCHIVED: "border-dashed border-border bg-background text-muted-foreground",
};

export function ResultStatusBadge({ status }: { status: ResultStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE[status],
      )}
    >
      {RESULT_STATUS_LABELS[status]}
    </span>
  );
}
```

- [ ] **Step 6: Create `src/components/results/results-list-view.tsx`**

A server-rendered table. Read `src/components/shared/empty-state.tsx` for the empty-state component's props before using it.

```tsx
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { ResultStatusBadge } from "@/components/results/result-status-badge";
import { describeCycle } from "@/lib/results/label";
import type { ResultDTO } from "@/services/result.service";
import type { ResultStatus } from "@/lib/constants";

export function ResultsListView({ results }: { results: ResultDTO[] }) {
  return (
    <>
      <PageHeader
        title="Results"
        description="Exam-cycle results your website and partner sites read from the public API."
        actions={
          <Button asChild size="sm">
            <Link href="/results/new">
              <Plus className="size-4" />
              Add a result
            </Link>
          </Button>
        }
      />

      {results.length === 0 ? (
        <EmptyState
          title="No results yet"
          description="Publish an exam cycle and any website reading your public API picks it up."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Cycle</th>
                <th className="px-4 py-2 font-medium">Appeared</th>
                <th className="px-4 py-2 font-medium">Pass rate</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result) => (
                <tr key={result.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/results/${result.id}`} className="font-medium hover:underline">
                      {describeCycle(result)}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{result.appeared}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {result.passPercentage === null ? "—" : `${result.passPercentage}%`}
                  </td>
                  <td className="px-4 py-2.5">
                    <ResultStatusBadge status={result.status as ResultStatus} />
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

If `PageHeader` does not accept an `actions` prop, render the button above the table instead — read `src/components/shared/page-header.tsx` and match its actual signature rather than adapting the component.

- [ ] **Step 7: Create the page and its loading state**

`src/app/(dashboard)/results/page.tsx`:

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { ResultService } from "@/services/result.service";
import { ResultsListView } from "@/components/results/results-list-view";

export const metadata: Metadata = { title: "Results" };
export const dynamic = "force-dynamic";

/**
 * The institute admin owns this screen. The platform admin has no route here:
 * they provision institutions, they do not read institution results.
 */
export default async function ResultsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const results = await ResultService.list(institution.institutionId);

  return <ResultsListView results={results} />;
}
```

`src/app/(dashboard)/results/loading.tsx` — copy `src/app/(dashboard)/profile/loading.tsx` verbatim, changing only any title text it contains.

- [ ] **Step 8: Register the nav item**

In `src/components/dashboard/nav-config.ts`, add `GraduationCap` to the existing `lucide-react` import and add one item to the **first** group of `INSTITUTION_NAV` (tenant data, alongside Enquiries and Applications). Add nothing to `SUPER_ADMIN_NAV`.

```ts
  {
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/enquiries", label: "Enquiries", icon: Inbox, prefix: true },
      { href: "/applications", label: "Applications", icon: FileText, prefix: true },
      { href: "/results", label: "Results", icon: GraduationCap, prefix: true },
    ],
  },
```

- [ ] **Step 9: Verify and commit**

```bash
npx tsc --noEmit
npm test -- --run
git add src/lib/results/label.ts src/components/results "src/app/(dashboard)/results" src/components/dashboard/nav-config.ts tests/unit/result-label.test.ts
git commit -m "feat: add the results list page and navigation entry"
```

---

### Task 13: Results editor

The largest UI task. One page, three sections, mirroring the profile editor's composition: one card per section, one `react-hook-form` instance per section, one explicit save each.

**Files:**
- Create: `src/app/(dashboard)/results/[resultId]/page.tsx`
- Create: `src/app/(dashboard)/results/new/page.tsx`
- Create: `src/components/results/result-editor.tsx`
- Create: `src/components/results/cycle-section.tsx`
- Create: `src/components/results/outcome-section.tsx`
- Create: `src/components/results/toppers-section.tsx`
- Create: `src/components/results/band-editor.tsx`
- Test: `tests/unit/result-editor-logic.test.ts`

**Interfaces:**
- Consumes: `ResultDTO` (Task 5); `describeCycle` (Task 12); the routes from Tasks 8–9; `SectionForm` and `FieldGroup` from `src/components/profile/section-form.tsx` — read that file and reuse its exports rather than writing new wrappers.
- Produces:
  - `blockingPublishReasons(result: ResultDTO): string[]` in `src/lib/results/publish-readiness.ts` — the reasons the publish button is disabled, named rather than implied
  - the editor components

**Read first:** `src/components/profile/profile-editor.tsx` and `src/components/profile/sections/basic-section.tsx`. This editor follows their shape exactly — deviating creates two idioms for one job.

- [ ] **Step 1: Write the failing test**

The interesting logic is which reasons block publishing; the rendering is composition. Create `tests/unit/result-editor-logic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { blockingPublishReasons } from "@/lib/results/publish-readiness";

const ready = {
  id: "1",
  board: "CBSE",
  level: "CLASS_10",
  stream: null,
  academicYear: "2025-26",
  appeared: 142,
  passed: 140,
  passPercentage: 98.6,
  status: "DRAFT",
} as const;

describe("blockingPublishReasons", () => {
  it("returns nothing for a publishable cycle", () => {
    expect(blockingPublishReasons({ ...ready })).toEqual([]);
  });

  it("names an empty cohort", () => {
    const reasons = blockingPublishReasons({ ...ready, appeared: 0, passed: 0 });
    expect(reasons.join(" ")).toMatch(/appeared/i);
  });

  it("names every topper still missing consent", () => {
    const reasons = blockingPublishReasons({
      ...ready,
      toppers: [
        { id: "a", name: "Priya S", percentage: 98.6, consentAcknowledged: true },
        { id: "b", name: "Rahul K", percentage: 97.8, consentAcknowledged: false },
        { id: "c", name: "Meera N", percentage: 97.1, consentAcknowledged: false },
      ],
    });

    expect(reasons.join(" ")).toContain("Rahul K");
    expect(reasons.join(" ")).toContain("Meera N");
    expect(reasons.join(" ")).not.toContain("Priya S");
  });

  it("names a missing board name", () => {
    const reasons = blockingPublishReasons({ ...ready, board: "STATE_BOARD" });
    expect(reasons.join(" ")).toMatch(/board/i);
  });

  it("names more passes than appeared", () => {
    const reasons = blockingPublishReasons({ ...ready, appeared: 10, passed: 11 });
    expect(reasons.join(" ")).toMatch(/cannot exceed|more than/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/result-editor-logic.test.ts
```

Expected: FAIL — cannot resolve `@/lib/results/publish-readiness`.

- [ ] **Step 3: Create `src/lib/results/publish-readiness.ts`**

```ts
import { BOARD_NAME_REQUIRED, type ResultBoard } from "@/lib/constants";

type Readable = {
  board: string;
  boardName?: string | null;
  appeared: number;
  passed: number;
  toppers?: { name: string; consentAcknowledged: boolean }[];
};

/**
 * Why the publish button is disabled, in the institution's own words. The
 * server enforces these same rules in `assertPublishable`; this exists so the
 * UI can say WHICH rule is unmet instead of failing on submit.
 *
 * Deliberately mirrors the server's rules rather than replacing them — the
 * server remains the authority, and a disagreement shows up as a rejected
 * publish rather than a silently permitted one.
 */
export function blockingPublishReasons(result: Readable): string[] {
  const reasons: string[] = [];

  if (result.appeared <= 0) {
    reasons.push("Enter how many students appeared.");
  }

  if (result.passed > result.appeared) {
    reasons.push("The number who passed cannot exceed the number who appeared.");
  }

  if (BOARD_NAME_REQUIRED.has(result.board as ResultBoard) && !result.boardName?.trim()) {
    reasons.push("Name the board that awarded these results.");
  }

  const unconsented = (result.toppers ?? []).filter((topper) => !topper.consentAcknowledged);
  if (unconsented.length > 0) {
    reasons.push(
      `Confirm consent to publish for ${unconsented.map((topper) => topper.name).join(", ")}.`,
    );
  }

  return reasons;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/unit/result-editor-logic.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Build the three section components**

Each follows `src/components/profile/sections/basic-section.tsx` exactly: `"use client"`, one `useForm`, `SectionForm` wrapper, one `PATCH` on save.

**`cycle-section.tsx`** — fields: `board` (Select over `RESULT_BOARDS` with `RESULT_BOARD_LABELS`), `boardName` (Input, shown only when `BOARD_NAME_REQUIRED.has(board)`, and marked required there), `level` (Select), `stream` (Select with an explicit "Not applicable" option mapping to `null`), `academicYear` (Input, placeholder `2025-26`), `examLabel` (Input, helper text: "Overrides the generated label, e.g. AISSE 2026").

**`outcome-section.tsx`** — fields: `appeared`, `passed`, `averageScore`, `highestScore` (all `Input type="number"` registered with `{ setValueAs: asNumber }`, copying the `asNumber` helper from `src/components/profile/sections/address-section.tsx`), plus `<BandEditor />`. Above the save button, show the live pass rate so the number about to be published is never a surprise:

```tsx
<p className="text-xs text-muted-foreground">
  {appeared > 0
    ? `Pass rate: ${Math.round((passed / appeared) * 1000) / 10}%`
    : "Enter how many appeared to see the pass rate."}
</p>
```

**`toppers-section.tsx`** — a repeatable list via `useFieldArray`, each row carrying `name`, `percentage`, `rank`, `note`, a photo control, and the consent checkbox:

```tsx
<label className="flex items-start gap-2 text-xs">
  <input
    type="checkbox"
    className="mt-0.5"
    {...register(`toppers.${index}.consentAcknowledged`)}
  />
  <span>
    We hold this student&apos;s consent (or their guardian&apos;s) to publish their name,
    score and photograph.
  </span>
</label>
```

The photo control posts to `/api/settings/results/:resultId/toppers/:topperId/photo` — reuse `src/components/profile/media-upload.tsx`'s client-side size and type checks by importing `MAX_IMAGE_BYTES` from it rather than restating the limit. A topper that has not been saved yet has no `id`, so hide the photo control until the section has been saved once and show: "Save this section to add a photo."

- [ ] **Step 6: Build `band-editor.tsx`**

A `useFieldArray` over `bands` with `label`, `minPercentage`, `maxPercentage`, `count` per row, an "Add band" button capped at `RESULT_MAX_BANDS`, and a remove button per row. Below the rows, show the running total against `appeared` so an over-count is visible before saving:

```tsx
<p className="text-xs text-muted-foreground">
  {counted > appeared
    ? `These bands account for ${counted} students, more than the ${appeared} who appeared.`
    : `${counted} of ${appeared} students placed in a band.`}
</p>
```

Seed a new result's bands with the three canonical rows so the common case needs no typing:

```ts
const DEFAULT_BANDS = [
  { label: "90% and above", minPercentage: 90, maxPercentage: 100, count: 0 },
  { label: "75% to 89%", minPercentage: 75, maxPercentage: 89, count: 0 },
  { label: "60% to 74%", minPercentage: 60, maxPercentage: 74, count: 0 },
];
```

- [ ] **Step 7: Build `result-editor.tsx` and the two pages**

`result-editor.tsx` composes the three sections plus a publish control, mirroring `profile-editor.tsx`'s state handling: hold `result` in state, re-set it from each save's response, and warn before switching sections while a section is dirty.

The publish control renders `blockingPublishReasons(result)`; when the list is non-empty the button is disabled and every reason is listed beneath it. When empty, clicking opens a dialog naming exactly what becomes public — mirroring the profile publish dialog, which enumerates its public fields:

```tsx
<DialogDescription>
  Publishing {describeCycle(result)} makes these public to any website reading your API,
  with no login: the number who appeared and passed, the pass rate, your score bands, and
  the name, score and photo of every topper whose consent you have confirmed.
</DialogDescription>
```

`src/app/(dashboard)/results/[resultId]/page.tsx` resolves the result server-side through `ResultService.get` — guarding `SUPER_ADMIN` and a missing institution exactly as the list page does — and renders `<ResultEditor initialResult={result} />`. A `notFound()` from the service must render Next's 404, not a 500:

```tsx
import { notFound } from "next/navigation";
// …
let result;
try {
  result = await ResultService.get(institution.institutionId, resultId);
} catch {
  notFound();
}
```

`src/app/(dashboard)/results/new/page.tsx` renders the cycle section alone; on successful `POST` it redirects to `/results/<newId>` where the outcome and topper sections become available. Splitting it this way means a topper photo always has a `resultId` to attach to.

- [ ] **Step 8: Verify the whole flow by hand**

Start the dev server, sign in as the seeded INS0001 admin, and walk it:

```bash
npm run dev
```

1. `/results` → "Add a result" → create a CBSE / Class 10 / 2025-26 cycle
2. Enter 142 appeared, 140 passed → confirm the live pass rate reads 98.6%
3. Add two toppers, tick consent on only one → confirm publish is disabled and names the other
4. Tick the second → publish
5. `curl http://localhost:3000/api/public/INS0001/results` → confirm both toppers present, no `consentAcknowledged`, no `_id`
6. Untick one topper's consent, save, re-`curl` → confirm that topper is gone while the cycle stays published

- [ ] **Step 9: Verify and commit**

```bash
npx tsc --noEmit
npm run lint
npm test -- --run
git add src/lib/results/publish-readiness.ts src/components/results "src/app/(dashboard)/results" tests/unit/result-editor-logic.test.ts
git commit -m "feat: add the results editor with band, topper and publish controls"
```

---

### Task 14: Seed data and documentation

**Files:**
- Modify: `scripts/seed.ts`
- Modify: `README.md`
- Modify: `docs/architecture/institution-master-identity.md`
- Test: existing suite

**Interfaces:**
- Consumes: `Result` model (Task 2).
- Produces: two seeded published cycles on INS0001 so the public API returns something real on a fresh database.

- [ ] **Step 1: Seed two cycles for INS0001**

In `scripts/seed.ts`, after the institution and user blocks, add an `ensureResult` helper following the file's existing `ensureUser` / `ensureApiClient` idempotent shape (find-or-create, log a line), and call it twice:

```ts
await ensureResult({
  institutionId: "INS0001",
  board: "CBSE",
  level: "CLASS_10",
  stream: null,
  academicYear: "2025-26",
  appeared: 142,
  passed: 142,
  averageScore: 82.4,
  highestScore: 98.6,
  bands: [
    { label: "90% and above", minPercentage: 90, maxPercentage: 100, count: 38 },
    { label: "75% to 89%", minPercentage: 75, maxPercentage: 89, count: 67 },
    { label: "60% to 74%", minPercentage: 60, maxPercentage: 74, count: 31 },
  ],
  toppers: [
    { name: "Priya Sharma", percentage: 98.6, rank: 1, note: "School topper", consentAcknowledged: true },
    { name: "Rahul Kumar", percentage: 97.8, rank: 2, consentAcknowledged: true },
  ],
  status: "PUBLISHED",
  publishedAt: new Date("2026-05-12T00:00:00.000Z"),
});

await ensureResult({
  institutionId: "INS0001",
  board: "CBSE",
  level: "CLASS_12",
  stream: "SCIENCE",
  academicYear: "2025-26",
  appeared: 96,
  passed: 95,
  averageScore: 79.8,
  highestScore: 97.2,
  bands: [
    { label: "90% and above", minPercentage: 90, maxPercentage: 100, count: 21 },
    { label: "75% to 89%", minPercentage: 75, maxPercentage: 89, count: 44 },
  ],
  toppers: [
    { name: "Ananya Rao", percentage: 97.2, rank: 1, note: "School topper", consentAcknowledged: true },
  ],
  status: "PUBLISHED",
  publishedAt: new Date("2026-05-20T00:00:00.000Z"),
});
```

Seed one topper on the Class 10 cycle **without** consent as well, so a fresh database demonstrates the consent filter rather than only describing it:

```ts
  // Deliberately unconsented: proves the public API omits them.
  { name: "Vikram Nair", percentage: 96.4, rank: 3, consentAcknowledged: false },
```

- [ ] **Step 2: Verify the seed**

```bash
npm run seed
curl -s http://localhost:3000/api/public/INS0001/results | head -40
```

Expected: two cycles, Priya and Rahul present, **Vikram absent**.

- [ ] **Step 3: Document the module**

In `README.md`, add a "Results" subsection beneath the existing institution-profile API documentation, naming both public endpoints, their filters, the five-minute cache, and the consent rule — stating plainly that a topper appears only where the institution has confirmed consent, and that withdrawing consent removes them on the next read.

In `docs/architecture/institution-master-identity.md`, extend the module diagram so `Results` sits beside `Profile` and `Lead Network` under the same master identity, and note that results are a separate collection keyed by `institutionId` rather than an embedded block — with the reason (independent publish lifecycle, unbounded growth, cross-institution querying later).

- [ ] **Step 4: Final verification**

```bash
npx tsc --noEmit
npm run lint
npm test -- --run
```

Expected: typecheck clean, lint clean, all tests green — the 297 pre-existing plus roughly 100 new.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed.ts README.md docs/architecture/institution-master-identity.md
git commit -m "feat: seed published result cycles and document the results module"
```

---

## Plan self-review

Run against the spec after writing; findings recorded here rather than silently fixed.

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| §4.1–4.2 cycle identity, aggregates | 2 |
| §4.3 bands | 2, 3, 13 |
| §4.4 toppers | 2, 3, 7, 13 |
| §4.5 lifecycle, ARCHIVED vs delete | 2, 6 |
| §4.6 constants | 2 |
| §4.7 indexes (incl. reserved discovery index) | 2 |
| §5 validation, publish gate | 3 |
| §6.1 institute-admin API | 8, 9 |
| §6.2 platform admin gets nothing | 8 (test), 12 (nav) |
| §6.3 public API | 10 |
| §6.4 OpenAPI | 11 |
| §7 authorization | 5 (service scoping), 8 (route tests) |
| §8 projection | 4 |
| §9 topper photo storage | 1, 7 |
| §10 dashboard | 12, 13 |
| §11 future extensibility | 2 (reserved index) |
| §12 migration — none | no task needed; nothing to migrate |
| §13 testing | every task |
| §14 definition of done | 14 |

**Three findings, fixed inline while writing:**

1. `validateImage` and `isOwnedMediaUrl` were module-private inside `institution.service.ts`. Tasks 7 and 9 need both. Rather than duplicating them — which would have left two copies of a security guard to drift apart — Task 1 was added to extract them first, as a pure refactor gated on the 297 existing tests staying green.

2. The spec says `photoUrl` is set by the upload endpoint, but did not say it must be *rejected* elsewhere. Left implicit, an implementer would naturally accept it in the patch schema, which re-creates exactly the attacker-controlled-media-URL shape behind Phase 1's Critical finding. Task 3 now excludes it from both schemas and tests that exclusion, and it is stated in the Global Constraints.

3. `status` in the patch schema had the same problem: accepting it would let a `PATCH` move a cycle to `PUBLISHED` and bypass the consent gate entirely. `updateResultSchema` now omits it, with a test.

**Three further corrections, made by checking the real signatures rather than trusting memory:**

4. `PageHeader` takes `actions`, not `action` — Task 12 corrected.
5. `buildOpenApiDocument` requires an options object carrying `origin`; a bare call does not compile. Task 11 corrected to match `tests/unit/openapi-profile.test.ts`.
6. `EmptyState` accepts `actionLabel` / `actionHref` rather than arbitrary children — Task 12 uses only `title` and `description`, which is valid.

**Type consistency** — checked across tasks: `ResultDTO.id` (string, serialised from `_id`) is used consistently by Tasks 5–13; `PublicResult` is the projection's output type used by Tasks 4 and 10; `describeCycle` has one signature, used by Tasks 12 and 13; `assertResultInvariants` / `assertPublishable` take the same `ResultInvariantInput` in Tasks 3, 5 and 6; `setStatus`'s action union `"publish" | "unpublish" | "archive"` matches the route's `ACTIONS` tuple in Task 8.
