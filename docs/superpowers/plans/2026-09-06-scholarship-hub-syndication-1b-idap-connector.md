# Scholarship Hub Syndication — Plan 1B: IDAP Scholarship Enrichment + Connector

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich IDAP's scholarship domain to full structured parity with Scholarship Hub, and add a `SCHOLARSHIP_HUB` push connector so publishing a scholarship in IDAP idempotently upserts a live listing on the Hub (and unpublish/archive/delete withdraws it), mirroring the vacancy→eduFleet precedent.

**Architecture:** IDAP vendors the Hub's vocabulary, enriches `Scholarship` with structured eligibility/benefits/dates/documents plus a remote `listing` sub-document, and adds a `SCHOLARSHIP_HUB` platform whose adapter drives Plan 1A's `/api/partner/*` endpoints. A `scholarship-publish.service` orchestrates publish/repush/withdraw against the adapter, records listing state, and never latches failures — the same shape as `vacancy-publish.service`.

**Tech Stack:** Next.js 16, Mongoose 8, Zod 4, TypeScript, Vitest 3 (run at `--maxWorkers=4`), the existing `PlatformAdapter` connector framework + AES-256-GCM credential vault.

**Spec:** `/Users/automicai/AEMPlatform/docs/superpowers/specs/2026-09-06-scholarship-hub-syndication-design.md` (this plan implements spec §5 and §7, plus the IDAP half of §8/§9/§10/§11). **Depends on Plan 1A** (the Hub `/api/partner/*` contract) — build 1A first (spec §13 deploy order).

## Global Constraints

- All work is in `/Users/automicai/AEMPlatform`. Do not touch the Hub or the read-only partner repos.
- Vendor the Hub's vocabulary **verbatim** from `scholarship-hub/packages/shared/src/enums.ts` and `.../data/states.ts` (+ districts). A subset test asserts every IDAP value is one the Hub accepts; drift fails the test.
- Scholarship `listing` sub-document is **withheld from the public projection** — `src/lib/scholarship/public-projection.ts` stays an explicit allow-list and never spreads the document.
- IDAP mirrors the Hub's publish-completeness gate locally (`assertScholarshipHubPublishable`) so a push never bounces on completeness; a gate-parity test keeps the two in step.
- `externalRef` sent to the Hub = `IDAP:{institutionId}:{scholarshipId}`; the provider provision ref = `IDAP:{institutionId}`.
- Pushes only run for an institution with a CONNECTED `SCHOLARSHIP_HUB` connection + scope; revoking consent withdraws its listings and drops the ciphertext.
- The mapping builder is an allow-list — scholarship fields only, **no lead/applicant PII**.
- Push failures never throw out of an edit path; they record `listing.blockedReason` and a later success `$unset`s it (mirror vacancy behavior). Classify into the existing `ConnectorRejectedError`/`ConnectorCapExceededError`/`ConnectorAuthError` taxonomy.
- Generalizing `JobPushResult` → `ListingPushResult` must leave the vacancy push path behaviorally unchanged (its tests stay green).
- Every task ends green: `npx vitest run --maxWorkers=4 <file>`, and the full suite + `tsc` + `eslint` before the final task's commit.

---

## File Structure

**Create:**
- `src/lib/scholarship-hub/vocabulary.ts` — vendored Hub enums + state/district codes (the single source IDAP validates against).
- `src/lib/connectors/scholarship-hub.ts` — the `PlatformAdapter`.
- `src/lib/connectors/scholarship-hub-mapping.ts` — `toHubScholarshipPayload` (allow-list builder).
- `src/services/scholarship-publish.service.ts` — publish/repush/withdraw orchestrator.
- Test files colocated per IDAP convention.

**Modify:**
- `src/lib/constants.ts` — `PLATFORMS`, `PLATFORM_LABELS`, new `SCHOLARSHIP_LISTING_*` enums.
- `src/models/Scholarship.ts` — structured fields + `listing` sub-doc.
- `src/lib/validation/scholarship.ts` — enriched schemas + `assertScholarshipHubPublishable`.
- `src/lib/scholarship/public-projection.ts` — confirm `listing`/internal fields excluded.
- `src/lib/connectors/types.ts` — `ListingPushResult`, adapter methods, `SyncSourceData.scholarships`.
- `src/lib/connectors/index.ts` — side-effect import of the new adapter.
- `src/services/scholarship.service.ts` — call the publish service from `setStatus`/`update`/`remove`.
- `src/services/connection.service.ts` — scholarship worklist in `syncNow`.
- Scholarship editor component(s) + `src/components/integration/connections-panel.tsx` (opt-in) — structured fields + publish affordance.

---

## Tasks (overview — full bodies below)

1. **Vendored vocabulary + subset test** — the Hub's enums + geo codes, with a drift-catching test.
2. **Platform registry + listing enums** — add `SCHOLARSHIP_HUB` and `SCHOLARSHIP_LISTING_*`.
3. **Enrich the Scholarship model** — structured fields + a `listing` sub-doc (withheld from public reads).
4. **Enrich validation + local publish gate** — schemas gain the structured fields; `assertScholarshipHubPublishable` mirrors the Hub gate (gate-parity test).
5. **Generalize connector types** — `ListingPushResult`, `upsertScholarship`/`withdrawScholarship`, `SyncSourceData.scholarships` (vacancy path unchanged).
6. **Mapping builder** — `toHubScholarshipPayload`, mutation-distinguishing.
7. **The adapter** — `scholarship-hub.ts`: connect (immediate), upsert, withdraw, sync, classify; register.
8. **Publish orchestrator** — `scholarship-publish.service.ts`: publish/repush/withdraw, listing state, failure handling.
9. **Wire the domain** — `ScholarshipService` calls the orchestrator; `connection.service.syncNow` gains a scholarship worklist.
10. **UI** — structured fields in the editor + publish affordance (listing state / publicUrl / blockedReason) + connections-panel opt-in.

---

All paths are relative to `/Users/automicai/AEMPlatform`. Run every test as `npx vitest run --maxWorkers=4 <file>`.

**Two rulings this plan makes against the spec (both safer than the letter of §7.9 / §8):**
1. **Parallel result type, not a mutation.** Spec §7.9 says "generalize `JobPushResult` → `ListingPushResult`." The OK variant genuinely differs (`jobId` vs `hubId`/`slug`), so this plan defines a **separate** `ScholarshipPushResult` and leaves `JobPushResult` untouched — which better honors the constraint "leave the vacancy push path behaviorally unchanged."
2. **A revoked partner key is a platform problem, not a per-institution one.** Spec §8 maps a 401 to `ConnectorAuthError` → disconnect. But the Scholarship Hub partner key is Contract 1 (shared across all institutions), not a per-school grant, so a 401 must NOT disconnect one institution's consent. This plan surfaces a 401 as a hard upstream error for the super-admin instead.

---

### Task 1: Vendored Hub vocabulary + drift fixture

**Files:**
- Create: `src/lib/scholarship-hub/vocabulary.ts`
- Create: `tests/fixtures/hub-vocabulary.json`
- Test: `tests/unit/scholarship-hub-vocabulary.test.ts`

**Interfaces:**
- Produces: `HUB_SCHOLARSHIP_CATEGORIES`, `HUB_EDUCATION_LEVELS`, `HUB_GENDERS`, `HUB_COMMUNITY_CATEGORIES`, `HUB_QUESTION_TYPES`, `HUB_APPLICATION_MODES`, `HUB_STATE_CODES`, `HUB_KA_DISTRICT_CODES` — all `readonly string[]` consumed by Tasks 4 and 6.

- [ ] **Step 1: Vendor the enums**

