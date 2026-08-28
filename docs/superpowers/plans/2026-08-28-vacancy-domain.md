# Vacancy Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an institution a place to post and manage teacher openings, so a later plan can syndicate them to eduFleet Exchange.

**Architecture:** A per-institution `Vacancy` collection following the `Result`/`Achievement` precedent — a string tenant key, not an ObjectId ref. Its vocabularies are eduFleet's, transcribed into IDAP's constants with a parity test rather than fetched, so creating a vacancy never depends on eduFleet being reachable. This plan builds a standalone vacancy tracker; **the `listing` block, the adapter and every push belong to Plan B** and appear in no task here.

**Tech Stack:** Next.js 16 App Router, Mongoose 8, Zod 4, TypeScript, Vitest 3, react-hook-form, Radix/shadcn, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-28-edufleet-vacancies-design.md`

**Reconnaissance source (binding for vocabulary parity):** `docs/integrations/edufleet-api-map.md` (2026-08-28). Where this plan and that map disagree about eduFleet's vocabularies, **the map wins** — report the disagreement rather than silently following either. eduFleet's repo at `/Users/automicai/edufleet-exchange` is **READ-ONLY**: never edit, commit, lint, or run anything in it.

## Global Constraints

Every task's requirements implicitly include these.

- **Tenant scoping is absolute.** Every read and write is `institutionId`-scoped. Mutation-check every new service method: remove its `institutionId`, confirm exactly its test fails, restore, verify by `grep`. Assert the *other* institution's record is unchanged — not merely that an error was thrown, because a correctly-scoped query that finds nothing throws the same error as a broken filter.
- **The three-state patch contract.** Absent = leave alone, a value = `$set`, explicit `null` = clear (`$unset`). Applies to any type, not only text.
- **Guard optional numerics with `!= null`, never `?? 0`** — `salaryMin: 0` is meaningful.
- **Services do NOT parse.** Routes parse (`src/app/api/settings/results/route.ts:24`) and services are typed with `z.infer<>` (`result.service.ts:19-20`). An allow-list in the service is defence in depth, never a substitute.
- `npx tsc --noEmit` → 0 errors. `npx eslint src` → **exactly 0 errors / 7 warnings**. Run eslint yourself and report the count.
- Full suite green. **Baseline at plan start: 1445 tests / 117 files.**
- Test factories are positional: `makeInstitution(institutionId, overrides)` from `tests/helpers/factories.ts`; it spreads overrides into `Institution.create`.
- **Integration tests need the database lifecycle hooks** — `clearDatabase`, `startTestDatabase`, `stopTestDatabase` from `../helpers/db`, wired via `beforeAll`/`afterAll`/`beforeEach` as `tests/integration/achievement-service.test.ts` does. Without them a model call hangs until a 10s "buffering timed out" error that reads like a code bug and is not one.
- **No `git checkout`, `git switch`, `git worktree add`, or `git stash`** — shared working directory. A stash has already silently reverted work once here.
- **Restore verification:** `git diff --quiet` is not valid, and neither is a plain `git diff` on a file that is **untracked** at mutation time — git does not show untracked files, so an empty result is guaranteed regardless of contents. Use `grep` or a scratchpad copy.
- `rate-limit`, `token-endpoints`, `tenant-isolation` and several showcase integration files flake under full-suite load via `mongodb-memory-server` port collisions (signature `ECONNREFUSED 127.0.0.1:27017`). Re-run in isolation before attributing anything.
- **A test must FAIL when the behaviour it guards is removed**, and a mutation check is only valid if the mutated line lies on the path the assertion actually executes. Twelve confounded tests have been found on this project. If a mutation does not fail the test you expected, report it rather than reshaping the test.
- Never kill a dev server by name or pattern; find the PID with `lsof -nP -iTCP:3000 -sTCP:LISTEN -t`, confirm its cwd, kill by PID.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/constants.ts` | `VACANCY_SUBJECTS`, `VACANCY_BENEFITS`, `VACANCY_STATUSES` and their label maps. |
| `src/lib/validation/vacancy.ts` (new) | Zod create/patch schemas. |
| `src/models/Vacancy.ts` (new) | The collection. |
| `src/services/vacancy.service.ts` (new) | Tenant-scoped CRUD and status transitions. |
| `src/app/api/settings/vacancies/**` (new) | Routes the dashboard calls. |
| `src/components/profile/sections/vacancies-section.tsx` (new) | Dashboard UI. |
| `src/components/profile/profile-editor.tsx` | Registers the section. |

