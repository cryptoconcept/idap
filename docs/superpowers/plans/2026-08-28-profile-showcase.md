# Profile Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an institution three showcase surfaces — what it has won (Achievements), who it produced (Notable Alumni), and what it offers (Facilities, realigned to a vocabulary that maps 1:1 onto PassPercent's).

**Architecture:** Achievements and Alumni become per-institution collections following the `Result` precedent, not embedded arrays — a school may accumulate hundreds, and embedding would bloat the institution document every page load reads. Their shapes mirror PassPercent's own models field-for-field so a future push is a mapping exercise rather than a redesign. Photos and certificates reuse the media phase's storage path verbatim.

**Tech Stack:** Next.js 16 App Router, Mongoose 8, Zod 4, TypeScript, Vitest 3, react-hook-form, Radix/shadcn, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-28-profile-showcase-design.md`

**Reconnaissance source (binding for shape parity):** PassPercent's live models at `/Users/automicai/Documents/GitHub/passpercent/backend/src/`. Where this plan and that source disagree about PassPercent's shapes, **the source wins** — report the disagreement rather than silently following either. That repository is **READ-ONLY**: never edit, commit, lint, or run anything in it.

## Global Constraints

Every task's requirements implicitly include these.

- **Tenant scoping is absolute.** Every read and write is `institutionId`-scoped. Mutation-check every new service method: remove its `institutionId`, confirm exactly its test fails, restore, verify by `grep`. Assert the *other* institution's record is unchanged — not merely that an error was thrown, because a later correctly-scoped query throws its own identical-looking error and masks a broken filter.
- **Never silently reinterpret existing data.** The facilities migration converts what maps and reports the rest; it never guesses.
- **`HIDDEN` never leaves the building** — excluded from every outbound surface.
- **Guard optional numerics with `!= null`, never `?? 0`.**
- `npx tsc --noEmit` → 0 errors. `npx eslint src` → **exactly 0 errors / 7 warnings**. Run eslint yourself and report the count — tests and `tsc` do not catch a lint regression.
- Full suite green. Baseline at plan start: **1195 tests / 107 files** (this branch forks from `main`; the 7 nav-grouping tests live on a separate unmerged branch).
- Test factories are positional: `makeInstitution(institutionId, overrides)` and `makeProfiledInstitution(institutionId, overrides)` from `tests/helpers/factories.ts`.
- **Integration tests need the database lifecycle hooks** — `clearDatabase`, `startTestDatabase`, `stopTestDatabase` from `../helpers/db`, wired via `beforeAll`/`afterAll`/`beforeEach` as `tests/integration/academic-structure-crud.test.ts` does. Without them a model call hangs until a 10s "buffering timed out" error that reads like a code bug and is not one.
- **No `git checkout`, `git switch`, `git worktree add`, or `git stash`** — shared working directory. A stash here has already silently reverted uncommitted work once. Use `git show <ref>:<path>`, and a scratchpad file copy to save state.
- **`git diff --quiet` is NOT a valid mutation-restore check** for uncommitted files. Re-read the line with `grep`.
- `rate-limit.test.ts` and `token-endpoints.test.ts` flake intermittently under full-suite load. Re-run in isolation before attributing anything.
- Playwright: `/Users/automicai/VVOGI/node_modules/playwright` (absolute path; not installed in this repo).
- Never kill a dev server by name or pattern. Find the PID with `lsof -nP -iTCP:3000 -sTCP:LISTEN -t`, confirm its cwd is this repo, kill by PID. **A process restart alone is not always enough** — a stale `.next/cache` can keep serving pre-change compile errors after a model change.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/profile/facilities.ts` | Facility vocabulary — keys, labels, category groups. Replaces the 11-code suggestion list. |
| `scripts/migrate-facility-codes.ts` (new) | One-time code realignment; converts nine, refuses two. |
| `src/models/Achievement.ts` (new) | Achievement collection. |
| `src/models/Alumnus.ts` (new) | Alumni collection. |
| `src/lib/constants.ts` | `ACHIEVEMENT_CATEGORIES`, `ACHIEVEMENT_LEVELS`, `ALUMNI_CATEGORIES`, `SHOWCASE_STATUSES`, caps. |
| `src/lib/validation/showcase.ts` (new) | Zod schemas for both domains. |
| `src/services/achievement.service.ts` (new) | Achievement CRUD + assets. |
| `src/services/alumni.service.ts` (new) | Alumni CRUD + photo. |
| `src/app/api/settings/achievements/**` (new) | Achievement routes. |
| `src/app/api/settings/alumni/**` (new) | Alumni routes. |
| `src/lib/profile/public-projection.ts` | Adds both to the public payload. |
| `src/components/profile/sections/achievements-section.tsx` (new) | Dashboard UI. |
| `src/components/profile/sections/alumni-section.tsx` (new) | Dashboard UI. |
| `src/components/profile/sections/facilities-section.tsx` | Widened picker + unmapped-code notice. |