`src/lib/scholarship-hub/vocabulary.ts`:
```ts
// Vendored verbatim from scholarship-hub/packages/shared/src/enums.ts and
// .../data/states.ts on 2026-09-06. IDAP cannot import the Hub package; this
// is the single source IDAP validates and maps against. Re-vendor (and update
// tests/fixtures/hub-vocabulary.json in the same commit) whenever the Hub's
// vocabulary changes — the drift test below fails until both agree.
export const HUB_SCHOLARSHIP_CATEGORIES = ['government','private','university','merit','need_based','girl_students','stem','minority_community','disability','sports','international','csr'] as const;
export const HUB_EDUCATION_LEVELS = ['school','puc','diploma','undergraduate','postgraduate','phd','other'] as const;
export const HUB_GENDERS = ['female','male','other'] as const;
export const HUB_COMMUNITY_CATEGORIES = ['general','sc','st','obc','category_1','2a','2b','3a','3b','minority','ews'] as const;
export const HUB_QUESTION_TYPES = ['text','textarea','select','radio','checkbox','date','number','file'] as const;
export const HUB_APPLICATION_MODES = ['platform','external'] as const;
export const HUB_STATE_CODES = ['AP','AR','AS','BR','CT','GA','GJ','HR','HP','JH','KA','KL','MP','MH','MN','ML','MZ','NL','OR','PB','RJ','SK','TN','TG','TR','UP','UT','WB','AN','CH','DN','DL','JK','LA','LD'] as const;
// Karnataka launch market. Vendor the KA district codes verbatim from the Hub's
// districts data file (scholarship-hub/packages/shared/src/data/districts*.ts —
// confirm the filename) and paste them here as a string-literal array.
export const HUB_KA_DISTRICT_CODES = [/* KA-BLR, KA-MYS, ... — paste from the Hub districts data */] as const;
```

- [ ] **Step 2: Snapshot the vocabulary as a shared fixture**

`tests/fixtures/hub-vocabulary.json` — a JSON object with one key per vendored array (`scholarshipCategories`, `educationLevels`, `genders`, `communityCategories`, `questionTypes`, `applicationModes`, `stateCodes`, `kaDistrictCodes`), values identical to the constants above. This same fixture is what Plan 1A's Hub tests assert against, so both repos share one contract snapshot.

- [ ] **Step 3: Write the failing drift test**

`tests/unit/scholarship-hub-vocabulary.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import fixture from "../fixtures/hub-vocabulary.json";
import * as V from "@/lib/scholarship-hub/vocabulary";

describe("vendored Hub vocabulary", () => {
  it("matches the shared contract snapshot exactly", () => {
    expect([...V.HUB_SCHOLARSHIP_CATEGORIES]).toEqual(fixture.scholarshipCategories);
    expect([...V.HUB_EDUCATION_LEVELS]).toEqual(fixture.educationLevels);
    expect([...V.HUB_GENDERS]).toEqual(fixture.genders);
    expect([...V.HUB_COMMUNITY_CATEGORIES]).toEqual(fixture.communityCategories);
    expect([...V.HUB_QUESTION_TYPES]).toEqual(fixture.questionTypes);
    expect([...V.HUB_APPLICATION_MODES]).toEqual(fixture.applicationModes);
    expect([...V.HUB_STATE_CODES]).toEqual(fixture.stateCodes);
    expect([...V.HUB_KA_DISTRICT_CODES]).toEqual(fixture.kaDistrictCodes);
  });
});
```

- [ ] **Step 4: Run it — verify it passes** (constants and fixture written together)

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-hub-vocabulary.test.ts`
Expected: PASS. (If you edit one without the other, it fails — that is the drift guard.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/scholarship-hub/vocabulary.ts tests/fixtures/hub-vocabulary.json tests/unit/scholarship-hub-vocabulary.test.ts
git commit -m "feat(scholarship-hub): vendor the Hub vocabulary with a drift fixture"
```

---

### Task 2: Platform registry + scholarship listing enums

**Files:**
- Modify: `src/lib/constants.ts`
- Test: `tests/unit/scholarship-hub-constants.test.ts`

**Interfaces:**
- Produces: `PLATFORMS` now includes `"SCHOLARSHIP_HUB"`; `PLATFORM_LABELS.SCHOLARSHIP_HUB = "Scholarship Hub"`; `SCHOLARSHIP_LISTING_REMOTE_STATUSES = ["published","closed"] as const` + `ScholarshipListingRemoteStatus`.

- [ ] **Step 1: Write the failing test**

`tests/unit/scholarship-hub-constants.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PLATFORMS, PLATFORM_LABELS, SCHOLARSHIP_LISTING_REMOTE_STATUSES } from "@/lib/constants";

describe("SCHOLARSHIP_HUB registry", () => {
  it("registers the platform and label", () => {
    expect(PLATFORMS).toContain("SCHOLARSHIP_HUB");
    expect(PLATFORM_LABELS.SCHOLARSHIP_HUB).toBe("Scholarship Hub");
  });
  it("defines the listing remote statuses", () => {
    expect(SCHOLARSHIP_LISTING_REMOTE_STATUSES).toEqual(["published", "closed"]);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-hub-constants.test.ts`
Expected: FAIL — `SCHOLARSHIP_HUB` not in `PLATFORMS`.

- [ ] **Step 3: Edit `src/lib/constants.ts`**

- Add `"SCHOLARSHIP_HUB"` to the `PLATFORMS` tuple (line ~471).
- Add `SCHOLARSHIP_HUB: "Scholarship Hub"` to `PLATFORM_LABELS` (lines ~474-478).
- Near the `VACANCY_LISTING_REMOTE_STATUSES` block (line ~773), add:
```ts
export const SCHOLARSHIP_LISTING_REMOTE_STATUSES = ["published", "closed"] as const;
export type ScholarshipListingRemoteStatus = (typeof SCHOLARSHIP_LISTING_REMOTE_STATUSES)[number];
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-hub-constants.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the platform-enum consumers to confirm nothing broke**

Run: `npx vitest run --maxWorkers=4 tests/integration/connection-service.test.ts tests/integration/platform-credentials.test.ts`
Expected: PASS. (Adding a platform must not break the credential/connection machinery that iterates `PLATFORMS`. If a test asserts an exact `PLATFORMS.length` or a fixed label map, update it to include `SCHOLARSHIP_HUB`.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/constants.ts tests/unit/scholarship-hub-constants.test.ts
git commit -m "feat(scholarship-hub): register SCHOLARSHIP_HUB platform and listing statuses"
```

---

### Task 3: Enrich the Scholarship model (structured fields + `listing` sub-doc)

**Files:**
- Modify: `src/models/Scholarship.ts`
- Test: `tests/integration/scholarship-model-fields.test.ts`

**Interfaces:**
- Produces: the enriched `Scholarship` document — `summary`, `description`, `categories[]`, `tags[]`, `benefits{}`, `eligibility{}`, `applicationMode`, `requiredDocuments[]`, `customQuestions[]`, `applicationSteps[]`, `dates{}`, `selectionProcess`, `terms`, `faqs[]`, `sourceUrl`, and a `listing` sub-doc `{ hubId, externalRef, slug, publicUrl, remoteStatus, lastPushedAt, blockedReason }`. Consumed by Tasks 4, 6, 8.

- [ ] **Step 1: Write the failing test**

`tests/integration/scholarship-model-fields.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { Scholarship } from "@/models/Scholarship";

beforeAll(() => startTestDatabase("scholarship-model-fields"));
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("enriched Scholarship model", () => {
  it("stores the structured fields and a listing sub-doc", async () => {
    const doc = await Scholarship.create({
      institutionId: "INS0001", name: "Infinity Merit", status: "DRAFT",
      summary: "Merit award", description: "x".repeat(220),
      categories: ["merit"], benefits: { amountMin: 10000, tuitionWaiver: true },
      eligibility: { stateCodes: ["KA"], genders: ["female"], communityCategories: ["obc"], otherCriteria: ["Top 10%"] },
      applicationMode: "platform",
      requiredDocuments: [{ key: "marksheet", label: "Marksheet", required: true }],
      dates: { closesAt: new Date(Date.now() + 30 * 864e5) },
      listing: { hubId: "h1", externalRef: "IDAP:INS0001:x", slug: "infinity-merit", remoteStatus: "published", lastPushedAt: new Date() },
    });
    const stored = await Scholarship.findById(doc._id).lean();
    expect(stored?.benefits?.amountMin).toBe(10000);
    expect(stored?.eligibility?.stateCodes).toEqual(["KA"]);
    expect(stored?.applicationMode).toBe("platform");
    expect(stored?.listing?.remoteStatus).toBe("published");
  });

  it("defaults applicationMode to platform and leaves listing undefined", async () => {
    const doc = await Scholarship.create({ institutionId: "INS0001", name: "Bare" });
    const stored = await Scholarship.findById(doc._id).lean();
    expect(stored?.applicationMode).toBe("platform");
    expect(stored?.listing).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-model-fields.test.ts`