---

### Task 1: Vocabularies and validation schemas

**Files:**
- Modify: `src/lib/constants.ts`
- Create: `src/lib/validation/vacancy.ts`
- Test: `tests/unit/vacancy-validation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VACANCY_SUBJECTS`, `VACANCY_BENEFITS`, `VACANCY_STATUSES`, `VacancySubject`, `VacancyBenefit`, `VacancyStatus`, `vacancyCreateSchema`, `vacancyPatchSchema`. Tasks 2-5 consume these.

Add to `src/lib/constants.ts`:

```ts
/**
 * eduFleet's 16 job subjects, transcribed from
 * /Users/automicai/edufleet-exchange/web/src/lib/taxonomy.ts (JOB_CATEGORIES).
 * eduFleet matches these by EXACT string, not fuzzily, so the literal spelling
 * is the contract. Transcribed rather than fetched so creating a vacancy never
 * depends on eduFleet being reachable.
 */
export const VACANCY_SUBJECTS = [
  "Mathematics", "Physics", "Chemistry", "Biology",
  "English", "Kannada", "Hindi", "Social Science",
  "Principal", "Vice Principal", "Coordinator", "Administrator",
  "Accountant", "Clerk", "Driver", "Librarian",
] as const;
export type VacancySubject = (typeof VACANCY_SUBJECTS)[number];

/** eduFleet's subject groups, for grouping the picker. Same source file. */
export const VACANCY_SUBJECT_GROUPS: Array<{ group: string; subjects: VacancySubject[] }> = [
  { group: "Academic", subjects: ["Mathematics", "Physics", "Chemistry", "Biology", "English", "Kannada", "Hindi", "Social Science"] },
  { group: "Administration", subjects: ["Principal", "Vice Principal", "Coordinator", "Administrator"] },
  { group: "Support", subjects: ["Accountant", "Clerk", "Driver", "Librarian"] },
];

/**
 * eduFleet's 11 employee benefits, transcribed from
 * /Users/automicai/edufleet-exchange/web/src/lib/job-facilities.ts.
 * Sent as literal label strings, not codes.
 *
 * eduFleet's sanitizeFacilities() SILENTLY DISCARDS anything not on this list
 * — it is not a validation error and eduFleet never reports it. IDAP therefore
 * validates against this list before any push (spec §5.1).
 */
export const VACANCY_BENEFITS = [
  "Provident Fund (PF)", "ESI (medical insurance)", "Gratuity", "Health insurance",
  "Staff accommodation", "Transport / bus facility", "Free / subsidised meals",
  "Paid leave", "Annual / festival bonus", "Training & development",
  "Maternity benefits",
] as const;
export type VacancyBenefit = (typeof VACANCY_BENEFITS)[number];

/** DRAFT is never pushed to eduFleet. */
export const VACANCY_STATUSES = ["DRAFT", "OPEN", "FILLED", "CLOSED"] as const;
export type VacancyStatus = (typeof VACANCY_STATUSES)[number];

export const VACANCY_TITLE_MAX = 120;
export const VACANCY_DESCRIPTION_MAX = 2000;
```

- [ ] **Step 1: Write the failing tests**

Cover, each as its own named test:

- `VACANCY_SUBJECTS` equals a **transcribed literal array** of all 16 names in source order, with a comment citing eduFleet's `taxonomy.ts`. **Do not read that repository at runtime** — it is a sibling checkout absent on CI, so a runtime read errors on a missing path rather than comparing, which is a broken test wearing a passing test's clothes.
- `VACANCY_SUBJECT_GROUPS` partitions all 16 subjects exactly once, with group sizes `[8, 4, 4]`. Assert `flatMap(...)` equals `VACANCY_SUBJECTS` **only if you also assert the literal 16-name list separately** — otherwise the partition test compares a derivation against its own source and cannot fail.
- `VACANCY_BENEFITS` equals a transcribed literal array of all 11 labels.
- `vacancyCreateSchema` requires `title`, `subject`, `description`; rejects a title over 120, a description over 2000, an unknown subject, and an unknown benefit.
- `vacancyCreateSchema` rejects `salaryMin` greater than `salaryMax`, and accepts either alone.
- `vacancyCreateSchema` accepts `salaryMin: 0` — a zero salary is a value, not an absence.
- `vacancyPatchSchema` makes every field optional, and `salaryMin`, `salaryMax`, `experienceRequired` are **nullable**: `{salaryMin: null}` parses to `null` while omitting the key parses to `undefined`, and the two are distinguishable after parsing.