---

### Task 1: Facility vocabulary

**Files:**
- Modify: `src/lib/profile/facilities.ts` (replaces the current 11-entry list)
- Test: `tests/unit/facility-vocabulary.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FACILITY_GROUPS: { group: string; items: { code: string; label: string }[] }[]`, `FACILITY_CODES: string[]` (all 38, flat), `LEGACY_FACILITY_CODE_MAP: Record<string, string>` (nine old→new), `UNMAPPABLE_LEGACY_CODES: string[]` (`["HOSTEL", "SPORTS"]`). Tasks 2 and 11 consume these.

The vocabulary is copied verbatim from PassPercent's `utils/facilities.js` — keys, labels, and its six category groupings. Its own header warns *"NEVER rename a key; add new ones instead, or stored selections vanish"*, which is exactly why Task 2 refuses rather than guesses.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/facility-vocabulary.test.ts
import { describe, it, expect } from "vitest";
import {
  FACILITY_GROUPS,
  FACILITY_CODES,
  LEGACY_FACILITY_CODE_MAP,
  UNMAPPABLE_LEGACY_CODES,
} from "@/lib/profile/facilities";

describe("facility vocabulary", () => {
  it("carries all 38 PassPercent keys, lowercase, with no duplicates", () => {
    expect(FACILITY_CODES).toHaveLength(38);
    expect(new Set(FACILITY_CODES).size).toBe(38);
    for (const code of FACILITY_CODES) expect(code).toMatch(/^[a-z_]+$/);
  });

  it("groups every code exactly once", () => {
    const grouped = FACILITY_GROUPS.flatMap((g) => g.items.map((i) => i.code));
    expect(grouped.sort()).toEqual([...FACILITY_CODES].sort());
  });

  it("gives every code a non-empty label", () => {
    for (const { items } of FACILITY_GROUPS) {
      for (const item of items) expect(item.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("maps the nine convertible legacy codes to real keys", () => {
    expect(LEGACY_FACILITY_CODE_MAP).toEqual({
      LIBRARY: "library",
      SCIENCE_LAB: "science_lab",
      COMPUTER_LAB: "computer_lab",
      PLAYGROUND: "playground",
      AUDITORIUM: "auditorium",
      TRANSPORT: "transport",
      CAFETERIA: "cafeteria",
      SMART_CLASSROOM: "smart_classes",
      DIGITAL_LEARNING: "digital_library",
    });
    for (const target of Object.values(LEGACY_FACILITY_CODE_MAP)) {
      expect(FACILITY_CODES).toContain(target);
    }
  });

  // MUTATION-DISTINGUISHING: HOSTEL and SPORTS must NOT appear in the map.
  // Adding either — however plausible the target looks — is the data-fabrication
  // this list exists to prevent.
  it("refuses to map HOSTEL and SPORTS", () => {
    expect(UNMAPPABLE_LEGACY_CODES).toEqual(["HOSTEL", "SPORTS"]);
    expect(LEGACY_FACILITY_CODE_MAP).not.toHaveProperty("HOSTEL");
    expect(LEGACY_FACILITY_CODE_MAP).not.toHaveProperty("SPORTS");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/facility-vocabulary.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement**

Replace the file's contents. Copy the keys, labels and group order verbatim from `/Users/automicai/Documents/GitHub/passpercent/backend/src/utils/facilities.js` — **read that file rather than transcribing from this plan**, so a divergence surfaces now rather than at push time.

```ts
// src/lib/profile/facilities.ts
/**
 * Facility vocabulary, aligned key-for-key with PassPercent's
 * `utils/facilities.js` so a school's selections map 1:1 onto what that
 * platform stores. Their file warns "NEVER rename a key; add new ones
 * instead, or stored selections vanish" — the same applies here.
 *
 * The validation schema still accepts any code, so this list can grow
 * without a migration.
 */
export const FACILITY_GROUPS: { group: string; items: { code: string; label: string }[] }[] = [
  {
    group: "Academics",
    items: [
      { code: "smart_classes", label: "Smart Classrooms" },
      { code: "library", label: "Library" },
      { code: "computer_lab", label: "Computer Lab" },
      { code: "science_lab", label: "Science Labs" },
      { code: "language_lab", label: "Language Lab" },
      { code: "ac_classrooms", label: "AC Classrooms" },
      { code: "wifi", label: "Campus Wi-Fi" },
      { code: "digital_library", label: "Digital Library" },
    ],
  },
  {
    group: "Sports",
    items: [
      { code: "playground", label: "Playground" },
      { code: "indoor_games", label: "Indoor Games" },
      { code: "swimming", label: "Swimming Pool" },
      { code: "gym", label: "Gymnasium" },
      { code: "athletics", label: "Athletics Track" },
      { code: "basketball", label: "Basketball Court" },
      { code: "cricket", label: "Cricket Ground" },
      { code: "yoga", label: "Yoga / Meditation" },
    ],
  },
  {
    group: "Infrastructure",
    items: [
      { code: "auditorium", label: "Auditorium" },
      { code: "cafeteria", label: "Cafeteria" },
      { code: "transport", label: "School Transport" },
      { code: "medical_room", label: "Medical Room" },
      { code: "meals", label: "Meals / Mess" },
      { code: "power_backup", label: "Power Backup" },
      { code: "ramp_access", label: "Wheelchair Access" },
    ],
  },
  {
    group: "Safety",
    items: [
      { code: "cctv", label: "CCTV Surveillance" },
      { code: "security_guards", label: "Security Staff" },
      { code: "fire_safety", label: "Fire Safety" },
      { code: "gps_buses", label: "GPS-tracked Buses" },
      { code: "visitor_check", label: "Visitor Screening" },
      { code: "counselor", label: "Student Counselor" },
    ],
  },
  {
    group: "Extracurricular",
    items: [
      { code: "art", label: "Art & Craft" },
      { code: "music", label: "Music" },
      { code: "dance", label: "Dance" },
      { code: "drama", label: "Drama / Theatre" },
      { code: "debate", label: "Debate & MUN" },
      { code: "robotics", label: "Robotics / STEM Club" },
    ],
  },
  {
    group: "Boarding",
    items: [
      { code: "boys_hostel", label: "Boys Hostel" },
      { code: "girls_hostel", label: "Girls Hostel" },
      { code: "day_boarding", label: "Day Boarding" },
    ],
  },
];

export const FACILITY_CODES: string[] = FACILITY_GROUPS.flatMap((g) => g.items.map((i) => i.code));

/** The nine legacy codes whose meaning survives conversion intact. */
export const LEGACY_FACILITY_CODE_MAP: Record<string, string> = {
  LIBRARY: "library",
  SCIENCE_LAB: "science_lab",
  COMPUTER_LAB: "computer_lab",
  PLAYGROUND: "playground",
  AUDITORIUM: "auditorium",
  TRANSPORT: "transport",
  CAFETERIA: "cafeteria",
  SMART_CLASSROOM: "smart_classes",
  DIGITAL_LEARNING: "digital_library",
};

/**
 * Deliberately unmapped. `HOSTEL` does not record which genders are
 * accommodated, and the target vocabulary splits into `boys_hostel` /
 * `girls_hostel` — picking either would assert a fact the school never stated.
 * `SPORTS` is a category, not a facility; expanding it into specific sports
 * would invent claims. Both are reported for an admin to re-pick.
 */
export const UNMAPPABLE_LEGACY_CODES: string[] = ["HOSTEL", "SPORTS"];
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/facility-vocabulary.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Fix the now-broken consumer**

`FACILITY_SUGGESTIONS` no longer exists. Run `npx tsc --noEmit`, then update `facilities-section.tsx` to render `FACILITY_GROUPS` — grouped, with the group name as a small heading. Keep every other behaviour of that section unchanged; Task 11 handles the unmapped-code notice.

- [ ] **Step 6: Commit**

```bash
git add src/lib/profile/facilities.ts tests/unit/facility-vocabulary.test.ts src/components/profile/sections/facilities-section.tsx
git commit -m "feat: align the facility vocabulary with PassPercent's keys"
```

---

### Task 2: Facility code migration

**Files:**
- Create: `scripts/migrate-facility-codes.ts`
- Modify: `package.json` (add `"migrate:facility-codes": "tsx scripts/migrate-facility-codes.ts"`)
- Test: `tests/integration/migrate-facility-codes.test.ts`

**Interfaces:**
- Consumes: `LEGACY_FACILITY_CODE_MAP`, `UNMAPPABLE_LEGACY_CODES` (Task 1).
- Produces: `migrateFacilityCodes({ apply }: { apply: boolean }): Promise<FacilityMigrationReport>` where `FacilityMigrationReport = { scanned: number; converted: number; unmapped: Array<{ institutionId: string; code: string; label: string }> }`.

**Read `scripts/migrate-gallery-to-media.ts` first** and match its structure — it is the closest precedent, a data migration with the same dry-run-by-default / `--apply` flag, the same report-object shape, and the same `isMainModule` gating that keeps it importable by tests. (`scripts/sync-fee-indexes.ts` is an index sync, a different job.)

**The rule that matters:** convert the nine mappable codes and leave `HOSTEL`/`SPORTS` **in place, unchanged**, reporting each. Never drop them, never guess a target. An institution with unmapped codes still has its other codes converted — unlike the media migration's all-or-nothing skip, because here the unmapped rows are individually identifiable and safe to leave beside converted ones.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/migrate-facility-codes.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Institution } from "@/models";
import { migrateFacilityCodes } from "../../scripts/migrate-facility-codes";

beforeAll(async () => {
  await startTestDatabase("migratefacilitycodes");
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("facility code migration", () => {
  it("converts the mappable codes and preserves label, available and note", async () => {
    await makeInstitution("INS0001", {
      facilities: [
        { code: "LIBRARY", label: "Library", available: true, note: "Two floors" },
        { code: "SMART_CLASSROOM", label: "Smart Classroom", available: false },
      ],
    });

    const report = await migrateFacilityCodes({ apply: true });

    expect(report.converted).toBe(1);
    expect(report.unmapped).toEqual([]);
    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
    expect(row?.facilities).toEqual([
      { code: "library", label: "Library", available: true, note: "Two floors" },
      { code: "smart_classes", label: "Smart Classroom", available: false },
    ]);
  });

  // MUTATION-DISTINGUISHING: converting HOSTEL or SPORTS to any target is the
  // data fabrication this migration exists to avoid. They must survive untouched
  // AND be reported — a silent drop would satisfy a "no wrong code" assertion.
  it("leaves HOSTEL and SPORTS untouched and reports them", async () => {
    await makeInstitution("INS0002", {
      facilities: [
        { code: "HOSTEL", label: "Hostel", available: true },
        { code: "SPORTS", label: "Sports", available: true },
        { code: "LIBRARY", label: "Library", available: true },
      ],
    });

    const report = await migrateFacilityCodes({ apply: true });

    const row = await Institution.findOne({ institutionId: "INS0002" }).lean();
    const codes = row?.facilities?.map((f) => f.code);
    expect(codes).toEqual(["HOSTEL", "SPORTS", "library"]);
    expect(report.unmapped).toEqual([
      { institutionId: "INS0002", code: "HOSTEL", label: "Hostel" },
      { institutionId: "INS0002", code: "SPORTS", label: "Sports" },
    ]);
  });

  it("is idempotent — a second run converts nothing", async () => {
    await makeInstitution("INS0003", {
      facilities: [{ code: "LIBRARY", label: "Library", available: true }],
    });

    await migrateFacilityCodes({ apply: true });
    const second = await migrateFacilityCodes({ apply: true });

    expect(second.converted).toBe(0);
  });

  it("writes nothing in dry-run mode", async () => {
    await makeInstitution("INS0004", {
      facilities: [{ code: "LIBRARY", label: "Library", available: true }],
    });

    const report = await migrateFacilityCodes({ apply: false });

    expect(report.converted).toBe(1);
    const row = await Institution.findOne({ institutionId: "INS0004" }).lean();
    expect(row?.facilities?.[0].code).toBe("LIBRARY");
  });
});
```

- [ ] **Step 2: Run to verify they fail. Step 3: Implement. Step 4: Run to verify they pass.**

Implementation rules:
- Select institutions with at least one facility whose `code` appears in `LEGACY_FACILITY_CODE_MAP` **or** `UNMAPPABLE_LEGACY_CODES`.
- Map each facility: convert if in the map, otherwise leave the entry exactly as-is and, if the code is in `UNMAPPABLE_LEGACY_CODES`, push `{institutionId, code, label}` onto `report.unmapped`.
- `converted` counts **institutions** whose facilities changed, not individual codes.
- Write with `updateOne({ institutionId }, { $set: { facilities } })`. Include a precondition so a concurrent edit cannot be clobbered: match on the facilities array you read, or re-verify before writing. Report a mismatch as skipped rather than overwriting.
- Dry-run: compute the report, write nothing.
- When run directly (not imported), default to dry-run; `--apply` writes. Exit non-zero if `unmapped` is non-empty, printing each row so an operator can act.
- Gate the CLI entrypoint behind an `isMainModule` check so importing the module in tests never touches `dotenv` or `mongoose.connect`.

- [ ] **Step 5: Mutation-check the refusal**

Add `HOSTEL: "boys_hostel"` to `LEGACY_FACILITY_CODE_MAP`. Run the tests.
Expected: the "leaves HOSTEL and SPORTS untouched" test FAILS.
Restore, confirm by `grep -n "HOSTEL" src/lib/profile/facilities.ts` (it should appear only in `UNMAPPABLE_LEGACY_CODES` and the comment). Report what failed.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-facility-codes.ts tests/integration/migrate-facility-codes.test.ts package.json
git commit -m "feat: add the facility code migration"
```

---

### Task 3: Constants and validation schemas

**Files:**
- Modify: `src/lib/constants.ts`
- Create: `src/lib/validation/showcase.ts`
- Test: `tests/unit/showcase-validation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the constants below, plus `achievementCreateSchema`, `achievementPatchSchema`, `alumnusCreateSchema`, `alumnusPatchSchema`. Tasks 4-10 consume these.

Add to `src/lib/constants.ts`:

```ts
export const ACHIEVEMENT_CATEGORIES = [
  "ACADEMIC", "SPORTS", "CULTURAL", "OLYMPIAD", "SCIENCE_FAIR", "ROBOTICS", "COMMUNITY_SERVICE",
] as const;
export type AchievementCategory = (typeof ACHIEVEMENT_CATEGORIES)[number];

export const ACHIEVEMENT_CATEGORY_LABELS: Record<AchievementCategory, string> = {
  ACADEMIC: "Academic",
  SPORTS: "Sports",
  CULTURAL: "Cultural",
  OLYMPIAD: "Olympiad",
  SCIENCE_FAIR: "Science Fair",
  ROBOTICS: "Robotics",
  COMMUNITY_SERVICE: "Community Service",
};

export const ACHIEVEMENT_LEVELS = [
  "SCHOOL", "TALUK", "DISTRICT", "STATE", "NATIONAL", "INTERNATIONAL",
] as const;
export type AchievementLevel = (typeof ACHIEVEMENT_LEVELS)[number];

export const ALUMNI_CATEGORIES = [
  "DOCTOR", "ENGINEER", "ENTREPRENEUR", "CIVIL_SERVICES", "SCIENTIST", "ARTIST", "SPORTS", "OTHER",
] as const;
export type AlumniCategory = (typeof ALUMNI_CATEGORIES)[number];

export const ALUMNI_CATEGORY_LABELS: Record<AlumniCategory, string> = {
  DOCTOR: "Doctor",
  ENGINEER: "Engineer",
  ENTREPRENEUR: "Entrepreneur",
  CIVIL_SERVICES: "Civil Services",
  SCIENTIST: "Scientist",
  ARTIST: "Artist",
  SPORTS: "Sports",
  OTHER: "Other",
};

/** Same two-state visibility as media: manageable in the dashboard, HIDDEN never published. */
export const SHOWCASE_STATUSES = ["ACTIVE", "HIDDEN"] as const;
export type ShowcaseStatus = (typeof SHOWCASE_STATUSES)[number];

export const ACHIEVEMENT_MAX_PHOTOS = 10;
export const ACHIEVEMENT_MAX_CERTIFICATES = 5;
export const ACHIEVEMENT_MAX_STUDENTS = 50;
export const SHOWCASE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const SHOWCASE_MAX_PDF_BYTES = 20 * 1024 * 1024;
```

**On casing:** members match PassPercent's one-for-one; only the casing differs, because IDAP's house style is uppercase enums (`RESULT_STATUSES`, `MEDIA_KINDS`). Matching their lowercase would break IDAP's internal consistency for no gain, and a future push lowercases at the mapping boundary.

- [ ] **Step 1: Write the failing test**

Cover, each as its own named test:
- Every enum's members match PassPercent's lists one-for-one when uppercased, asserted against **literal lists written into the test file**. Transcribe those literals from PassPercent's source while writing the test, and cite the source path in a comment — but **the test must not read that repository at runtime**. It is a sibling checkout that will not exist on CI or another machine, and a parity guard that errors on a missing path fails for the wrong reason. This is the guard the spec §12 requires.
- `achievementCreateSchema` requires `category` and `title`, rejects a title over 120 characters, a description over 2000, and an unknown category.
- `alumnusCreateSchema` requires `name` and `category`, accepts `batch` as free text (`"2015"` and `"2012-2015"` both valid), and rejects a name over 100.
- Both patch schemas make every field optional.

- [ ] **Step 2: Run to verify it fails. Step 3: Implement. Step 4: Run to verify it passes.**

Follow `src/lib/validation/institution.ts`'s conventions — `optionalText(max)` for optional trimmed strings, `z.enum` against the constants.

- [ ] **Step 5: Commit**

```bash
git add src/lib/constants.ts src/lib/validation/showcase.ts tests/unit/showcase-validation.test.ts
git commit -m "feat: add showcase constants and validation schemas"
```

---

### Task 4: Achievement and Alumnus models

**Files:**
- Create: `src/models/Achievement.ts`, `src/models/Alumnus.ts`
- Modify: `src/models/index.ts` (export both)
- Test: `tests/unit/showcase-models.test.ts`

**Interfaces:**
- Consumes: Task 3's constants.
- Produces: the `Achievement` and `Alumnus` models. Tasks 5-10 consume them.

Both follow `src/models/Result.ts`'s pattern: `institutionId: { type: String, required: true, index: true }` — a string tenant key, **not** an ObjectId ref, because that is how every other per-institution collection in this repo is keyed.

Field lists are in spec §5 and §6. Indexes on both: `{institutionId: 1, createdAt: -1}` and `{institutionId: 1, status: 1, category: 1}`.

- [ ] **Step 1: Write the failing tests**

Cover: required fields rejected when absent; enum fields rejected on an unknown value; `status` defaults to `ACTIVE`; `batch` accepts `"2012-2015"`; achievement `students` accepts an array of `{name, grade}` and rejects a student without a name; both indexes exist (assert via `Model.schema.indexes()`).

- [ ] **Step 2: Run to verify they fail. Step 3: Implement. Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit**

```bash
git add src/models/Achievement.ts src/models/Alumnus.ts src/models/index.ts tests/unit/showcase-models.test.ts
git commit -m "feat: add the Achievement and Alumnus models"
```

---

### Task 5: Achievement service

**Files:**
- Create: `src/services/achievement.service.ts`
- Test: `tests/integration/achievement-service.test.ts`

**Interfaces:**
- Consumes: Task 3's schemas, Task 4's `Achievement` model.
- Produces: `AchievementService` with `list(institutionId)`, `create(institutionId, input, actor)`, `update(institutionId, achievementId, patch, actor)`, `remove(institutionId, achievementId, actor)`, all returning `AchievementDTO` (or `AchievementDTO[]` / `void`). Task 7 wraps these.

Follow `src/services/result.service.ts`: `await connectToDatabase()` first, `.lean<Doc[]>()` reads, a `serialize` function producing the DTO, and an `ActivityService.record` call on every mutation with the **real** `institutionId`.

- [ ] **Step 1: Write the failing tests**

Cover: create/list/update/remove round-trips; `list` returns newest first; `remove` on another institution's id throws `NOT_FOUND`; an unknown category is rejected before any write.

**Tenant isolation, one test per method** (`list`, `create`, `update`, `remove`): assert INS0002's record is byte-for-byte unchanged after an INS0001-scoped call, not merely that an error was thrown.

- [ ] **Step 2: Run to verify they fail. Step 3: Implement. Step 4: Run to verify they pass.**

- [ ] **Step 5: Mutation-check tenant scoping on all four methods**

Remove `institutionId` from each method's filter in turn. Confirm exactly that method's isolation test fails. Restore each, verify by `grep`. Report all four failure messages.

- [ ] **Step 6: Commit**

```bash
git add src/services/achievement.service.ts tests/integration/achievement-service.test.ts
git commit -m "feat: add the achievement service"
```

---

### Task 6: Alumni service

**Files:**
- Create: `src/services/alumni.service.ts`
- Test: `tests/integration/alumni-service.test.ts`

**Interfaces:**
- Consumes: Task 3's schemas, Task 4's `Alumnus` model.
- Produces: `AlumniService` with `list(institutionId)`, `create(institutionId, input, actor)`, `update(institutionId, alumnusId, patch, actor)`, `remove(institutionId, alumnusId, actor)`. Task 8 wraps these.

Same shape as Task 5 — `result.service.ts`'s conventions, `ActivityService.record` on every mutation with the real `institutionId`.

- [ ] **Step 1: Write the failing tests**

Cover: create/list/update/remove round-trips; `list` sorted by `batch` descending then `name`; `batch` free text survives (`"2012-2015"` round-trips unchanged).

**Tenant isolation, one test per method**, asserting the other institution's record is unchanged.

- [ ] **Step 2: Run to verify they fail. Step 3: Implement. Step 4: Run to verify they pass.**

- [ ] **Step 5: Mutation-check tenant scoping on all four methods**, as Task 5. Report all four failure messages.

- [ ] **Step 6: Commit**

```bash
git add src/services/alumni.service.ts tests/integration/alumni-service.test.ts
git commit -m "feat: add the alumni service"
```

---

### Task 7: Asset uploads for both domains

**Files:**
- Modify: `src/services/achievement.service.ts`, `src/services/alumni.service.ts`
- Test: `tests/integration/showcase-assets.test.ts`

**Interfaces:**
- Consumes: `storage.putPublic` / `storage.deletePublic` from `@/lib/storage`, Task 3's cap constants.
- Produces: `AchievementService.addPhoto`, `addCertificate`, `removeAsset`; `AlumniService.setPhoto`. Tasks 9-10 wrap these.

**Read `InstitutionService.addMediaImage` and `addMediaDocument` first** — this task reuses their pattern exactly, and reinventing it is the failure mode to avoid.

Required properties, each carried over from the media phase for a reason:
- **Magic bytes, not the declared content type.** A multipart form's `contentType` and filename are both client-supplied and prove nothing. Images: check the real signature. Certificates: `%PDF-`.
- **The size check runs before anything is stored.** Assert the storage adapter was *never invoked* on an oversize file, not merely that the call threw.
- **Caps enforced inside the update filter** with the `$expr`/`$size` pattern, and `storage.deletePublic` rollback when the filter rejects — otherwise a refused upload orphans a stored file.
- Keys: `showcase/{institutionId}/achievements/{objectId}{ext}` and `showcase/{institutionId}/alumni/{objectId}{ext}`.
- `remove` deletes the record's stored objects, mirroring `deleteOwnedPhoto`.

- [ ] **Step 1: Write the failing tests**

Cover: a valid image is stored and appears on the record; a `.jpg` whose bytes are not an image is refused (name this test `MUTATION-DISTINGUISHING: magic bytes, not the declared content type`); an oversize file is refused **with the storage adapter never invoked**; `ACHIEVEMENT_MAX_PHOTOS` photos then an 11th refused, **while a certificate on the same record still succeeds** (this is what proves the caps are per-asset-kind rather than shared — and both halves must go through the *same* service whose filter you mutate); deleting a record deletes its stored objects.

- [ ] **Step 2: Run to verify they fail. Step 3: Implement. Step 4: Run to verify they pass.**

- [ ] **Step 5: Mutation-check**

(a) Remove the magic-byte check → the magic-bytes test fails. (b) Make the photo cap's `$expr` count all assets rather than photos → the cap test fails. Restore each, verify by `grep`, report both messages.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add showcase asset uploads"
```

---

### Task 8: Achievement routes

**Files:**
- Create: `src/app/api/settings/achievements/route.ts`, `.../[achievementId]/route.ts`, `.../[achievementId]/assets/route.ts`
- Test: `tests/integration/achievement-routes.test.ts`

**Interfaces:**
- Consumes: Task 5 and Task 7's `AchievementService` methods.
- Produces: the endpoints Task 11's UI calls.

Thin wrappers in the house pattern — **read `src/app/api/settings/institution/media/route.ts` and follow it exactly**: `assertSameOrigin(request)` → `requireInstitution()` → validate → service → `handleApiError`.

- [ ] **Step 1: Write the failing tests**

Happy path per route; unknown id 404s; **and per mutating route, a cross-origin request is refused 403 AND creates/changes nothing** — assert the record count and contents are unchanged, not merely the status code. A route that wrote before asserting origin would pass a status-only check.

- [ ] **Step 2: Run to verify they fail. Step 3: Implement. Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add achievement routes"
```

---

### Task 9: Alumni routes

**Files:**
- Create: `src/app/api/settings/alumni/route.ts`, `.../[alumnusId]/route.ts`, `.../[alumnusId]/photo/route.ts`
- Test: `tests/integration/alumni-routes.test.ts`

**Interfaces:**
- Consumes: Task 6 and Task 7's `AlumniService` methods.
- Produces: the endpoints Task 12's UI calls.

Same house pattern as Task 8. Same CSRF strong assertion: refused **and** nothing written.

- [ ] **Step 1: Write the failing tests. Step 2: Verify red. Step 3: Implement. Step 4: Verify green.**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add alumni routes"
```

---

### Task 10: Public API exposure

**Files:**
- Modify: `src/lib/profile/public-projection.ts`, `src/services/institution.service.ts`, `src/lib/api/openapi.ts`
- Test: `tests/unit/public-projection.test.ts`, `tests/integration/public-profile.test.ts` (extend both)

**Interfaces:**
- Consumes: `toPublicUrl` from `@/lib/media/public-url`; `AchievementService.list` and `AlumniService.list` (Tasks 5-6).
- Produces: `achievements` and `alumni` on the public profile payload.

**A structural point the other tasks do not face.** `toPublicProfile(row, offerings)`
is a projection over the **institution document**, and it is called from
`InstitutionService.getPublicProfile` (`institution.service.ts:978`). Media works
there because `media[]` is embedded on that document. **Achievements and alumni are
separate collections, so they are not on `row` and cannot be projected from it.**

So `getPublicProfile` must fetch both — filtered to `ACTIVE`, scoped to the same
institution — and pass them into `toPublicProfile` as a third argument, alongside
the `offerings` argument that already works this way. Widen `toPublicProfile`'s
signature to match; do not reach into the database from inside the projection,
which is a pure function over what it is handed and must stay that way.

Shapes are in spec §10. **Extend the existing tests, do not replace them** — that file already guards the media projection.

**`assertExternallyReachable` must NOT be called here.** It guards outbound partner pushes only, and there is no push for these domains. Calling it would break local development for no benefit. The asymmetry is deliberate.

- [ ] **Step 1: Write the failing tests**

- `ACTIVE` records appear, **`HIDDEN` do not** — name it `MUTATION-DISTINGUISHING: hidden showcase records never leave the building`.
- Achievements sorted by `eventDate` descending then `createdAt`; alumni by `batch` descending then `name`.
- Asset URLs come back absolute.
- An institution with neither returns `achievements: []` and `alumni: []`, never `undefined`.

- [ ] **Step 2: Verify red. Step 3: Implement. Step 4: Verify green.**

- [ ] **Step 5: Mutation-check the HIDDEN filter**

Remove it for each domain in turn; confirm exactly the corresponding test fails. Restore, verify by `grep`. Report both messages.

- [ ] **Step 6: Update the API documentation**

`docs/api/institution-profile.md` documents this payload. Add both new arrays with their field lists, verifying each claim against the code you just wrote. A confidently wrong API doc is worse than a stale one.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: expose achievements and alumni on the public profile API"
```

---

### Task 11: Achievements dashboard section

**Files:**
- Create: `src/components/profile/sections/achievements-section.tsx`
- Modify: `src/components/profile/profile-editor.tsx`, `src/components/profile/sections/facilities-section.tsx`
- Test: browser verification (Task 13); no new unit tests — the logic lives in Tasks 5, 7 and 8

**Follow `media-section.tsx`** for structure: list, create/edit dialog, asset upload, hide/show, delete behind the confirm-dialog pattern, and add-controls **disabled with a visible reason** when a cap is reached rather than refusing after a file picker.

This task also adds the facilities **unmapped-code notice**: a facility whose code is in `UNMAPPABLE_LEGACY_CODES` renders with a "needs re-picking" marker explaining that the code has no equivalent in the new vocabulary and asking the admin to choose specific ones. Do not auto-convert it in the UI either.

- [ ] **Step 1: Implement. Step 2: `tsc`/eslint at baseline. Step 3: Commit**

```bash
git add -A
git commit -m "feat: add the achievements dashboard section"
```

---

### Task 12: Alumni dashboard section

**Files:**
- Create: `src/components/profile/sections/alumni-section.tsx`
- Modify: `src/components/profile/profile-editor.tsx`
- Test: browser verification (Task 13)

Same pattern as Task 11. A card per alumnus showing photo, name, batch, category, current role and organisation.

- [ ] **Step 1: Implement. Step 2: `tsc`/eslint at baseline. Step 3: Commit**

```bash
git add -A
git commit -m "feat: add the alumni dashboard section"
```

---

### Task 13: Browser verification and migration dry-run

**Files:** none (a verification task; the report is the deliverable)

Restart the dev server by PID first — models changed, and Mongoose caches compiled schemas for a process's lifetime. Find it with `lsof -nP -iTCP:3000 -sTCP:LISTEN -t`, confirm its cwd is this repo, kill by PID, **never by pattern**. If pre-change compile errors persist after the restart, delete `.next/cache` — a process restart alone has proven insufficient on this repo after a model change.

Login: `admin@infinityschool.edu.in` / `Infinity!2026`.

1. Profile → Facilities: the picker shows six groups; select several, save, reload, they persist.
2. Profile → Achievements: create one with a category, level, two students and a photo. It renders.
3. Upload a `.jpg` whose bytes are not an image → refused, nothing stored.
4. Profile → Alumni: create one with a photo, batch `2012-2015`. It renders with the batch text intact.
5. Hide one achievement and one alumnus, then fetch `/api/public/INS0001/profile` — **both must be absent** while the visible ones are present with absolute URLs.
6. Run `npm run migrate:facility-codes` (dry-run, no `--apply`) and confirm it reports without writing.
7. Console: zero uncaught page errors.
8. **Clean up** every record and asset created, and verify by listing — including that no orphaned objects remain under `showcase/INS0001/`.

- [ ] Record commands, responses and screenshots in the task report.

---

## Self-Review

**Spec coverage:** §4 facilities vocabulary → Task 1; §4.3-4.4 migration → Task 2; §5 achievements model → Tasks 3-4; §6 alumni model → Tasks 3-4; §7 assets → Task 7; §8 visibility → Task 3's `SHOWCASE_STATUSES`, enforced in Tasks 5, 6 and 10; §9 services and routes → Tasks 5, 6, 8, 9; §10 public API → Task 10; §11 dashboard → Tasks 11-12; §12 testing → each task's own tests plus Task 13; §13 out-of-scope items appear in no task, as intended. No gaps.

**Type consistency:** `SHOWCASE_STATUSES`/`ACHIEVEMENT_CATEGORIES`/`ACHIEVEMENT_LEVELS`/`ALUMNI_CATEGORIES` are declared once in Task 3 and consumed unchanged in Tasks 4-12. `FACILITY_GROUPS`/`LEGACY_FACILITY_CODE_MAP`/`UNMAPPABLE_LEGACY_CODES` are declared in Task 1 and consumed in Tasks 2 and 11. Service method names are declared in Tasks 5-7's Produces blocks and referenced identically in Tasks 8-10.

**Verified at source while writing this plan:** PassPercent's facility keys, labels and six category groups read from `utils/facilities.js` (38 keys, diffed identical against the spec); `ACHIEVEMENT_CATEGORIES`, `ACHIEVEMENT_LEVELS` and `ALUMNI_CATEGORIES` read from its live source; `Result.ts` uses `institutionId: String` indexed with `status` defaulting via enum, which is the precedent Task 4 follows; `ResultService` exposes `list`/`create`/`update`/`remove` with `(institutionId, …, actor)` signatures; `deleteOwnedPhoto` exists in `result.service.ts`; `toPublicUrl` exists in `src/lib/media/public-url.ts`; `migrate-gallery-to-media.ts` is the migration-script convention Task 2 follows (dry-run default, `--apply` to write, `isMainModule` gating so tests can import it).

**Deviations decided while planning:** (1) The facilities migration converts per-institution rather than all-or-nothing — unlike the media migration — because unmapped rows here are individually identifiable and safe to leave beside converted ones. (2) Enum members match PassPercent one-for-one but keep IDAP's uppercase house casing, with lowercasing deferred to a future mapping boundary. (3) Task 7 bundles both domains' asset handling into one task rather than splitting per domain, because they share one pattern and splitting would duplicate its review surface.