Expected: FAIL — structured fields stripped (not in schema).

- [ ] **Step 3: Enrich `src/models/Scholarship.ts`**

Import the enums and add sub-schemas + fields. Mirror `Vacancy.listing` (`src/models/Vacancy.ts:21-81`) for the listing block:
```ts
import { SCHOLARSHIP_STATUSES, SCHOLARSHIP_LISTING_REMOTE_STATUSES } from "@/lib/constants";
import {
  HUB_SCHOLARSHIP_CATEGORIES, HUB_EDUCATION_LEVELS, HUB_GENDERS,
  HUB_COMMUNITY_CATEGORIES, HUB_QUESTION_TYPES, HUB_APPLICATION_MODES,
} from "@/lib/scholarship-hub/vocabulary";

const BenefitsSchema = new Schema({
  amountMin: Number, amountMax: Number, stipendMonthly: Number, awards: Number,
  tuitionWaiver: { type: Boolean, default: false },
}, { _id: false });

const EligibilitySchema = new Schema({
  stateCodes: [String], districtCodes: [String],
  educationLevels: [{ type: String, enum: HUB_EDUCATION_LEVELS }],
  classesOrCourses: [String], streams: [String],
  genders: [{ type: String, enum: HUB_GENDERS }],
  ageMin: Number, ageMax: Number, minPercentage: Number, maxAnnualIncome: Number,
  communityCategories: [{ type: String, enum: HUB_COMMUNITY_CATEGORIES }],
  disabilityRequired: { type: Boolean, default: false },
  otherCriteria: [String],
}, { _id: false });

const RequiredDocumentSchema = new Schema({
  key: { type: String, required: true }, label: { type: String, required: true },
  required: { type: Boolean, default: true },
}, { _id: false });

const CustomQuestionSchema = new Schema({
  key: { type: String, required: true }, label: { type: String, required: true },
  type: { type: String, enum: HUB_QUESTION_TYPES, required: true },
  options: [String], required: { type: Boolean, default: false }, helpText: String,
}, { _id: false });

const DatesSchema = new Schema({ opensAt: Date, closesAt: Date, resultAt: Date }, { _id: false });
const FaqSchema = new Schema({ q: { type: String, required: true }, a: { type: String, required: true } }, { _id: false });

const ScholarshipListingSchema = new Schema({
  hubId: { type: String, required: true },
  externalRef: { type: String, required: true },
  slug: String,
  publicUrl: String,
  remoteStatus: { type: String, enum: SCHOLARSHIP_LISTING_REMOTE_STATUSES, default: "published" },
  lastPushedAt: { type: Date, required: true },
  blockedReason: String,
}, { _id: false });
```
Add to the main `ScholarshipSchema` body (after the existing `amount`/`criteria` fields — keep those; they map to `amountText`/`otherCriteria`):
```ts
  summary: String,
  description: String,
  categories: [{ type: String, enum: HUB_SCHOLARSHIP_CATEGORIES }],
  tags: [String],
  benefits: { type: BenefitsSchema, default: undefined },
  eligibility: { type: EligibilitySchema, default: undefined },
  applicationMode: { type: String, enum: HUB_APPLICATION_MODES, default: "platform" },
  requiredDocuments: { type: [RequiredDocumentSchema], default: undefined },
  customQuestions: { type: [CustomQuestionSchema], default: undefined },
  applicationSteps: [String],
  dates: { type: DatesSchema, default: undefined },
  selectionProcess: String,
  terms: String,
  faqs: { type: [FaqSchema], default: undefined },
  sourceUrl: String,
  listing: { type: ScholarshipListingSchema, default: undefined },
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-model-fields.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the public projection still excludes the new internal fields**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-public-projection.test.ts`
Expected: PASS unchanged — `toPublicScholarship` is an allow-list, so `listing`/`eligibility`/etc. are already excluded. (If no such test file exists, create one asserting `toPublicScholarship` output keys are exactly `["name","criteria","amount","classOrCourse","publishedAt"]` and never include `listing`.)

- [ ] **Step 6: Commit**

```bash
git add src/models/Scholarship.ts tests/integration/scholarship-model-fields.test.ts
git commit -m "feat(scholarship-hub): enrich Scholarship with structured fields and a listing sub-doc"
```

---

### Task 4: Enrich validation + the local publish gate

**Files:**
- Modify: `src/lib/validation/scholarship.ts`
- Create: `tests/fixtures/hub-completeness-cases.json`
- Test: `tests/unit/scholarship-hub-publishable.test.ts`

**Interfaces:**
- Consumes: the vendored vocabulary (Task 1).
- Produces: enriched `createScholarshipSchema`/`updateScholarshipSchema` (structured fields, all optional except `name`); `scholarshipHubMissingFields(input, now?): string[]`; `assertScholarshipHubPublishable(input): void`. Consumed by Tasks 6, 8, 9.

- [ ] **Step 1: Write the shared completeness fixture**

`tests/fixtures/hub-completeness-cases.json` — an array of `{ input, expectedMissing }` cases mirroring the Hub's `missingScholarshipFields` (Plan 1A tests the same cases). Include at minimum: a fully-complete platform listing (`expectedMissing: []`); one missing `closesAt`; one missing `requiredDocuments`; one with only `amount` free-text as the benefit (`expectedMissing` must NOT contain `benefits` — free-text amount satisfies the gate); one `external` mode missing `externalUrl`.

- [ ] **Step 2: Write the failing gate test**

`tests/unit/scholarship-hub-publishable.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import cases from "../fixtures/hub-completeness-cases.json";
import { scholarshipHubMissingFields, assertScholarshipHubPublishable } from "@/lib/validation/scholarship";

describe("scholarshipHubMissingFields (gate parity with the Hub)", () => {
  const NOW = new Date("2026-09-06T00:00:00.000Z");
  for (const [i, c] of (cases as { input: Record<string, unknown>; expectedMissing: string[] }[]).entries()) {
    it(`case ${i} matches the Hub verdict`, () => {
      expect(scholarshipHubMissingFields(c.input, NOW).sort()).toEqual([...c.expectedMissing].sort());
    });
  }
  it("throws for an incomplete listing and passes a complete one", () => {
    expect(() => assertScholarshipHubPublishable({ name: "X" })).toThrow();
    const complete = (cases as { input: Record<string, unknown>; expectedMissing: string[] }[]).find((c) => c.expectedMissing.length === 0)!;
    expect(() => assertScholarshipHubPublishable({ ...complete.input, now: NOW } as never)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run it — verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-hub-publishable.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 4: Enrich `src/lib/validation/scholarship.ts`**

Add the structured fields to `createScholarshipSchema` (all optional; keep `name`/`criteria`/`amount`/`academicUnitId`), built from the vendored enums, then add the gate. Mirror the Hub's `missingScholarshipFields` (spec §5.4):
```ts
import { z } from "zod";
import { validationError } from "@/lib/api/errors";
import {
  HUB_SCHOLARSHIP_CATEGORIES, HUB_EDUCATION_LEVELS, HUB_GENDERS,
  HUB_COMMUNITY_CATEGORIES, HUB_QUESTION_TYPES, HUB_APPLICATION_MODES, HUB_STATE_CODES,
} from "@/lib/scholarship-hub/vocabulary";

const benefitsSchema = z.object({
  amountMin: z.number().min(0).optional(), amountMax: z.number().min(0).optional(),
  stipendMonthly: z.number().min(0).optional(), awards: z.number().int().min(0).optional(),
  tuitionWaiver: z.boolean().optional(),
}).optional();