```ts
// tests/unit/vacancy-validation.test.ts
import { describe, it, expect } from "vitest";
import { VACANCY_SUBJECTS, VACANCY_BENEFITS, VACANCY_SUBJECT_GROUPS } from "@/lib/constants";
import { vacancyCreateSchema, vacancyPatchSchema } from "@/lib/validation/vacancy";

describe("vacancy vocabularies", () => {
  // Transcribed from eduFleet's web/src/lib/taxonomy.ts (JOB_CATEGORIES), in
  // source order. Not read at runtime: that repo is a sibling checkout absent
  // on CI, so a runtime read would error rather than compare.
  it("matches eduFleet's 16 job subjects verbatim, in source order", () => {
    expect(VACANCY_SUBJECTS).toEqual([
      "Mathematics", "Physics", "Chemistry", "Biology",
      "English", "Kannada", "Hindi", "Social Science",
      "Principal", "Vice Principal", "Coordinator", "Administrator",
      "Accountant", "Clerk", "Driver", "Librarian",
    ]);
  });

  it("partitions every subject into exactly one group", () => {
    const grouped = VACANCY_SUBJECT_GROUPS.flatMap((g) => g.subjects);
    expect(grouped).toEqual([...VACANCY_SUBJECTS]);
    expect(VACANCY_SUBJECT_GROUPS.map((g) => g.subjects.length)).toEqual([8, 4, 4]);
  });

  it("matches eduFleet's 11 benefit labels verbatim", () => {
    expect(VACANCY_BENEFITS).toEqual([
      "Provident Fund (PF)", "ESI (medical insurance)", "Gratuity", "Health insurance",
      "Staff accommodation", "Transport / bus facility", "Free / subsidised meals",
      "Paid leave", "Annual / festival bonus", "Training & development",
      "Maternity benefits",
    ]);
  });
});

describe("vacancyCreateSchema", () => {
  const valid = { title: "Maths Teacher", subject: "Mathematics", description: "Teach CBSE Grade 8-10." };

  it("accepts a minimal valid vacancy", () => {
    expect(vacancyCreateSchema.parse(valid).title).toBe("Maths Teacher");
  });

  it("rejects an unknown subject", () => {
    expect(() => vacancyCreateSchema.parse({ ...valid, subject: "Astrology" })).toThrow(/subject/i);
  });

  it("rejects an unknown benefit", () => {
    expect(() => vacancyCreateSchema.parse({ ...valid, facilities: ["Free chai"] })).toThrow(/facilit/i);
  });

  it("rejects salaryMin greater than salaryMax", () => {
    expect(() => vacancyCreateSchema.parse({ ...valid, salaryMin: 50000, salaryMax: 30000 })).toThrow(/salary/i);
  });

  it("accepts a zero salaryMin as a real value", () => {
    expect(vacancyCreateSchema.parse({ ...valid, salaryMin: 0 }).salaryMin).toBe(0);
  });
});

describe("vacancyPatchSchema", () => {
  it("distinguishes an explicit null from an absent key on salaryMin", () => {
    expect(vacancyPatchSchema.parse({ salaryMin: null }).salaryMin).toBeNull();
    expect(vacancyPatchSchema.parse({}).salaryMin).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/vacancy-validation.test.ts`
Expected: FAIL — `vacancyCreateSchema` does not exist.

- [ ] **Step 3: Implement**

Add the constants above, then create `src/lib/validation/vacancy.ts`:

```ts
import { z } from "zod";
import {
  VACANCY_BENEFITS,
  VACANCY_DESCRIPTION_MAX,
  VACANCY_STATUSES,
  VACANCY_SUBJECTS,
  VACANCY_TITLE_MAX,
} from "@/lib/constants";
import { requiredText, optionalText } from "./common";

/** Monthly rupees. `.nullable()` only on the patch — at create there is no
 *  prior value to clear. */
const salary = z.number().int().min(0).max(10_000_000);

const vacancyFields = {
  title: requiredText("Title", VACANCY_TITLE_MAX),
  subject: z.enum(VACANCY_SUBJECTS),
  description: requiredText("Description", VACANCY_DESCRIPTION_MAX),
  salaryMin: salary.optional(),
  salaryMax: salary.optional(),
  experienceRequired: z.number().int().min(0).max(60).optional(),
  facilities: z.array(z.enum(VACANCY_BENEFITS)).max(VACANCY_BENEFITS.length).optional(),
};

/** salaryMin ≤ salaryMax when both are present — eduFleet enforces the same
 *  rule server-side (`assertValidNumbers`), so rejecting it here turns a remote
 *  400 into a form error the school can act on. */
const salaryOrder = (v: { salaryMin?: number | null; salaryMax?: number | null }) =>
  v.salaryMin == null || v.salaryMax == null || v.salaryMin <= v.salaryMax;
const salaryOrderMessage = { message: "salary: the minimum may not exceed the maximum", path: ["salaryMin"] };

export const vacancyCreateSchema = z.object(vacancyFields).refine(salaryOrder, salaryOrderMessage);

export const vacancyPatchSchema = z
  .object({
    title: requiredText("Title", VACANCY_TITLE_MAX).optional(),
    subject: z.enum(VACANCY_SUBJECTS).optional(),
    description: requiredText("Description", VACANCY_DESCRIPTION_MAX).optional(),
    salaryMin: salary.optional().nullable(),
    salaryMax: salary.optional().nullable(),
    experienceRequired: z.number().int().min(0).max(60).optional().nullable(),
    facilities: z.array(z.enum(VACANCY_BENEFITS)).max(VACANCY_BENEFITS.length).optional(),
    status: z.enum(VACANCY_STATUSES).optional(),
  })
  .refine(salaryOrder, salaryOrderMessage);

export type VacancyCreateInput = z.infer<typeof vacancyCreateSchema>;
export type VacancyPatchInput = z.infer<typeof vacancyPatchSchema>;
```

Note `.optional().nullable()`, not bare `.nullable()`: a bare `.nullable()` on a Zod field **rejects an absent key**, which would silently break "every patch field is optional" for every route caller while the null test still passed.

`facilities` is **not** nullable — `[]` already expresses "none", so the three-state problem does not arise. `title`, `subject`, `description` and `status` are not nullable either: required fields and a status enum have no "no value" state to reach.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/vacancy-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

(a) Widen `subject: z.enum(VACANCY_SUBJECTS)` to `z.string()` → the unknown-subject test fails.
(b) Drop `.nullable()` from `salaryMin` on the patch → the null-versus-absent test fails.
(c) Remove the `salaryOrder` refine from the create schema → the min-greater-than-max test fails.

Restore each, verify by `grep`, report all three failure messages.

- [ ] **Step 6: Commit**

```bash
git add src/lib/constants.ts src/lib/validation/vacancy.ts tests/unit/vacancy-validation.test.ts
git commit -m "feat: add vacancy vocabularies and validation schemas"
```

---

### Task 2: The Vacancy model

**Files:**
- Create: `src/models/Vacancy.ts`
- Modify: `src/models/index.ts` (export it)
- Test: `tests/unit/vacancy-model.test.ts`

**Interfaces:**
- Consumes: Task 1's constants.
- Produces: the `Vacancy` model and `VacancyDoc`. Tasks 3-5 consume them.

Follow `src/models/Result.ts`'s pattern: `institutionId: { type: String, required: true, index: true }` — a string tenant key, **not** an ObjectId ref, because that is how every per-institution collection in this repo is keyed.

**Do not put Mongoose's `uppercase: true` or `lowercase: true` on any string field.** `Institution.ts` carried `uppercase: true` on its facility `code` — a write-time setter that silently rewrote every value the application layer produced and made a whole vocabulary unwritable through the model. It was removed earlier this year. Enum validation is validation; a case setter is silent data rewriting.

**The `listing` block from spec §7 is NOT part of this task.** It is connector state and belongs to Plan B.

```
institutionId       String, required, indexed
title               String, required, trim
subject             VACANCY_SUBJECTS, required
description         String, required, trim
salaryMin           Number, min 0
salaryMax           Number, min 0
experienceRequired  Number, min 0
facilities          [String]
status              VACANCY_STATUSES, default "DRAFT"
```

Indexes: `{institutionId: 1, createdAt: -1}` and `{institutionId: 1, status: 1}`.

- [ ] **Step 1: Write the failing tests**