const eligibilitySchema = z.object({
  stateCodes: z.array(z.enum(HUB_STATE_CODES)).optional(),
  districtCodes: z.array(z.string()).optional(),
  educationLevels: z.array(z.enum(HUB_EDUCATION_LEVELS)).optional(),
  classesOrCourses: z.array(z.string()).optional(), streams: z.array(z.string()).optional(),
  genders: z.array(z.enum(HUB_GENDERS)).optional(),
  ageMin: z.number().int().min(0).optional(), ageMax: z.number().int().min(0).optional(),
  minPercentage: z.number().min(0).max(100).optional(), maxAnnualIncome: z.number().min(0).optional(),
  communityCategories: z.array(z.enum(HUB_COMMUNITY_CATEGORIES)).optional(),
  disabilityRequired: z.boolean().optional(), otherCriteria: z.array(z.string()).optional(),
}).optional();

const requiredDocumentSchema = z.object({ key: z.string().min(1), label: z.string().min(1), required: z.boolean().optional() });
const customQuestionSchema = z.object({ key: z.string().min(1), label: z.string().min(1), type: z.enum(HUB_QUESTION_TYPES), options: z.array(z.string()).optional(), required: z.boolean().optional(), helpText: z.string().optional() });

// ADD these keys to the existing createScholarshipSchema object:
  summary: z.string().max(500).optional(),
  description: z.string().max(20000).optional(),
  categories: z.array(z.enum(HUB_SCHOLARSHIP_CATEGORIES)).optional(),
  tags: z.array(z.string()).max(20).optional(),
  benefits: benefitsSchema,
  eligibility: eligibilitySchema,
  applicationMode: z.enum(HUB_APPLICATION_MODES).optional(),
  externalUrl: z.string().url().optional(),
  requiredDocuments: z.array(requiredDocumentSchema).max(30).optional(),
  customQuestions: z.array(customQuestionSchema).max(50).optional(),
  applicationSteps: z.array(z.string()).max(20).optional(),
  dates: z.object({ opensAt: z.string().optional(), closesAt: z.string().optional(), resultAt: z.string().optional() }).optional(),
  selectionProcess: z.string().max(5000).optional(),
  terms: z.string().max(20000).optional(),
  faqs: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).max(30).optional(),
  sourceUrl: z.string().url().optional(),
```
Then the gate (mirrors the Hub's `missingScholarshipFields`/`hasBenefit`; the free-text `amount` counts as `amountText`):
```ts
type GateInput = {
  name?: string | null; summary?: string | null; description?: string | null;
  categories?: string[]; amount?: string | null;
  benefits?: { amountMin?: number; amountMax?: number; stipendMonthly?: number; awards?: number; tuitionWaiver?: boolean };
  dates?: { closesAt?: string | Date | null };
  applicationMode?: "platform" | "external"; externalUrl?: string | null;
  requiredDocuments?: { required?: boolean }[];
};
const blank = (s?: string | null) => !s || s.trim().length === 0;
function hasBenefit(i: GateInput): boolean {
  const b = i.benefits;
  if (b) { for (const n of [b.amountMin, b.amountMax, b.stipendMonthly, b.awards]) if (typeof n === "number" && n > 0) return true; if (b.tuitionWaiver) return true; }
  return !blank(i.amount); // free-text amount → amountText
}
export function scholarshipHubMissingFields(i: GateInput, now: Date = new Date()): string[] {
  const missing: string[] = [];
  if (blank(i.name)) missing.push("name");
  if (blank(i.summary)) missing.push("summary");
  if (!i.description || i.description.trim().length < 200) missing.push("description");
  if (!(i.categories?.length)) missing.push("categories");
  if (!hasBenefit(i)) missing.push("benefits");
  const c = i.dates?.closesAt ? new Date(i.dates.closesAt) : null;
  if (!c || Number.isNaN(c.getTime()) || c.getTime() <= now.getTime()) missing.push("closesAt");
  if ((i.applicationMode ?? "platform") === "external") { if (blank(i.externalUrl)) missing.push("externalUrl"); }
  else if (!(i.requiredDocuments ?? []).some((d) => d.required !== false)) missing.push("requiredDocuments");
  return missing;
}
export function assertScholarshipHubPublishable(i: GateInput): void {
  const missing = scholarshipHubMissingFields(i);
  if (missing.length > 0) throw validationError(`Not publishable to Scholarship Hub — missing: ${missing.join(", ")}`);
}
```

- [ ] **Step 5: Run it — verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-hub-publishable.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/validation/scholarship.ts tests/fixtures/hub-completeness-cases.json tests/unit/scholarship-hub-publishable.test.ts
git commit -m "feat(scholarship-hub): structured scholarship validation + local publish gate"
```

---

### Task 5: Connector types — `ScholarshipPushResult`, adapter methods, sync source, DELETE

**Files:**
- Modify: `src/lib/connectors/types.ts`
- Modify: `src/lib/connectors/http.ts` — widen the `ConnectorHttp` method union to include `"DELETE"`
- Test: `tests/unit/connector-types-scholarship.test.ts` (a compile-level guard — a tiny adapter literal that must typecheck)

**Interfaces:**
- Produces: `ScholarshipPushResult` (`OK{hubId,slug,publicUrl?,remoteStatus} | BLOCKED{reason,detail} | NOT_FOUND`); optional `upsertScholarship?`/`withdrawScholarship?` on `PlatformAdapter`; `SyncScholarship` + `SyncSourceData.scholarships?` + `scholarshipsTruncated?`; `ConnectorHttp` accepts `"DELETE"`.

- [ ] **Step 1: Write the failing typecheck guard**

`tests/unit/connector-types-scholarship.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { PlatformAdapter, ScholarshipPushResult, SyncSourceData } from "@/lib/connectors/types";

describe("scholarship connector types", () => {
  it("allows an adapter to declare scholarship push methods", () => {
    const partial: Pick<PlatformAdapter, "upsertScholarship" | "withdrawScholarship"> = {
      async upsertScholarship() { return { kind: "OK", hubId: "h", slug: "s", remoteStatus: "published" } as ScholarshipPushResult; },
      async withdrawScholarship() { return { kind: "NOT_FOUND" } as ScholarshipPushResult; },
    };
    expect(typeof partial.upsertScholarship).toBe("function");
  });
  it("allows a scholarships worklist on SyncSourceData", () => {
    const s: Pick<SyncSourceData, "scholarships"> = { scholarships: [] };
    expect(s.scholarships).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/unit/connector-types-scholarship.test.ts`
Expected: FAIL (typecheck) — members don't exist.

- [ ] **Step 3: Add the types**

In `src/lib/connectors/types.ts`, near `JobPushResult` (do NOT modify `JobPushResult`), add:
```ts
export type ScholarshipPushResult =
  | { kind: "OK"; hubId: string; slug: string; publicUrl?: string; remoteStatus: "published" | "closed" }
  | { kind: "BLOCKED"; reason: string; detail: string }
  | { kind: "NOT_FOUND" };
```
Add two optional methods to `PlatformAdapter` (after `closeJob?`):
```ts
  upsertScholarship?(ctx: AdapterContext, connection: ConnectionState, externalRef: string, body: Record<string, unknown>): Promise<ScholarshipPushResult>;
  withdrawScholarship?(ctx: AdapterContext, connection: ConnectionState, externalRef: string): Promise<ScholarshipPushResult>;
```
Add the sync worklist type (mirror `SyncVacancy`) and extend `SyncSourceData`:
```ts
export type SyncScholarship = {
  scholarshipId: string;
  name: string;
  status: string;
  listing?: { remoteStatus: "published" | "closed"; blockedReason?: string };
  repush(): Promise<{ ok: true } | { ok: false; scope: "SCHOLARSHIP" | "RUN"; detail: string }>;
  close(): Promise<{ ok: true } | { ok: false; scope: "SCHOLARSHIP" | "RUN"; detail: string }>;
};
// in SyncSourceData:
  scholarships?: SyncScholarship[];
  scholarshipsTruncated?: boolean;
```
In `src/lib/connectors/http.ts`, change the `ConnectorHttp` method union from `"GET" | "POST" | "PUT" | "PATCH"` to `"GET" | "POST" | "PUT" | "PATCH" | "DELETE"` (the underlying `fetch` already accepts any method; this is a type-only widening — the retry/timeout logic is method-agnostic).

- [ ] **Step 4: Run it — verify it passes** (+ `tsc`)

Run: `npx vitest run --maxWorkers=4 tests/unit/connector-types-scholarship.test.ts && npx tsc --noEmit`
Expected: PASS + 0 type errors (the vacancy path still compiles — `JobPushResult` untouched).

- [ ] **Step 5: Commit**

```bash
git add src/lib/connectors/types.ts src/lib/connectors/http.ts tests/unit/connector-types-scholarship.test.ts
git commit -m "feat(scholarship-hub): connector types for scholarship push + DELETE method"
```

---

### Task 6: Mapping builder — `toHubScholarshipPayload`

**Files:**
- Create: `src/lib/connectors/scholarship-hub-mapping.ts`
- Test: `tests/unit/scholarship-hub-mapping.test.ts`

**Interfaces:**
- Consumes: the enriched `Scholarship` doc shape (Task 3); the vendored vocabulary (Task 1).
- Produces: `toHubScholarshipPayload(scholarship, classOrCourse?): Record<string, unknown>` — the exact body IDAP sends to `PUT /api/partner/scholarships/:externalRef`. Consumed by Task 8.

- [ ] **Step 1: Write the failing (mutation-distinguishing) test**

`tests/unit/scholarship-hub-mapping.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toHubScholarshipPayload } from "@/lib/connectors/scholarship-hub-mapping";

const doc = {
  name: "Infinity Merit", summary: "Merit award", description: "x".repeat(220),
  categories: ["merit"], amount: "Up to ₹50,000",
  benefits: { amountMin: 10000, tuitionWaiver: true },
  criteria: "Top 10% of the class\nResident of Karnataka",
  eligibility: { stateCodes: ["KA"], genders: ["female"] },
  applicationMode: "platform",
  requiredDocuments: [{ key: "marksheet", label: "Marksheet", required: true }],
  dates: { closesAt: new Date("2026-12-31T00:00:00.000Z") },
};

describe("toHubScholarshipPayload", () => {
  it("maps name→title, amount→benefits.amountText, criteria→eligibility.otherCriteria, class link→classesOrCourses", () => {
    const p = toHubScholarshipPayload(doc as never, "Grade 10") as Record<string, any>;
    expect(p.title).toBe("Infinity Merit");                       // (a)
    expect(p.benefits.amountText).toBe("Up to ₹50,000");          // (b)
    expect(p.benefits.amountMin).toBe(10000);                     // (c)
    expect(p.eligibility.otherCriteria).toEqual(["Top 10% of the class", "Resident of Karnataka"]); // (d)
    expect(p.eligibility.classesOrCourses).toEqual(["Grade 10"]); // (e)
    expect(p.eligibility.stateCodes).toEqual(["KA"]);             // (f)
    expect(p.applicationMode).toBe("platform");                   // (g)
    expect(p.dates.closesAt).toBe("2026-12-31T00:00:00.000Z");    // (h) Date → ISO
  });
  it("emits no lead/applicant fields and no undefined keys", () => {
    const p = toHubScholarshipPayload(doc as never) as Record<string, unknown>;
    expect(Object.values(p).every((v) => v !== undefined)).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/lead|applicant|phone|email/i);
  });
});
```
> Each lettered assertion pins one mapping line — deleting that line in the builder fails a distinct assertion (mutation-distinguishing per the project rule). Verify by copying the file aside, deleting one mapping line, re-running, restoring from the copy, and confirming shasum.

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-hub-mapping.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the allow-list builder**

`src/lib/connectors/scholarship-hub-mapping.ts`:
```ts
type ScholarshipLike = {
  name: string; summary?: string; description?: string; categories?: string[]; tags?: string[];
  amount?: string; criteria?: string;
  benefits?: { amountMin?: number; amountMax?: number; stipendMonthly?: number; awards?: number; tuitionWaiver?: boolean };
  eligibility?: Record<string, unknown> & { otherCriteria?: string[]; classesOrCourses?: string[] };
  applicationMode?: "platform" | "external"; externalUrl?: string;
  requiredDocuments?: unknown[]; customQuestions?: unknown[]; applicationSteps?: string[];
  dates?: { opensAt?: Date | string; closesAt?: Date | string; resultAt?: Date | string };
  selectionProcess?: string; terms?: string; faqs?: unknown[]; sourceUrl?: string;
};
const iso = (d?: Date | string) => (d == null ? undefined : new Date(d).toISOString());
const dropUndefined = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function toHubScholarshipPayload(s: ScholarshipLike, classOrCourse?: string): Record<string, unknown> {
  const otherCriteria = s.criteria ? s.criteria.split("\n").map((l) => l.trim()).filter(Boolean) : undefined;
  const classesOrCourses = classOrCourse ? [classOrCourse] : (s.eligibility?.classesOrCourses as string[] | undefined);
  return dropUndefined({
    title: s.name,
    summary: s.summary,
    description: s.description,
    categories: s.categories,
    tags: s.tags,
    benefits: dropUndefined({ ...(s.benefits ?? {}), amountText: s.amount || undefined }),
    eligibility: dropUndefined({ ...(s.eligibility ?? {}), otherCriteria: otherCriteria ?? (s.eligibility?.otherCriteria), classesOrCourses }),
    applicationMode: s.applicationMode ?? "platform",
    externalUrl: s.externalUrl,
    requiredDocuments: s.requiredDocuments,
    customQuestions: s.customQuestions,
    applicationSteps: s.applicationSteps,
    dates: s.dates ? dropUndefined({ opensAt: iso(s.dates.opensAt), closesAt: iso(s.dates.closesAt), resultAt: iso(s.dates.resultAt) }) : undefined,
    selectionProcess: s.selectionProcess,
    terms: s.terms,
    faqs: s.faqs,
    sourceUrl: s.sourceUrl,
  });
}
```
> No `institutionId`, `_id`, `status`, `listing`, or any lead/applicant field is ever read — the allow-list is the field set above.

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-hub-mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/connectors/scholarship-hub-mapping.ts tests/unit/scholarship-hub-mapping.test.ts
git commit -m "feat(scholarship-hub): scholarship→Hub payload mapping (allow-list)"
```

---

### Task 7: The adapter — `scholarship-hub.ts`

**Files:**
- Create: `src/lib/connectors/scholarship-hub.ts`
- Modify: `src/lib/connectors/index.ts` — add `import "./scholarship-hub";`
- Test: `tests/unit/scholarship-hub-adapter.test.ts`

**Interfaces:**
- Consumes: `AdapterContext`, `ConnectionState`, `ScholarshipPushResult`, `PlatformAdapter`, the typed errors (Task 5 / types.ts); `registerAdapter` (`./index`).
- Produces: `scholarshipHubAdapter` implementing `platform: "SCHOLARSHIP_HUB"`, `initiate` (provision provider → connected), `sync`, `upsertScholarship`, `withdrawScholarship`; a `classifyScholarshipPush(resp)` helper.

- [ ] **Step 1: Write the failing adapter test** (fake `ConnectorHttp` via `vi.fn()`, mirroring `tests/unit/edufleet-adapter.test.ts`)

`tests/unit/scholarship-hub-adapter.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { scholarshipHubAdapter } from "@/lib/connectors/scholarship-hub";
import type { AdapterContext, ConnectionState } from "@/lib/connectors/types";
import { ConnectorRejectedError, ConnectorCapExceededError } from "@/lib/connectors/types";

const conn: ConnectionState = { institutionId: "INS0001", externalRef: "IDAP:INS0001" };
const REF = "IDAP:INS0001:6a8f1a72017ca1920491b71a";
const ctx = (http: AdapterContext["http"]): AdapterContext => ({ baseUrl: "https://hub.test", platformKey: "sh_pkey_x", http });