Cover: `institutionId`, `title`, `subject`, `description` each rejected when absent; an unknown `subject` rejected; `status` defaults to `"DRAFT"`; both compound indexes exist.

```ts
// tests/unit/vacancy-model.test.ts
import { describe, it, expect } from "vitest";
import { Vacancy } from "@/models";
import { VACANCY_STATUSES } from "@/lib/constants";

const base = {
  institutionId: "INS0001",
  title: "Maths Teacher",
  subject: "Mathematics",
  description: "Teach CBSE Grade 8-10.",
};

describe("Vacancy model", () => {
  it("defaults status to DRAFT, and the default is a legal status", () => {
    const doc = new Vacancy(base);
    expect(doc.status).toBe("DRAFT");
    expect(VACANCY_STATUSES).toContain(doc.status);
  });

  it("requires institutionId", () => {
    const err = new Vacancy({ ...base, institutionId: undefined }).validateSync();
    expect(err?.errors.institutionId).toBeDefined();
  });

  it("rejects an unknown subject", () => {
    const err = new Vacancy({ ...base, subject: "Astrology" }).validateSync();
    expect(err?.errors.subject).toBeDefined();
  });

  it("declares both compound indexes", () => {
    const fields = Vacancy.schema.indexes().map(([f]) => f);
    const byCreatedAt = fields.find((f) => f.institutionId === 1 && f.createdAt === -1 && !("status" in f));
    const byStatus = fields.find((f) => f.institutionId === 1 && f.status === 1);
    expect(byCreatedAt).toBeDefined();
    expect(byStatus).toBeDefined();
  });
});
```

The `!("status" in f)` clause on the first predicate is deliberate: without it a single merged index would satisfy both `.find()` calls and the test would pass vacuously.

Note `Vacancy.schema.indexes()` also reflects the index Mongoose adds implicitly from `index: true` on `institutionId`, so expect three entries, not two.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/vacancy-model.test.ts`
Expected: FAIL — `Vacancy` is not exported from `@/models`.

- [ ] **Step 3: Implement**

```ts
// src/models/Vacancy.ts
import { type InferSchemaType, type Model, Schema, type Types, model, models } from "mongoose";
import { VACANCY_STATUSES, VACANCY_SUBJECTS } from "@/lib/constants";

const VacancySchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    subject: { type: String, required: true, enum: VACANCY_SUBJECTS },
    description: { type: String, required: true, trim: true },
    salaryMin: { type: Number, min: 0 },
    salaryMax: { type: Number, min: 0 },
    experienceRequired: { type: Number, min: 0 },
    facilities: { type: [String], default: undefined },
    status: { type: String, enum: VACANCY_STATUSES, default: "DRAFT" },
  },
  { timestamps: true },
);

VacancySchema.index({ institutionId: 1, createdAt: -1 });
VacancySchema.index({ institutionId: 1, status: 1 });

export type VacancyDoc = InferSchemaType<typeof VacancySchema> & { _id: Types.ObjectId };

export const Vacancy: Model<VacancyDoc> =
  (models.Vacancy as Model<VacancyDoc>) ?? model<VacancyDoc>("Vacancy", VacancySchema);
```

Export it from `src/models/index.ts` alongside the others.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/vacancy-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

(a) Remove the `{institutionId: 1, createdAt: -1}` index → the index test fails.
(b) Remove `required: true` from `institutionId` → the required test fails.

Restore each, verify by `grep`, report both messages.

- [ ] **Step 6: Commit**

```bash
git add src/models/Vacancy.ts src/models/index.ts tests/unit/vacancy-model.test.ts
git commit -m "feat: add the Vacancy model"
```

---

### Task 3: The vacancy service

**Files:**
- Create: `src/services/vacancy.service.ts`
- Test: `tests/integration/vacancy-service.test.ts`

**Interfaces:**
- Consumes: Task 1's schemas (as `z.infer<>` types only — the service does not parse), Task 2's model.
- Produces: `VacancyService` with `list(institutionId)`, `create(institutionId, input, actor)`, `update(institutionId, vacancyId, patch, actor)`, `remove(institutionId, vacancyId, actor)`, all returning `VacancyDTO` / `VacancyDTO[]` / `void`. Tasks 4-5 consume them.

**Read `src/services/achievement.service.ts` first and mirror it.** It is the closest precedent and has been through review; the notes below are the things it was corrected on.

`ActivityService.record` takes one object — verified at `src/services/result.service.ts:379-388`: `{ institutionId, entityType, entityId, entityRef, action, description?, performedBy, performedByName }`. `entityType` is a free string on the model, so `"VACANCY"` needs no new constant. `performedBy` takes `actor.id`, `performedByName` takes `actor.name`.

**The three-state patch.** Clearable fields are exactly `salaryMin`, `salaryMax`, `experienceRequired`. Absent leaves the stored value; a value `$set`s it; explicit `null` `$unset`s it. Follow `buildProfileUpdate` in `src/services/institution.service.ts` (`if (value === null) unset[path] = ""; else set[path] = value;`). `facilities` is not clearable — `[]` already expresses "none".

**Add a `PATCHABLE_FIELDS` allow-list** matching `vacancyPatchSchema`'s keys **exactly** — `title`, `subject`, `description`, `salaryMin`, `salaryMax`, `experienceRequired`, `facilities`, `status`. An allow-list that silently omits one is a bug in the opposite direction: `status` in particular is legitimately patchable and its absence would make every status transition a silent no-op. Verify by direct comparison against the schema, and ignore anything outside it. `institutionId` is a Mongoose schema path, so strict mode would **not** strip it from a patch; the only other thing standing between a client and a tenant escalation is Task 4's route remembering to `.parse`. This is defence in depth, not a replacement.

- [ ] **Step 1: Write the failing tests**

Cover: create/list/update/remove round-trips; `list` returns newest first; `remove` on another institution's id throws `NOT_FOUND`; the three states for each of the three clearable fields; an Activity row is written on create and on remove, scoped to the right `institutionId` and `entityType`; the allow-list ignores an `institutionId` key in a patch.

**Tenant isolation, one test per method** (`list`, `create`, `update`, `remove`). Each must assert the other institution's record is **byte-for-byte unchanged** after the cross-tenant call — read it before, read it after, `expect(after).toEqual(before)` on the raw `.lean()` document. Asserting only that the call threw proves nothing: a correctly-scoped query that finds no document throws the same `NOT_FOUND` as a broken filter.

For `create`, the isolation test must catch a **different but valid** institutionId, not merely a missing one. Create for `INS0002` and assert the raw document's `institutionId` is `"INS0002"`. Removing `institutionId` from `create` only proves the field is required; it does not prove the service writes the *correct* tenant's id, and a `create` that hardcoded a wrong-but-valid id would pass that weaker check.

Assert the null case with `expect(raw).not.toHaveProperty("salaryMin")` against `Vacancy.findById().lean()` — the raw stored document, not a serialised DTO which might drop nulls on its own and pass vacuously.

- [ ] **Step 2: Run to verify they fail. Step 3: Implement. Step 4: Run to verify they pass.**

- [ ] **Step 5: Mutation-check tenant scoping on all four methods**

Remove `institutionId` from each method's filter in turn. Confirm exactly that method's isolation test fails. **Enumerate every place `institutionId` appears in a query or write filter in your file** and confirm each has a test that fails when it is deleted — including any second filter in a branch you might not think of. The sibling service shipped with an untested filter in `update`'s empty-patch branch: deleting it left all tests green while one institution could read another's record in full, reachable because an all-optional patch schema means `{}` parses.

Restore each, verify by `grep`, report all failure messages and the filter enumeration.

- [ ] **Step 6: Commit**

```bash
git add src/services/vacancy.service.ts tests/integration/vacancy-service.test.ts
git commit -m "feat: add the vacancy service"
```

---

### Task 4: Vacancy routes

**Files:**
- Create: `src/app/api/settings/vacancies/route.ts`, `src/app/api/settings/vacancies/[vacancyId]/route.ts`
- Test: `tests/integration/vacancy-routes.test.ts`

**Interfaces:**
- Consumes: Task 3's `VacancyService`.
- Produces: the endpoints Task 5's UI calls.

**Read `src/app/api/settings/achievements/route.ts` and its `[achievementId]` sibling first and follow them exactly.** The house pattern is `assertSameOrigin(request)` from `@/lib/api/csrf` → `const { user, institution } = await requireInstitution()` from `@/lib/tenant` → `.parse` → service → `jsonSuccess`/`handleApiError` from `@/lib/api/response`.

`requireInstitution()` is **`INSTITUTION_ADMIN`-only** — it throws `forbidden` for `SUPER_ADMIN`, `COUNSELOR` and `FRONT_DESK` through the same branch, so one 403 test with a `SUPER_ADMIN` session covers every non-admin role. `tests/integration/results-routes.test.ts` shows the convention.

**The route MUST call `.parse`.** The service's allow-list is defence in depth, not a substitute.

**Pin the parse with a field the service does not independently neutralise.** Do **not** use `institutionId`: `create` re-assigns it after the input spread, so removing the parse does not fail an institutionId test — that test guards the service, not the route.

**Do not use `status` either**, for the same reason, unless you have checked. If Task 3's `create` mirrors `achievement.service.ts` literally it will write `{ ...input, institutionId, status: "DRAFT" }` — re-assigning `status` *after* the spread, which neutralises a smuggled status independently of the parse and makes a status-based pin confounded exactly as an institutionId one would be.

Use **`_id`**: a real Mongoose path, so `strict` will not drop it, and nothing re-assigns it. Read Task 3's `create` before writing the test and state in your report which fields it re-assigns after the spread — that list is precisely the set of fields that cannot pin the parse.

- [ ] **Step 1: Write the failing tests**

- Happy path per route; unknown id 404s.
- **Per mutating route, a cross-origin request is refused 403 AND changes nothing** — assert the record count and contents, not merely the status code. A route that wrote before asserting origin would pass a status-only check, so `assertSameOrigin` must be the first statement in every mutating handler, before any parsing or I/O.
- A POST body carrying `_id` creates a vacancy with a **server-generated** id — assert the raw stored document. This is the test that pins the route's `.parse`; verify by mutation that it fails when the parse is removed.
- A POST body carrying `status: "OPEN"` still creates a `DRAFT` vacancy. Keep this test — the behaviour matters — but do **not** treat it as pinning the parse if Task 3's `create` re-assigns `status` after the spread.
- A POST body carrying another institution's `institutionId` creates under the caller's.
- **End-to-end three-state over HTTP, not through the service:** PATCH `{"salaryMin": null}` and assert the property is gone from the raw stored document; PATCH omitting the key and assert the value is untouched. Every layer is tested at its own layer and none of that proves the chain is connected — a route that normalises the body or strips nullish values turns "clear this" into "leave it alone" silently, which this repo shipped once with media captions.
- A 401 per route file, each asserting the status **and** that nothing was written; one 403 with a `SUPER_ADMIN` session.

- [ ] **Step 2: Run to verify they fail. Step 3: Implement. Step 4: Run to verify they pass.**

- [ ] **Step 5: Mutation-check**

(a) Move `assertSameOrigin` below the write → the cross-origin no-write test fails.
(b) Replace the parsed body with the raw body → the `status`/`_id` smuggling test fails.
(c) Drop `null` from what PATCH forwards → the three-state end-to-end test fails.

Report all three messages.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add vacancy routes"
```