describe("scholarshipHubAdapter", () => {
  it("upsert OK → maps hubId/slug/publicUrl and sends PUT with the partner key", async () => {
    const http = vi.fn().mockResolvedValue({ status: 200, body: { hubId: "h1", slug: "infinity-merit", publicUrl: "https://hub.test/scholarships/infinity-merit", remoteStatus: "published" } });
    const r = await scholarshipHubAdapter.upsertScholarship!(ctx(http), conn, REF, { title: "Infinity Merit" });
    expect(r).toEqual({ kind: "OK", hubId: "h1", slug: "infinity-merit", publicUrl: "https://hub.test/scholarships/infinity-merit", remoteStatus: "published" });
    expect(http.mock.calls[0][0]).toBe(`/api/partner/scholarships/${encodeURIComponent(REF)}`);
    expect(http.mock.calls[0][1]).toMatchObject({ method: "PUT", token: "sh_pkey_x", body: { title: "Infinity Merit" } });
  });
  it("upsert 409 → BLOCKED (moderation), 422 → ConnectorRejectedError, 429 → ConnectorCapExceededError", async () => {
    const blocked = await scholarshipHubAdapter.upsertScholarship!(ctx(vi.fn().mockResolvedValue({ status: 409, body: { error: { code: "MODERATION_HOLD", message: "held" } } })), conn, REF, {});
    expect(blocked).toEqual({ kind: "BLOCKED", reason: "MODERATION_HOLD", detail: "held" });
    await expect(scholarshipHubAdapter.upsertScholarship!(ctx(vi.fn().mockResolvedValue({ status: 422, body: { error: { code: "INCOMPLETE", missing: ["closesAt"] } } })), conn, REF, {})).rejects.toBeInstanceOf(ConnectorRejectedError);
    await expect(scholarshipHubAdapter.upsertScholarship!(ctx(vi.fn().mockResolvedValue({ status: 429, body: {} })), conn, REF, {})).rejects.toBeInstanceOf(ConnectorCapExceededError);
  });
  it("withdraw 200 → OK closed; 404 → NOT_FOUND", async () => {
    const ok = await scholarshipHubAdapter.withdrawScholarship!(ctx(vi.fn().mockResolvedValue({ status: 200, body: { hubId: "h1", remoteStatus: "closed" } })), conn, REF);
    expect(ok).toMatchObject({ kind: "OK", remoteStatus: "closed" });
    const gone = await scholarshipHubAdapter.withdrawScholarship!(ctx(vi.fn().mockResolvedValue({ status: 404, body: {} })), conn, REF);
    expect(gone).toEqual({ kind: "NOT_FOUND" });
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-hub-adapter.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the adapter**

First confirm the exact `InitiateResult`/`ConnectResult`/`InstitutionSummary`/`SyncOutcome` shapes in `src/lib/connectors/types.ts` (around lines 75–140) — `initiate` and `sync` must return those discriminated shapes. Then:
`src/lib/connectors/scholarship-hub.ts`:
```ts
import { registerAdapter } from "./index";
import {
  type PlatformAdapter, type AdapterContext, type ConnectionState,
  type ScholarshipPushResult, ConnectorRejectedError, ConnectorCapExceededError,
} from "./types";

const safeUrl = (u: unknown): string | undefined =>
  typeof u === "string" && (u.startsWith("https://") || u.startsWith("http://")) ? u : undefined;

export function classifyScholarshipPush(resp: { status: number; body: unknown }): ScholarshipPushResult {
  const { status, body } = resp;
  if (status >= 200 && status < 300) {
    const b = (body ?? {}) as { hubId?: string; slug?: string; publicUrl?: string; remoteStatus?: string };
    if (!b.hubId) throw new Error("scholarship-hub: OK response without a hubId");
    return { kind: "OK", hubId: b.hubId, slug: String(b.slug ?? ""), publicUrl: safeUrl(b.publicUrl), remoteStatus: b.remoteStatus === "closed" ? "closed" : "published" };
  }
  const err = (body as { error?: { code?: string; message?: string; missing?: unknown } })?.error;
  if (status === 409) return { kind: "BLOCKED", reason: err?.code ?? "moderation_hold", detail: err?.message ?? "" };
  if (status === 422) throw new ConnectorRejectedError("scholarship-hub: listing rejected", err?.code ?? "incomplete", JSON.stringify(err?.missing ?? []));
  if (status === 429) throw new ConnectorCapExceededError("scholarship-hub: write cap exceeded");
  // 401 (bad partner key) and 404 (provider not provisioned) are platform-config
  // problems, surfaced hard to the super-admin — NOT a per-institution disconnect.
  throw new Error(`scholarship-hub: upsert failed (status ${status})`);
}

const path = (externalRef: string) => `/api/partner/scholarships/${encodeURIComponent(externalRef)}`;

async function upsertScholarship(ctx: AdapterContext, _c: ConnectionState, externalRef: string, body: Record<string, unknown>): Promise<ScholarshipPushResult> {
  return classifyScholarshipPush(await ctx.http(path(externalRef), { method: "PUT", token: ctx.platformKey, body }));
}
async function withdrawScholarship(ctx: AdapterContext, _c: ConnectionState, externalRef: string): Promise<ScholarshipPushResult> {
  const resp = await ctx.http(path(externalRef), { method: "DELETE", token: ctx.platformKey });
  if (resp.status === 404) return { kind: "NOT_FOUND" };
  return classifyScholarshipPush(resp);
}

// initiate: provision the institution's Hub provider with the platform key and
// return the CONNECTED-kind result (confirm the discriminant in types.ts).
async function initiate(ctx: AdapterContext, institution: { institutionId: string; name: string; city?: string; stateCode?: string }) {
  await ctx.http("/api/partner/providers", {
    method: "POST", token: ctx.platformKey,
    body: { externalRef: `IDAP:${institution.institutionId}`, name: institution.name, city: institution.city, stateCode: institution.stateCode },
  });
  // return the InitiateResult "connected" variant — shape per types.ts.
  return { kind: "CONNECTED" as const };
}

// sync: reconcile listings for this institution. The connection service passes
// data.scholarships (Task 9). Iterate and call each row's repush/close, returning
// the SyncOutcome shape from types.ts.
async function sync(/* ctx, connection, data */): Promise<unknown> {
  // Implement per the SyncOutcome contract in types.ts (mirror edufleet's sync
  // vacancy loop but over data.scholarships).
  return { steps: [], warnings: [] };
}

export const scholarshipHubAdapter: PlatformAdapter = {
  platform: "SCHOLARSHIP_HUB",
  connectMode: "REQUEST_APPROVE_REDEEM", // immediate: initiate provisions + returns CONNECTED
  initiate: initiate as PlatformAdapter["initiate"],
  sync: sync as PlatformAdapter["sync"],
  upsertScholarship,
  withdrawScholarship,
};
registerAdapter(scholarshipHubAdapter);
```
In `src/lib/connectors/index.ts`, add `import "./scholarship-hub";` beside the existing `import "./passpercent"; import "./edufleet";`.
> Confirm-at-source: the `initiate` return (`{ kind: "CONNECTED" }`) and `sync` return must match the `InitiateResult`/`SyncOutcome` unions in `types.ts`; adjust the literal to the real discriminant. The push methods above are complete and tested by Step 1.

- [ ] **Step 4: Run it — verify it passes** (+ `tsc`)

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-hub-adapter.test.ts && npx tsc --noEmit`
Expected: PASS + 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/connectors/scholarship-hub.ts src/lib/connectors/index.ts tests/unit/scholarship-hub-adapter.test.ts
git commit -m "feat(scholarship-hub): SCHOLARSHIP_HUB adapter (upsert/withdraw/initiate/sync)"
```

---

### Task 8: Publish orchestrator — `scholarship-publish.service.ts`

**Files:**
- Create: `src/services/scholarship-publish.service.ts`
- Test: `tests/integration/scholarship-publish-service.test.ts`

**Interfaces:**
- Consumes: `adapterFor`/`AdapterContext` building (duplicate `buildContext` from `vacancy-publish.service.ts:344-352`, do NOT import `connection.service`); the adapter (Task 7); `toHubScholarshipPayload` (Task 6); typed errors; `Scholarship` model (Task 3); `assertScholarshipHubPublishable` (Task 4).
- Produces: `ScholarshipPublishService` with `publish(institutionId, scholarshipId, actor)`, `repush(...)`, `pushEdit(...)` (never throws), `pushClose(...)`; writes the `listing` sub-doc; sets/clears `listing.blockedReason`.

- [ ] **Step 1: Write the failing service test** (fake adapter registered under `SCHOLARSHIP_HUB`, mirroring `tests/integration/connection-service.test.ts:41-58`)

`tests/integration/scholarship-publish-service.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { Scholarship } from "@/models/Scholarship";
import { registerAdapter, adapterFor } from "@/lib/connectors";
import type { PlatformAdapter } from "@/lib/connectors/types";
import { ScholarshipPublishService } from "@/services/scholarship-publish.service";

let real: PlatformAdapter;
const actor = { id: "u1", name: "Admin" };
const upsert = vi.fn();
const withdraw = vi.fn();

beforeAll(async () => {
  await startTestDatabase("scholarship-publish");
  await Scholarship.syncIndexes();
  real = adapterFor("SCHOLARSHIP_HUB");
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  upsert.mockReset(); withdraw.mockReset();
  registerAdapter({ ...real, upsertScholarship: upsert, withdrawScholarship: withdraw });
  // Assume a CONNECTED SCHOLARSHIP_HUB connection + platform credential are seeded here
  // via the same helpers connection-service.test.ts uses.
});
afterEach(() => registerAdapter(real));

function complete(institutionId: string) {
  return { institutionId, name: "Infinity Merit", status: "PUBLISHED", summary: "Merit", description: "x".repeat(220), categories: ["merit"], amount: "Up to ₹50,000", applicationMode: "platform", requiredDocuments: [{ key: "m", label: "Marksheet", required: true }], dates: { closesAt: new Date(Date.now() + 30 * 864e5) } };
}

describe("ScholarshipPublishService", () => {
  it("publish → upsert records the listing sub-doc", async () => {
    upsert.mockResolvedValue({ kind: "OK", hubId: "h1", slug: "infinity-merit", publicUrl: "https://hub.test/scholarships/infinity-merit", remoteStatus: "published" });
    const s = await Scholarship.create(complete("INS0001"));
    await ScholarshipPublishService.publish("INS0001", String(s._id), actor);
    const stored = await Scholarship.findById(s._id).lean();
    expect(stored?.listing?.hubId).toBe("h1");
    expect(stored?.listing?.remoteStatus).toBe("published");
    expect(upsert).toHaveBeenCalledOnce();
  });
  it("a BLOCKED push records blockedReason and does not throw", async () => {
    upsert.mockResolvedValue({ kind: "BLOCKED", reason: "MODERATION_HOLD", detail: "held" });
    const s = await Scholarship.create(complete("INS0001"));
    await ScholarshipPublishService.publish("INS0001", String(s._id), actor);
    expect((await Scholarship.findById(s._id).lean())?.listing?.blockedReason).toContain("held");
  });
  it("pushClose → withdraw flips remoteStatus to closed", async () => {
    upsert.mockResolvedValue({ kind: "OK", hubId: "h1", slug: "s", remoteStatus: "published" });
    withdraw.mockResolvedValue({ kind: "OK", hubId: "h1", remoteStatus: "closed" });
    const s = await Scholarship.create(complete("INS0001"));
    await ScholarshipPublishService.publish("INS0001", String(s._id), actor);
    await ScholarshipPublishService.pushClose("INS0001", String(s._id), actor);
    expect((await Scholarship.findById(s._id).lean())?.listing?.remoteStatus).toBe("closed");
  });
  it("pushEdit never throws when the adapter errors", async () => {
    upsert.mockRejectedValue(new Error("boom"));
    const s = await Scholarship.create({ ...complete("INS0001"), listing: { hubId: "h1", externalRef: "IDAP:INS0001:x", slug: "s", remoteStatus: "published", lastPushedAt: new Date() } });
    await expect(ScholarshipPublishService.pushEdit("INS0001", String(s._id), actor)).resolves.not.toThrow();
    expect((await Scholarship.findById(s._id).lean())?.listing?.blockedReason).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-publish-service.test.ts`
Expected: FAIL — service missing.

- [ ] **Step 3: Implement the orchestrator**

Create `src/services/scholarship-publish.service.ts`, mirroring `vacancy-publish.service.ts`'s structure exactly (`callAdapter` classification 292-324, `recordSuccess`/`recordBlockedReason`/`recordPushFailure`, and the never-throw `pushEdit`). Key specifics:
- `PLATFORM = "SCHOLARSHIP_HUB"`; `externalRefOf(institutionId, scholarshipId) = \`IDAP:${institutionId}:${scholarshipId}\``.
- `publish`: load the scholarship (scoped by `institutionId`), `assertScholarshipHubPublishable(doc)`, build the payload via `toHubScholarshipPayload(doc, classOrCourse)`, `callAdapter(() => adapter.upsertScholarship!(ctx, connection, externalRef, payload))`, then `settle` the `ScholarshipPushResult`:
  - `OK` → `$set: { listing: { hubId, externalRef, slug, publicUrl, remoteStatus, lastPushedAt: new Date() } }` and `$unset: { "listing.blockedReason": "" }`.
  - `BLOCKED` → `$set: { "listing.blockedReason": detail || reason, "listing.lastPushedAt": new Date() }` (only if a listing exists; else record on a minimal listing carrying `externalRef`).
  - `NOT_FOUND` (withdraw only) → treat as already-closed success.
- `pushClose`: if no live listing, return `NOT_LISTED` with no HTTP; else `callAdapter(() => adapter.withdrawScholarship!(...))` and `$set: { "listing.remoteStatus": "closed", "listing.lastPushedAt": new Date() }`.
- `repush`: like publish but never creates from scratch beyond an existing listing; `pushEdit` wraps `repush` in try/catch and records `recordPushFailure` (guard the `updateOne` with `listing: { $exists: true }`).
- `callAdapter` classification: `ConnectorCapExceededError` → `AppError("RATE_LIMITED", ...)`; `ConnectorRejectedError` → `validationError(...)`; anything else → `upstreamError()`. **No `ConnectorAuthError` branch** (see ruling #2 — a scholarship-hub 401 is a hard upstream error, not a per-institution disconnect).
- Duplicate `buildContext()` (decrypt platform credential → `AdapterContext`) and the connection lookup from the connection service rather than importing it (one-way dependency, per the caveat in the conventions report).

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-publish-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/scholarship-publish.service.ts tests/integration/scholarship-publish-service.test.ts
git commit -m "feat(scholarship-hub): scholarship publish/repush/withdraw orchestrator"
```

---

### Task 9: Wire the domain — service hooks + sync worklist

**Files:**
- Modify: `src/services/scholarship.service.ts`
- Modify: `src/services/connection.service.ts`
- Test: `tests/integration/scholarship-service-push.test.ts`; extend `tests/integration/connection-service.test.ts`

**Interfaces:**
- Consumes: `ScholarshipPublishService` (Task 8).
- Produces: `ScholarshipService.setStatus` calls `publish`/`pushClose`; `update` calls `pushEdit`; `remove` calls `pushClose` before delete. `connection.service.syncNow` populates `SyncSourceData.scholarships` for an adapter with `upsertScholarship && withdrawScholarship`.

- [ ] **Step 1: Write the failing wiring test**

`tests/integration/scholarship-service-push.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { ScholarshipService } from "@/services/scholarship.service";
import { ScholarshipPublishService } from "@/services/scholarship-publish.service";

beforeAll(() => startTestDatabase("scholarship-service-push"));
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("ScholarshipService push hooks", () => {
  it("setStatus(publish) calls the publish service; setStatus(unpublish) calls pushClose", async () => {
    const publish = vi.spyOn(ScholarshipPublishService, "publish").mockResolvedValue(undefined as never);
    const pushClose = vi.spyOn(ScholarshipPublishService, "pushClose").mockResolvedValue(undefined as never);
    // create a complete, publishable scholarship for INS0001 (seed institution/unit as the crud test does)
    const created = await ScholarshipService.create("INS0001", { name: "Infinity Merit", /* + structured fields to pass the gate */ } as never, { id: "u1", name: "Admin" });
    await ScholarshipService.setStatus("INS0001", created.id, "publish", { id: "u1", name: "Admin" });
    expect(publish).toHaveBeenCalledWith("INS0001", created.id, expect.anything());
    await ScholarshipService.setStatus("INS0001", created.id, "unpublish", { id: "u1", name: "Admin" });
    expect(pushClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-service-push.test.ts`
Expected: FAIL — no publish call.

- [ ] **Step 3: Hook the publish service into `ScholarshipService`**

In `src/services/scholarship.service.ts` (import `ScholarshipPublishService`; note the one-way direction — publish service must not import scholarship service):
- `setStatus` (242-282): after the local status write, on `publish` call `await ScholarshipPublishService.publish(institutionId, id, actor)`; on `unpublish`/`archive` call `await ScholarshipPublishService.pushClose(institutionId, id, actor)`. Follow how vacancy status routes into publish/pushClose. Wrap the publish call so a hard connector error surfaces to the caller, but note `pushEdit` is the non-throwing path.
- `update` (201-240): after the local `$set`, if the doc is (or becomes) PUBLISHED, `await ScholarshipPublishService.pushEdit(institutionId, id, actor)` (never throws).
- `remove` (284-304): before `deleteOne`, `await ScholarshipPublishService.pushClose(institutionId, id, actor)` so the Hub listing is withdrawn.

- [ ] **Step 4: Extend `connection.service.syncNow` with a scholarship worklist**

In `src/services/connection.service.ts` (mirror `reconcilesVacancies` at line 793 and `loadSyncVacancies` at 245-297):
```ts
const reconcilesScholarships = Boolean(adapter.upsertScholarship && adapter.withdrawScholarship);
```
Add `loadSyncScholarships(institutionId, actor)` — a bounded `Scholarship.find({ institutionId }).select("name status listing").sort({ createdAt: 1, _id: 1 }).limit(N + 1)`, mapping each to a `SyncScholarship` whose `repush`/`close` wrap `ScholarshipPublishService.repush`/`pushClose` through a `runScholarshipAction` helper (mirror `runVacancyAction` 195-222, scope `>=500 || 429` as `"RUN"`). Spread `{ scholarships, scholarshipsTruncated }` into `sourceData` when `reconcilesScholarships`.

- [ ] **Step 5: Run the wiring + connection tests**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-service-push.test.ts tests/integration/connection-service.test.ts`
Expected: PASS. Add a `connection-service.test.ts` case asserting a fake adapter with `upsertScholarship+withdrawScholarship` receives a populated `data.scholarships` (mirror the existing vacancies-worklist capture test).

- [ ] **Step 6: Commit**

```bash
git add src/services/scholarship.service.ts src/services/connection.service.ts tests/integration/scholarship-service-push.test.ts tests/integration/connection-service.test.ts
git commit -m "feat(scholarship-hub): wire publish hooks + scholarship sync worklist"
```

---

### Task 10: UI — structured editor + publish affordance + opt-in

**Files:**
- Modify: `src/components/scholarships/scholarship-form.tsx` — structured fields
- Modify: `src/components/scholarships/scholarship-actions.tsx` — "Publish to Scholarship Hub" + listing state
- Test: `tests/unit/scholarship-form.test.tsx` (or the project's component-test location)

**Interfaces:**
- Consumes: enriched schemas (Task 4); the scholarship publish route/DTO. Mirrors `vacancies-section.tsx:376-440` (`ListingPanel`).

- [ ] **Step 1: Write a failing component/render test**

`tests/unit/scholarship-form.test.tsx` (follow the project's existing component-test setup; if none exists for forms, add a minimal render test):
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScholarshipForm } from "@/components/scholarships/scholarship-form";

describe("ScholarshipForm structured fields", () => {
  it("renders the new structured inputs", () => {
    render(<ScholarshipForm initialScholarship={null} units={[]} /* + required props */ />);
    expect(screen.getByLabelText(/summary/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/closing date|closes/i)).toBeInTheDocument();
    expect(screen.getByText(/required documents/i)).toBeInTheDocument();
  });
});
```
> If IDAP has no React component test harness yet, this task's test may instead assert the form's Zod default shape includes the new fields; keep it small and confirm the project's convention first.

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-form.test.tsx`
Expected: FAIL — fields not rendered.

- [ ] **Step 3: Extend the editor**

In `src/components/scholarships/scholarship-form.tsx`, add grouped inputs for the structured fields (basics: summary/description/categories/tags; benefits: amountMin/Max/stipend/awards/tuitionWaiver; eligibility: state/district/level/stream/gender/community/age/percentage/income multi-selects; application: mode/requiredDocuments/customQuestions/steps; dates: opens/closes/result; details: selectionProcess/terms/faqs/sourceUrl), driven by RHF like the existing `academicUnitId` Select. Multi-selects source their options from the vendored vocabulary (Task 1). Keep the existing `name`/`amount`/`criteria`/`academicUnitId` fields.

- [ ] **Step 4: Surface listing state in the actions**

In `src/components/scholarships/scholarship-actions.tsx`, add a "Publish to Scholarship Hub" control and a listing panel mirroring `vacancies-section.tsx`'s `ListingPanel` (376-440): a "Live/Closed on Scholarship Hub" badge from `listing.remoteStatus`, `listing.publicUrl` as an `<a target="_blank" rel="noopener noreferrer">`, and `listing.blockedReason` printed **verbatim** in a destructive `<p>`. The publish control POSTs the existing scholarship publish route (`/api/settings/scholarships/{id}/publish`).
> The `connections-panel.tsx` needs no change — it renders whatever `ConnectionEntry[]` the server builds, and `SCHOLARSHIP_HUB` flows in from the `PLATFORMS` enum (Task 2). Confirm the server-side connection list builder includes the new platform; if it hard-codes platforms, add `SCHOLARSHIP_HUB` there.

- [ ] **Step 5: Run it — verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-form.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full suite + typecheck + lint, then commit**

```bash
npx vitest run --maxWorkers=4
npx tsc --noEmit
npx eslint .
git add src/components/scholarships/ tests/unit/scholarship-form.test.tsx
git commit -m "feat(scholarship-hub): structured scholarship editor + Hub publish affordance"
```

---

## Self-Review

**Spec coverage (Plan 1B scope = spec §5, §7, IDAP half of §8/§9/§10/§11):**
- §5.1 structured fields → Task 3 (model) + Task 4 (validation). §5.2 vendored vocabulary + subset → Task 1. §5.3 field mapping (name→title, amount→amountText, criteria→otherCriteria, class→classesOrCourses) → Task 6. §5.4 local publish gate + parity → Task 4. §7.1 platform enum → Task 2. §7.2 adapter → Task 7. §7.3 mapping allow-list → Task 6. §7.4 orchestrator → Task 8. §7.5 immediate connect → Task 7 `initiate`. §7.6 listing sub-doc + public-projection exclusion → Task 3. §7.7 sync worklist → Task 9. §7.8 UI → Task 10. §7.9 result taxonomy → Task 5 (as ruling #1, a parallel type). §8 failure handling → Task 8 (with ruling #2). §11 security (allow-list/no PII, consent-gated, tenant-scoped) → Tasks 6/8/9. **No gaps.**
- **Depends on Plan 1A** (Hub `/api/partner/*`): build 1A first.

**Placeholder scan:** the confirm-at-source notes each name an exact file/line to check — the KA district codes (Task 1, from the Hub data file), the `InitiateResult`/`SyncOutcome` discriminants (Task 7, from `types.ts`), the connection-list builder platform set (Task 10), and the React component-test convention (Task 10). The one genuinely deferred body is Task 8's `scholarship-publish.service.ts` internals, which are specified as "mirror `vacancy-publish.service.ts` at these exact line ranges with these exact `$set`/`$unset` operations" — a transcription task against a named template, not a vague instruction. Task 9's service internals are likewise pinned to exact line ranges + operations.

**Type consistency:** `ScholarshipPushResult` defined in Task 5, consumed in Tasks 7/8. `SyncScholarship`/`SyncSourceData.scholarships` defined in Task 5, consumed in Task 9. `scholarshipHubMissingFields`/`assertScholarshipHubPublishable` defined in Task 4, consumed in Task 8. `toHubScholarshipPayload(s, classOrCourse?)` defined in Task 6, consumed in Task 8. Vendored `HUB_*` constants defined in Task 1, consumed in Tasks 3/4/6/10. `externalRef` format `IDAP:{institutionId}:{scholarshipId}` consistent across Tasks 5–9 and Plan 1A. `SCHOLARSHIP_HUB` platform + `SCHOLARSHIP_LISTING_REMOTE_STATUSES` defined in Task 2, used in Tasks 3/7/8/9.