---

### Task 5: Vacancies dashboard section

**Files:**
- Create: `src/components/profile/sections/vacancies-section.tsx`
- Modify: `src/components/profile/profile-editor.tsx`
- Test: browser verification (Task 6); no new unit tests — the logic lives in Tasks 1, 3 and 4

**Read `src/components/profile/sections/achievements-section.tsx` and mirror it.** It went through a review and two fix rounds; everything below is what it was corrected on.

`tsc` and `eslint` are this task's **only** automated gates. A changed eslint warning count is a failure to investigate, not a rounding error — the sibling hit a transient 8th warning that turned out to be a real `setState`-in-effect bug.

**Clearing a field must send `null`, not `""` or a stripped key.** The clearable fields here are `salaryMin`, `salaryMax` and `experienceRequired` — all **numbers**, so an emptied number input yields `""` and `Number("")` is `0`, which would silently store a zero salary rather than clearing it. Convert an emptied numeric input to `null`. The sibling's `toClearable()`/`toOptional()` helpers are the shape to copy; `JSON.stringify` keeps an explicit `null` and drops an `undefined` key, which is what makes the three states expressible over HTTP.

**Three distinguishable load states.** Loading, **failed**, and loaded-but-empty must not look alike. The sibling originally collapsed a failed fetch into the empty state, so an admin saw "no vacancies yet" and could conclude their data was gone. Skeletons while loading; a panel with an alert icon, a "could not load" message, an explicit *"this is not an empty list"* line and a **Try again** button on failure; the existing `EmptyState` only after a successful fetch returns zero rows.

**Fetch on mount, client-side — correct here, not a deviation.** `profile-editor.tsx` renders one section at a time (`active === "..." ? <Section/> : null`), so sections mount lazily and this fetches only when the admin opens the tab. Do not restructure `page.tsx`. Put every state update inside the fetch's `.then()`, never synchronously in the effect body.

**No optimistic updates** — state changes only after the server confirms, every failed mutation surfaces a toast, and busy flags always clear.

The status control offers `DRAFT` → `OPEN` → `FILLED`/`CLOSED`. Group the subject picker by `VACANCY_SUBJECT_GROUPS`, and render benefits as toggles from `VACANCY_BENEFITS` — free text is not allowed, because eduFleet silently discards anything off its list.

- [ ] **Step 1: Implement. Step 2: `tsc` and eslint at baseline. Step 3: Commit**

```bash
git add -A
git commit -m "feat: add the vacancies dashboard section"
```

---

### Task 6: Browser verification

**Files:** none (a verification task; the report is the deliverable)

Restart the dev server by PID first — a model was added and Mongoose caches compiled schemas for a process's lifetime. Find it with `lsof -nP -iTCP:3000 -sTCP:LISTEN -t`, confirm its cwd is this repo, kill by PID, **never by pattern**. If pre-change compile errors persist after the restart, delete `.next/cache`.

Login: `admin@infinityschool.edu.in` / `Infinity!2026`. Playwright is at `/Users/automicai/VVOGI/node_modules/playwright` (absolute path; not installed in this repo).

1. Profile → Vacancies: create one with a subject from each of the three groups in turn; each saves and renders.
2. Benefits render as toggles, not free text; selecting several persists across a reload.
3. `salaryMin` above `salaryMax` is refused with a message naming the problem, before any request is sent.
4. **Clear a field through the form and confirm it is gone.** Give a vacancy a `salaryMin` and an `experienceRequired`, save, reload, confirm both persisted. Then empty both, save, reload — **both must be gone from the stored record, not merely blank in the form**. Verify against the stored document or the network response, not the input, and say which method you used. A form re-rendering its own state proves nothing.
5. A zero `salaryMin` saves as `0` and survives a reload — it must not be confused with cleared.
6. Status moves `DRAFT` → `OPEN` → `FILLED`, and the list reflects each.
7. Console: zero uncaught page errors.
8. **Clean up** every vacancy created, and verify by listing. You are in the **dev database**, not a disposable one — note what exists before you start, delete only what you created, and if you cannot tell whether something was yours, say so and leave it.

- [ ] Record commands, responses and screenshots in the task report.

---

## Self-Review

**Spec coverage:** §4 Vacancy domain → Tasks 1-2; §5 reference data and parity → Task 1; §5.1 the silent-drop hazard → Task 1's benefit enum plus Task 5's toggle-only UI (the pre-push refusal itself is Plan B, since nothing pushes here); §11 testing → each task's own tests plus Task 6. §6, §7, §8, §9 and §10 are **Plan B's** — the contract split, listing state, adapter, error mapping and consent copy all require a push that does not exist in this plan. §12's two decisions bind Plan B, not this one.

**Deliberately deferred to Plan B, and named here so nobody adds them early:** the `listing` block on the model, `PLATFORMS` gaining `"EDUFLEET"`, the adapter and mapping modules, the publish action and its confirmation copy, claim handling, and the `FILLED` → `closed` push.

**Placeholder scan:** no TBDs, no "add validation", no "similar to Task N". Every code step carries its code.

**Type consistency:** `VACANCY_SUBJECTS`/`VACANCY_BENEFITS`/`VACANCY_STATUSES` are declared once in Task 1 and consumed unchanged in Tasks 2-5. `VacancyCreateInput`/`VacancyPatchInput` are declared in Task 1 and are the service's `z.infer<>` types in Task 3. `VacancyService`'s four method names are declared in Task 3's Produces block and referenced identically in Tasks 4-5.

**Verified at source while writing this plan:** eduFleet's 16 subjects, their three groups and the 11 benefit labels, from the 2026-08-28 API map; `Result.ts`'s `institutionId: String` indexed pattern; `requiredText`/`optionalText` in `validation/common.ts`; `ActivityService.record`'s call shape at `result.service.ts:379-388`; that routes parse and services take `z.infer<>` (`api/settings/results/route.ts:24`, `result.service.ts:19-20`); that `requireInstitution()` is `INSTITUTION_ADMIN`-only.
