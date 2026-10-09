# Scholarship Hub Applications Sync-Back — Plan 2A (Hub Sending Surface) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Scholarship Hub (`/Users/automicai/scholarship-hub`) a partner-facing surface that lets IDAP retrieve platform-mode scholarship applications (list-since-cursor + per-document streaming) and be notified of application changes via a signed webhook, so Plan 2B's IDAP connector has something real to pull from and push to.

**Architecture:** Six tasks in two chains. Chain A (inbound-facing, Tasks 1–3): denormalize `partnerId` onto `Application` so every partner query can be scoped and indexed, then a cursor-paginated applications-list endpoint and a document-streaming endpoint, both behind the existing `requirePartner` gate. Chain B (outbound-facing, Tasks 4–6): let a partner register a webhook URL and receive a one-time signing secret, add a `PartnerWebhookDelivery` outbox with a signed, backed-off delivery worker (a CLI job, mirroring the existing `runJob.ts` convention), and finally wire a thin "application changed" emit hook into the two lifecycle transitions that matter (submit, withdraw). Task 6 is the join point — it depends on Task 1's `partnerId` field and Task 5's enqueue function.

**Tech Stack:** Express 5, Mongoose 8, Zod 4, Vitest, Node ≥24 (real local mongod for tests — `sh_test_*` scratch DBs, not mongodb-memory-server), `node:crypto` (`createHmac`, `randomBytes`), global `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-06-scholarship-hub-applications-syncback-design.md` (§3 "Hub sending surface" is what this plan implements; §5 "Security & trust model" and §6 "Data flow, idempotency & failure handling" bind every task).

## Global Constraints

- Work only inside `/Users/automicai/scholarship-hub`. Never touch IDAP (`/Users/automicai/AEMPlatform`) — that is Plan 2B, a separate repo and a separate plan.
- Every new partner-facing endpoint sits behind the existing `requirePartner` middleware (`apps/api/src/middleware/partner-auth.ts`) — no exceptions.
- Every partner query MUST scope by `partnerId` (or, for documents, by an application already scoped to `partnerId`) — a partner must never be able to read another partner's applicants, scholarships, or documents. This is the single most important property in this plan; every task's tests must include a cross-partner isolation case.
- Documents are streamed through an application's own `documents[].key` slot, never a raw document id (mirrors the existing provider-side document route).
- The webhook payload is a **thin ping only**: `{ event: "application.changed", externalRef, hubApplicationId, changedAt }` — never the full application body. IDAP always re-pulls current state from the list/detail endpoint.
- The emit hook must never fail or delay the local action it is attached to (a student's submit/withdraw). Every call site wraps it in `.catch(...)`.
- Run the API suite from `/Users/automicai/scholarship-hub` with `npm run test -w @scholarship-hub/api` (or `cd apps/api && npx vitest run`) — tests use a real local mongod at `127.0.0.1:27017` with a fresh scratch DB per file; no `--maxWorkers` flag is needed here (that constraint is IDAP-specific, not the Hub's).
- Node ≥24 required (`nvm use 24.16.0` if not already active — check with `node -v` before running anything).
- No placeholders, no invented function names across tasks — every task's "Produces" block is the literal name and signature the next task imports.

---

### Task 1: Denormalize `partnerId` onto `Application` at creation, index it, and backfill existing rows

**Files:**
- Modify: `apps/api/src/modules/applications/application.model.ts`
- Modify: `apps/api/src/modules/applications/application.service.ts`
- Create: `scripts/backfill-application-partner-id.ts`
- Test: `apps/api/src/modules/applications/application.model-fields.test.ts`
- Test: `scripts/backfill-application-partner-id.test.ts`
- Modify (test): `apps/api/src/modules/applications/application.test.ts`

**Interfaces:**
- Produces: `ApplicationDoc.partnerId?: Types.ObjectId` (the field every later task in this plan queries and reads); the compound index `{ partnerId: 1, updatedAt: 1, _id: 1 }` (the exact index Task 2's cursor query needs); `runBackfillApplicationPartnerId(): Promise<{ scanned: number; updated: number }>` exported from the new script (Task 2/3 do not consume this directly, but it must exist and be correct before deploy).
- Consumes: nothing new — only the existing `ScholarshipModel`/`ApplicationModel`.

- [ ] **Step 1: Write the failing model-field test**

Create `apps/api/src/modules/applications/application.model-fields.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { ApplicationModel } from './application.model';
import { ScholarshipModel } from '../scholarships/scholarship.model';
import { ProviderModel } from '../providers/provider.model';
import { UserModel } from '../users/user.model';

async function makePartnerOwnedFixtures(partnerId: Types.ObjectId) {
  const provider = await ProviderModel.create({
    name: 'Infinity School', slug: `infinity-${Date.now()}-${Math.random()}`, type: 'trust',
    externalRef: `IDAP:INS${Date.now()}`, partnerId, partnerTrusted: true, verificationStatus: 'verified',
  });
  const scholarship = await ScholarshipModel.create({
    providerId: provider._id, partnerId,
    externalRef: `IDAP:INS${Date.now()}:${new Types.ObjectId().toHexString()}`,
    title: 'Partner Merit Scholarship', slug: `partner-merit-${Date.now()}-${Math.random()}`,
    status: 'published',
  });
  const student = await UserModel.create({
    email: `partner-app-${Date.now()}@example.com`, passwordHash: 'not-a-real-hash',
    role: 'student', name: 'Partner Applicant', mobile: '9876500000',
  });
  return { provider, scholarship, student };
}

describe('Application.partnerId', () => {
  it('is set on the schema and queryable via the (partnerId, updatedAt, _id) index', async () => {
    const partnerId = new Types.ObjectId();
    const { scholarship, student } = await makePartnerOwnedFixtures(partnerId);

    const application = await ApplicationModel.create({
      scholarshipId: scholarship._id,
      studentUserId: student._id,
      providerId: scholarship.providerId,
      partnerId,
      scholarshipTitle: scholarship.title,
      scholarshipSlug: scholarship.slug,
      status: 'draft',
    });

    const found = await ApplicationModel.findOne({ partnerId }).lean<{ partnerId?: Types.ObjectId } | null>();
    expect(String(found?.partnerId)).toBe(String(partnerId));

    const indexes = await ApplicationModel.collection.indexes();
    const cursorIndex = indexes.find(
      (idx) => JSON.stringify(idx.key) === JSON.stringify({ partnerId: 1, updatedAt: 1, _id: 1 }),
    );
    expect(cursorIndex).toBeDefined();

    // An application with no partnerId (a non-partner scholarship) must never
    // match a partner-scoped query — this is the isolation guarantee every
    // later task's tests build on.
    const otherStudent = await UserModel.create({
      email: `plain-app-${Date.now()}@example.com`, passwordHash: 'not-a-real-hash',
      role: 'student', name: 'Plain Applicant', mobile: '9876500001',
    });
    const nonPartnerScholarship = await ScholarshipModel.create({
      providerId: scholarship.providerId, title: 'Non-Partner Scholarship',
      slug: `non-partner-${Date.now()}-${Math.random()}`, status: 'published',
    });
    await ApplicationModel.create({
      scholarshipId: nonPartnerScholarship._id, studentUserId: otherStudent._id,
      providerId: nonPartnerScholarship.providerId,
      scholarshipTitle: nonPartnerScholarship.title, scholarshipSlug: nonPartnerScholarship.slug,
      status: 'draft',
    });

    expect(await ApplicationModel.countDocuments({ partnerId })).toBe(1);
    expect(application.partnerId).toBeUndefined(); // stale reference from before create() ran server-side default; re-fetch instead:
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/applications/application.model-fields.test.ts`
Expected: FAIL — `partnerId` is not a recognized schema path (Mongoose silently drops it, so `found?.partnerId` is `undefined`, and the index lookup finds nothing).

Before writing the implementation, delete the last assertion `expect(application.partnerId).toBeUndefined();` from the test above — it was left in to make Step 2's failure legible (the in-memory `application` object never had `partnerId` set because Mongoose strips unknown paths before save) but it would also pass trivially once the field is real and undefined isn't the point being tested. Keep only the `findOne`/index/isolation assertions.

- [ ] **Step 3: Add the field, interface, and index**

In `apps/api/src/modules/applications/application.model.ts`, add the field immediately after `providerId` (inside the schema definition):

```typescript
    /** Denormalised from the scholarship so Plan 3's provider queries need no join. */
    providerId: { type: Schema.Types.ObjectId, required: true, ref: 'Provider' },
    /**
     * Denormalised from the scholarship's own `partnerId` at creation time
     * (Sync-Back Plan 2A). Absent on every application to a non-partner
     * scholarship. This is what lets the partner applications-list endpoint
     * scope and index a query without joining Scholarship on every read —
     * exactly the same reasoning `providerId` above already documents.
     */
    partnerId: { type: Schema.Types.ObjectId, ref: 'Partner' },
```

Add the matching field to the `ApplicationDoc` interface, right after `providerId: Types.ObjectId;`:

```typescript
  providerId: Types.ObjectId;
  partnerId?: Types.ObjectId;
```

Add the compound index near the other `providerId`-scoped indexes (after the line `applicationSchema.index({ providerId: 1, status: 1 });`):

```typescript
/**
 * Sync-Back Plan 2A's applications-since-cursor scan: every field of the
 * cursor's own sort order, in order, so the ascending (updatedAt, _id) walk
 * a partner's poll performs never falls back to a blocking in-memory sort —
 * see this file's own long comment above the applicantSort indexes for why
 * that ceiling matters.
 */
applicationSchema.index({ partnerId: 1, updatedAt: 1, _id: 1 });
```

- [ ] **Step 4: Wire `partnerId` through `startApplication`**

In `apps/api/src/modules/applications/application.service.ts`, add `partnerId` to the `ScholarshipForApply` interface (around line 240):

```typescript
interface ScholarshipForApply {
  _id: Types.ObjectId;
  providerId: Types.ObjectId;
  partnerId?: Types.ObjectId;
  title: string;
  slug: string;
  applicationMode: ApplicationMode;
  externalUrl?: string;
  dates?: { opensAt?: Date; closesAt?: Date };
  customQuestions?: CustomQuestion[];
  requiredDocuments?: RequiredDocument[];
}
```

Add `partnerId: 1` to `SCHOLARSHIP_FOR_APPLY_PROJECTION`:

```typescript
const SCHOLARSHIP_FOR_APPLY_PROJECTION = {
  _id: 1,
  providerId: 1,
  partnerId: 1,
  title: 1,
  slug: 1,
  applicationMode: 1,
  externalUrl: 1,
  'dates.opensAt': 1,
  'dates.closesAt': 1,
  customQuestions: 1,
  requiredDocuments: 1,
} as const;
```

In `startApplication`'s `ApplicationModel.create({...})` call, add `partnerId` right after `providerId`:

```typescript
    created = await ApplicationModel.create({
      scholarshipId: target,
      studentUserId: owner,
      providerId: scholarship.providerId,
      ...(scholarship.partnerId !== undefined ? { partnerId: scholarship.partnerId } : {}),
      scholarshipTitle: scholarship.title,
      scholarshipSlug: scholarship.slug,
      status: 'draft',
      answers: {},
      documents: [],
      timeline: [{ status: 'draft', at: now, byUserId: owner, byRole: 'student' }],
    });
```

(`restartApplication` needs no change — it only `$set`s `status` and `$unset`s a few fields on the *existing* row; `partnerId`, set once at creation, is never touched by a restart.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/applications/application.model-fields.test.ts`
Expected: PASS

- [ ] **Step 6: Add a service-level test proving `startApplication` denormalizes `partnerId`**

In `apps/api/src/modules/applications/application.test.ts`, add this test inside the existing `describe('POST /api/student/applications', ...)` block, right after the `'audits the start'` test:

```typescript
  it('denormalises partnerId from a partner-owned scholarship, and leaves it unset otherwise', async () => {
    const partnerId = new Types.ObjectId();
    const provider = await makeProvider();
    const partnerScholarship = await makeScholarship(provider._id, { partnerId });
    const plainScholarship = await makeScholarship(provider._id);

    const student = await registerStudent();
    const withPartner = applicationOf((await start(student.token, String(partnerScholarship._id)).expect(201)).body);
    const otherStudent = await registerStudent();
    const withoutPartner = applicationOf(
      (await start(otherStudent.token, String(plainScholarship._id)).expect(201)).body,
    );

    const partnerRow = await ApplicationModel.findById(withPartner.id).lean<{ partnerId?: Types.ObjectId } | null>();
    const plainRow = await ApplicationModel.findById(withoutPartner.id).lean<{ partnerId?: Types.ObjectId } | null>();
    expect(String(partnerRow?.partnerId)).toBe(String(partnerId));
    expect(plainRow?.partnerId).toBeUndefined();
  });
```

Run: `cd apps/api && npx vitest run src/modules/applications/application.test.ts`
Expected: PASS (this file's whole suite, including the new test)

- [ ] **Step 7: Write the failing backfill test**

Create `scripts/backfill-application-partner-id.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { ApplicationModel } from '../apps/api/src/modules/applications/application.model';
import { ScholarshipModel } from '../apps/api/src/modules/scholarships/scholarship.model';
import { ProviderModel } from '../apps/api/src/modules/providers/provider.model';
import { UserModel } from '../apps/api/src/modules/users/user.model';
import { runBackfillApplicationPartnerId } from './backfill-application-partner-id';

async function makeProvider() {
  return ProviderModel.create({ name: 'Backfill Trust', slug: `backfill-${Date.now()}-${Math.random()}`, type: 'trust', verificationStatus: 'verified' });
}
async function makeStudent() {
  return UserModel.create({ email: `backfill-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x', role: 'student', name: 'Backfill Student', mobile: '9876500002' });
}

describe('runBackfillApplicationPartnerId', () => {
  it('sets partnerId on applications whose scholarship has one, and leaves the rest untouched', async () => {
    const partnerId = new Types.ObjectId();
    const provider = await makeProvider();

    const partnerScholarship = await ScholarshipModel.create({
      providerId: provider._id, partnerId, title: 'Backfill Partner Scholarship',
      slug: `bf-partner-${Date.now()}`, status: 'published',
    });
    const plainScholarship = await ScholarshipModel.create({
      providerId: provider._id, title: 'Backfill Plain Scholarship',
      slug: `bf-plain-${Date.now()}`, status: 'published',
    });

    const studentA = await makeStudent();
    const studentB = await makeStudent();
    const needsBackfill = await ApplicationModel.create({
      scholarshipId: partnerScholarship._id, studentUserId: studentA._id, providerId: provider._id,
      scholarshipTitle: partnerScholarship.title, scholarshipSlug: partnerScholarship.slug, status: 'submitted',
    }); // created directly, bypassing startApplication — simulates a pre-Plan-2A row
    const alreadyPlain = await ApplicationModel.create({
      scholarshipId: plainScholarship._id, studentUserId: studentB._id, providerId: provider._id,
      scholarshipTitle: plainScholarship.title, scholarshipSlug: plainScholarship.slug, status: 'submitted',
    });

    const result = await runBackfillApplicationPartnerId();
    expect(result).toEqual({ scanned: 1, updated: 1 });

    const backfilled = await ApplicationModel.findById(needsBackfill._id).lean<{ partnerId?: Types.ObjectId } | null>();
    expect(String(backfilled?.partnerId)).toBe(String(partnerId));
    const untouched = await ApplicationModel.findById(alreadyPlain._id).lean<{ partnerId?: Types.ObjectId } | null>();
    expect(untouched?.partnerId).toBeUndefined();

    // Idempotent: running it again scans nothing new to update.
    const second = await runBackfillApplicationPartnerId();
    expect(second).toEqual({ scanned: 0, updated: 0 });
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `cd apps/api && npx vitest run` will not pick this up (it is outside `apps/api`, which has its own `vitest.config.ts` scoped to `src/**/*.test.ts`). Run it directly with the root workspace's vitest — check `package.json`'s root `"test"` script (`npm run test --workspaces --if-present`) and confirm whether the root or `scripts/` has its own vitest config; if not, add one. Read `scripts/tsconfig.json` (referenced by the root `typecheck` script) to see if a `scripts/vitest.config.ts` already exists. If none exists, create `scripts/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['**/*.test.ts'], testTimeout: 20000, hookTimeout: 30000 },
});
```

And add a `"test": "vitest run"` script to a new `scripts/package.json` only if `scripts/` is not already part of the `apps/api` workspace's test run — verify first with `cd scripts && npx vitest run backfill-application-partner-id.test.ts --config ./vitest.config.ts` (creating the config next to the test file if needed). This step's real content is verifying at source how the existing `scripts/journeys/*.ts` files are exercised (they are NOT run under vitest — they're standalone CLI journeys per `journey:*` package.json scripts) and confirming there is no existing test harness for `scripts/` before inventing one. If `scripts/` genuinely has no test runner, run the new test directly against the API workspace's mongo/env instead by moving the test to live alongside its script but importing it as `apps/api/src/modules/applications/backfill-application-partner-id.test.ts` and adjusting the script's own location decision below (Step 9) accordingly — the constraint that matters is that this test runs against the same real local mongod every other Hub test uses, not its exact folder.

Expected: FAIL with "Cannot find module './backfill-application-partner-id'" (the script does not exist yet).

- [ ] **Step 9: Implement the backfill script**

Create `scripts/backfill-application-partner-id.ts`:

```typescript
/**
 * Ops CLI: one-time backfill for Sync-Back Plan 2A's `Application.partnerId`
 * denormalisation.
 *
 *     npm run backfill:application-partner-id
 *
 * Every application created via `startApplication` AFTER Plan 2A ships already
 * carries `partnerId` (copied from its scholarship at creation). This script
 * fixes up applications that existed BEFORE that change: for every scholarship
 * that has a `partnerId`, it sets the same `partnerId` on every application to
 * that scholarship which does not have one yet.
 *
 * Idempotent — running it twice touches nothing the second time, because the
 * update query itself excludes rows that already have `partnerId` set.
 *
 * Uses the app's own `connectDb`/`disconnectDb`, exactly like
 * `mint-partner-key.ts`, so the URI and options always match what the API
 * itself would use.
 */
import { pathToFileURL } from 'node:url';
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../apps/api/src/lib/db';
import { ApplicationModel } from '../apps/api/src/modules/applications/application.model';
import { ScholarshipModel } from '../apps/api/src/modules/scholarships/scholarship.model';

export async function runBackfillApplicationPartnerId(): Promise<{ scanned: number; updated: number }> {
  const partnerScholarships = await ScholarshipModel.find(
    { partnerId: { $exists: true } },
    { _id: 1, partnerId: 1 },
  ).lean<{ _id: Types.ObjectId; partnerId: Types.ObjectId }[]>();

  let scanned = 0;
  let updated = 0;
  for (const scholarship of partnerScholarships) {
    const result = await ApplicationModel.updateMany(
      { scholarshipId: scholarship._id, partnerId: { $exists: false } },
      { $set: { partnerId: scholarship.partnerId } },
    );
    scanned += result.matchedCount;
    updated += result.modifiedCount;
  }
  return { scanned, updated };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  connectDb()
    .then(async () => {
      const result = await runBackfillApplicationPartnerId();
      console.log(JSON.stringify(result));
      await disconnectDb();
    })
    .catch((err: unknown) => {
      console.error('FAILED:', err);
      process.exit(1);
    });
}
```

Place the test file at `scripts/backfill-application-partner-id.test.ts` as written in Step 7, run it against the mechanism confirmed in Step 8 (most likely: it already runs correctly if `scripts/` is included by the root workspace's `npm run test --workspaces --if-present`, since npm workspaces run each package's own `test` script — verify whether `scripts/` is declared as a workspace in the root `package.json`'s `"workspaces"` array; if it is not, the pragmatic fix consistent with existing conventions is to add a minimal `scripts/package.json` with a `"test": "vitest run"` script and a `scripts/vitest.config.ts` as drafted in Step 8, and register `scripts` in the root `"workspaces"` array next to `apps/*`/`packages/*` if it is not already covered by a glob).

Add the `package.json` script entry (root `package.json`, alongside the other `journey:*`/`mint:partner-key` entries):

```json
    "backfill:application-partner-id": "tsx scripts/backfill-application-partner-id.ts"
```

- [ ] **Step 10: Run test to verify it passes**

Run: `cd scripts && npx vitest run backfill-application-partner-id.test.ts` (or the equivalent command confirmed in Step 8/9)
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/modules/applications/application.model.ts \
        apps/api/src/modules/applications/application.service.ts \
        apps/api/src/modules/applications/application.model-fields.test.ts \
        apps/api/src/modules/applications/application.test.ts \
        scripts/backfill-application-partner-id.ts \
        scripts/backfill-application-partner-id.test.ts \
        package.json
git commit -m "feat(applications): denormalise partnerId + backfill (sync-back 2A/1)"
```

---

### Task 2: `GET /api/partner/applications` — cursor-paginated applications list

**Files:**
- Create: `apps/api/src/modules/partner/partner.applications.service.ts`
- Modify: `apps/api/src/modules/partner/partner.validation.ts`
- Modify: `apps/api/src/modules/partner/partner.routes.ts`
- Test: `apps/api/src/modules/partner/partner.applications.test.ts`

**Interfaces:**
- Consumes: `ApplicationModel`, `ApplicationDoc` (Task 1's `partnerId` field and the `{partnerId,updatedAt,_id}` index), `SUBMITTED_APPLICATION_STATUSES` (from `apps/api/src/modules/documents/document.service.ts`), `DocumentModel`/`DOCUMENT_FILE_PROJECTION`-adjacent read of `label`/`originalName`/`mimeType`, `ScholarshipModel`, `requirePartner`/`PartnerLocals`, `validate`.
- Produces: `listPartnerApplications(partnerId: string, query: {since?: string; limit: number}): Promise<{items: PartnerApplicationDTO[]; nextCursor: string | null}>` and the `PartnerApplicationDTO`/`PartnerApplicationDocumentDTO` types — Plan 2B's IDAP connector consumes this exact response shape over HTTP; `listApplicationsQuerySchema` (Zod) exported from `partner.validation.ts`.

- [ ] **Step 1: Write the failing route test**

Create `apps/api/src/modules/partner/partner.applications.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../app';
import { startTestServer, stopTestServer } from '../../test/setup';
import { PartnerModel } from './partner.model';
import { ProviderModel } from '../providers/provider.model';
import { ScholarshipModel } from '../scholarships/scholarship.model';
import { ApplicationModel } from '../applications/application.model';
import { UserModel } from '../users/user.model';
import { generatePartnerKey } from '../../lib/partner-key';

let server: Server;
beforeAll(async () => { server = await startTestServer(createApp()); });
afterAll(async () => { await stopTestServer(server); });

async function makePartner(name = 'IDAP') {
  const { key, keyHash } = generatePartnerKey();
  const p = await PartnerModel.create({ name, keyHash });
  return { key, id: p._id };
}
const auth = (key: string) => `Bearer ${key}`;

async function makeSubmittedApplication(partnerId: Types.ObjectId, overrides: Record<string, unknown> = {}) {
  const provider = await ProviderModel.create({
    name: 'Infinity School', slug: `infinity-${Date.now()}-${Math.random()}`, type: 'trust',
    externalRef: `IDAP:INS${Date.now()}${Math.floor(Math.random() * 1e6)}`, partnerId, partnerTrusted: true, verificationStatus: 'verified',
  });
  const scholarship = await ScholarshipModel.create({
    providerId: provider._id, partnerId,
    externalRef: `IDAP:${provider.externalRef?.split(':')[1]}:${new Types.ObjectId().toHexString()}`,
    title: 'Merit Grant', slug: `merit-grant-${Date.now()}-${Math.random()}`, status: 'published',
  });
  const student = await UserModel.create({
    email: `applicant-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x',
    role: 'student', name: 'Asha Rao', mobile: '9876543210',
  });
  const application = await ApplicationModel.create({
    scholarshipId: scholarship._id, studentUserId: student._id, providerId: provider._id, partnerId,
    scholarshipTitle: scholarship.title, scholarshipSlug: scholarship.slug,
    status: 'submitted', applicationNo: `SH-2026-${Math.floor(Math.random() * 1e6)}`,
    answers: { why: 'need it' }, documents: [],
    profileSnapshot: { student: { name: 'Asha Rao', email: 'asha@example.com', mobile: '9876543210' } },
    submittedAt: new Date(),
    ...overrides,
  });
  return { provider, scholarship, application };
}

describe('GET /api/partner/applications', () => {
  it('returns only this partner\'s submitted applications, never a draft, never another partner\'s', async () => {
    const partner = await makePartner();
    const other = await makePartner('Other Partner');
    const { scholarship, application } = await makeSubmittedApplication(partner.id);
    await makeSubmittedApplication(other.id); // must never appear

    // A draft (no applicationNo, status draft) for the same partner must also never appear.
    const draftFixture = await makeSubmittedApplication(partner.id, { status: 'draft', applicationNo: undefined, submittedAt: undefined });

    const res = await request(server)
      .get('/api/partner/applications')
      .set('Authorization', auth(partner.key))
      .expect(200);

    const body = res.body as { items: { hubApplicationId: string; externalRef: string }[]; nextCursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.hubApplicationId).toBe(String(application._id));
    expect(body.items[0]?.externalRef).toBe(scholarship.externalRef);
    expect(body.items.some((i) => i.hubApplicationId === String(draftFixture.application._id))).toBe(false);
  });

  it('projects applicant, answers, document metadata and status fields', async () => {
    const partner = await makePartner();
    const { application } = await makeSubmittedApplication(partner.id, {
      documents: [{ key: 'income_certificate', documentId: new Types.ObjectId() }],
    });

    const res = await request(server)
      .get('/api/partner/applications')
      .set('Authorization', auth(partner.key))
      .expect(200);
    const item = (res.body as { items: Array<Record<string, unknown>> }).items[0]!;

    expect(item.applicant).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com', mobile: '9876543210' });
    expect(item.answers).toEqual({ why: 'need it' });
    expect(item.status).toBe('submitted');
    expect((item.applicationNo as string)).toMatch(/^SH-2026-/);
    expect(typeof item.hubUpdatedAt).toBe('string');
    expect(item.documents).toEqual([{ key: 'income_certificate', label: '', filename: '', contentType: 'application/octet-stream' }]);
    void application;
  });

  it('paginates with an ascending (updatedAt, _id) cursor and returns nextCursor only when the page is full', async () => {
    const partner = await makePartner();
    const first = await makeSubmittedApplication(partner.id);
    await new Promise((r) => setTimeout(r, 5));
    const second = await makeSubmittedApplication(partner.id);

    const page1 = await request(server)
      .get('/api/partner/applications?limit=1')
      .set('Authorization', auth(partner.key))
      .expect(200);
    const body1 = page1.body as { items: { hubApplicationId: string }[]; nextCursor: string | null };
    expect(body1.items).toHaveLength(1);
    expect(body1.items[0]?.hubApplicationId).toBe(String(first.application._id));
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await request(server)
      .get(`/api/partner/applications?limit=1&since=${encodeURIComponent(body1.nextCursor!)}`)
      .set('Authorization', auth(partner.key))
      .expect(200);
    const body2 = page2.body as { items: { hubApplicationId: string }[]; nextCursor: string | null };
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0]?.hubApplicationId).toBe(String(second.application._id));
    expect(body2.nextCursor).toBeNull(); // fewer than `limit` left, so no more pages
  });

  it('rejects a malformed cursor with 400, not a 500', async () => {
    const partner = await makePartner();
    await request(server)
      .get('/api/partner/applications?since=not-a-real-cursor')
      .set('Authorization', auth(partner.key))
      .expect(400);
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(server).get('/api/partner/applications').expect(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/partner/partner.applications.test.ts`
Expected: FAIL — `GET /api/partner/applications` does not exist (404), and `./partner.applications.service` does not exist.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/partner/partner.applications.service.ts`:

```typescript
import { Types } from 'mongoose';
import { badRequest } from '../../lib/errors';
import { SUBMITTED_APPLICATION_STATUSES } from '../documents/document.service';
import { ApplicationModel } from '../applications/application.model';
import type { ApplicationDoc } from '../applications/application.model';
import { DocumentModel } from '../documents/document.model';
import { ScholarshipModel } from '../scholarships/scholarship.model';

export interface PartnerApplicationDocumentDTO {
  key: string;
  label: string;
  filename: string;
  contentType: string;
}

export interface PartnerApplicationDTO {
  hubApplicationId: string;
  externalRef: string;
  scholarshipTitle: string;
  applicant: { name: string; email?: string; mobile?: string };
  answers: Record<string, unknown>;
  documents: PartnerApplicationDocumentDTO[];
  status: string;
  applicationNo?: string;
  submittedAt?: string;
  withdrawnAt?: string;
  hubUpdatedAt: string;
}

function encodeCursor(updatedAt: Date, id: Types.ObjectId): string {
  return Buffer.from(`${updatedAt.toISOString()}|${String(id)}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { updatedAt: Date; id: Types.ObjectId } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw badRequest('Invalid cursor');
  }
  const [iso, idHex] = decoded.split('|');
  const updatedAt = iso ? new Date(iso) : null;
  if (!iso || !idHex || !updatedAt || Number.isNaN(updatedAt.getTime()) || !Types.ObjectId.isValid(idHex)) {
    throw badRequest('Invalid cursor');
  }
  return { updatedAt, id: new Types.ObjectId(idHex) };
}

/**
 * Sync-Back Plan 2A: the applications-since-cursor read every partner (today,
 * only IDAP) polls. Scoped by `partnerId` at every step — the query, the
 * scholarship lookup, the document lookup — so a partner can never see
 * another partner's applicants, even indirectly through a shared scholarship
 * or document id.
 *
 * `answers` is returned as-is, unfiltered: an application's `answers` are
 * written ONLY against its own scholarship's `customQuestions` at submit
 * time (see `application.service.ts`'s `submitApplication`), so there is no
 * cross-scholarship key to filter out here.
 *
 * `applicationMode` is not checked here because it cannot be anything but
 * `'platform'` for a row that exists at all: `startApplication` refuses to
 * create an `Application` for an `applicationMode: 'external'` scholarship
 * (`externalApplication(...)` is thrown instead) — see that function's own
 * check. Every row this query can find is inherently platform-mode.
 */
export async function listPartnerApplications(
  partnerId: string,
  query: { since?: string; limit: number },
): Promise<{ items: PartnerApplicationDTO[]; nextCursor: string | null }> {
  const owner = new Types.ObjectId(partnerId);
  const cursor = query.since ? decodeCursor(query.since) : null;

  const rows = await ApplicationModel.find(
    {
      partnerId: owner,
      status: { $in: SUBMITTED_APPLICATION_STATUSES },
      ...(cursor
        ? {
            $or: [
              { updatedAt: { $gt: cursor.updatedAt } },
              { updatedAt: cursor.updatedAt, _id: { $gt: cursor.id } },
            ],
          }
        : {}),
    },
    {
      _id: 1,
      scholarshipId: 1,
      scholarshipTitle: 1,
      status: 1,
      answers: 1,
      documents: 1,
      profileSnapshot: 1,
      applicationNo: 1,
      submittedAt: 1,
      withdrawnAt: 1,
      updatedAt: 1,
    },
  )
    .sort({ updatedAt: 1, _id: 1 })
    .limit(query.limit)
    .lean<ApplicationDoc[]>();

  if (rows.length === 0) return { items: [], nextCursor: null };

  const scholarshipIds = [...new Set(rows.map((r) => String(r.scholarshipId)))].map(
    (id) => new Types.ObjectId(id),
  );
  const scholarships = await ScholarshipModel.find(
    { _id: { $in: scholarshipIds }, partnerId: owner },
    { _id: 1, externalRef: 1 },
  ).lean<{ _id: Types.ObjectId; externalRef?: string }[]>();
  const externalRefById = new Map(scholarships.map((s) => [String(s._id), s.externalRef]));

  const documentIds = rows.flatMap((r) => (r.documents ?? []).map((d) => d.documentId));
  const documents = documentIds.length === 0
    ? []
    : await DocumentModel.find(
        { _id: { $in: documentIds } },
        { _id: 1, label: 1, originalName: 1, mimeType: 1 },
      ).lean<{ _id: Types.ObjectId; label: string; originalName: string; mimeType: string }[]>();
  const documentById = new Map(documents.map((d) => [String(d._id), d]));

  const items: PartnerApplicationDTO[] = [];
  for (const row of rows) {
    const externalRef = externalRefById.get(String(row.scholarshipId));
    // A partner-owned application whose scholarship no longer resolves to
    // THIS partner (or has lost its externalRef) is skipped rather than sent
    // with a ref IDAP could never resolve — see the isolation requirement in
    // this plan's Global Constraints.
    if (!externalRef) continue;
    const snapshot = (row.profileSnapshot ?? {}) as { student?: { name?: string; email?: string; mobile?: string } };
    items.push({
      hubApplicationId: String(row._id),
      externalRef,
      scholarshipTitle: row.scholarshipTitle,
      applicant: {
        name: snapshot.student?.name ?? '',
        ...(snapshot.student?.email !== undefined ? { email: snapshot.student.email } : {}),
        ...(snapshot.student?.mobile !== undefined ? { mobile: snapshot.student.mobile } : {}),
      },
      answers: (row.answers ?? {}) as Record<string, unknown>,
      documents: (row.documents ?? []).map((d) => {
        const meta = documentById.get(String(d.documentId));
        return {
          key: d.key,
          label: meta?.label ?? '',
          filename: meta?.originalName ?? '',
          contentType: meta?.mimeType ?? 'application/octet-stream',
        };
      }),
      status: row.status,
      ...(row.applicationNo !== undefined ? { applicationNo: row.applicationNo } : {}),
      ...(row.submittedAt !== undefined ? { submittedAt: new Date(row.submittedAt).toISOString() } : {}),
      ...(row.withdrawnAt !== undefined ? { withdrawnAt: new Date(row.withdrawnAt).toISOString() } : {}),
      hubUpdatedAt: new Date(row.updatedAt).toISOString(),
    });
  }

  const last = rows[rows.length - 1]!;
  const nextCursor = rows.length === query.limit ? encodeCursor(new Date(last.updatedAt), last._id) : null;

  return { items, nextCursor };
}
```

- [ ] **Step 4: Add the query validation schema**

In `apps/api/src/modules/partner/partner.validation.ts`, add:

```typescript
export const listApplicationsQuerySchema = z.object({
  since: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListApplicationsQueryInput = z.infer<typeof listApplicationsQuerySchema>;
```

- [ ] **Step 5: Wire the route**

In `apps/api/src/modules/partner/partner.routes.ts`, add the import and route:

```typescript
import { listApplicationsQuerySchema, type ListApplicationsQueryInput, /* existing imports */ } from './partner.validation';
import { listPartnerApplications } from './partner.applications.service';
```

```typescript
partnerRoutes.get('/applications', requirePartner, validate({ query: listApplicationsQuerySchema }), async (_req, res) => {
  const { partner } = res.locals as PartnerLocals;
  const { query } = (res.locals as ValidatedLocals<unknown, ListApplicationsQueryInput>).input;
  const result = await listPartnerApplications(partner.id, query);
  res.status(200).json(result);
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/partner/partner.applications.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/partner/partner.applications.service.ts \
        apps/api/src/modules/partner/partner.applications.test.ts \
        apps/api/src/modules/partner/partner.validation.ts \
        apps/api/src/modules/partner/partner.routes.ts
git commit -m "feat(partner): GET /api/partner/applications cursor list (sync-back 2A/2)"
```

---

### Task 3: `GET /api/partner/applications/:hubApplicationId/documents/:key/file` — document streaming

**Files:**
- Modify: `apps/api/src/modules/partner/partner.applications.service.ts`
- Modify: `apps/api/src/modules/partner/partner.validation.ts`
- Modify: `apps/api/src/modules/partner/partner.routes.ts`
- Modify: `apps/api/src/middleware/rateLimit.ts`
- Test: `apps/api/src/modules/partner/partner.applications.test.ts` (extend)

**Interfaces:**
- Consumes: `ApplicationModel`, `SUBMITTED_APPLICATION_STATUSES`, `DocumentModel`, `DOCUMENT_FILE_PROJECTION`, `DocumentFileDoc`, `toDocument` (all from `apps/api/src/modules/documents/document.model.ts`), `storage` (`apps/api/src/lib/storage.ts`), `sendDocumentFile` (`apps/api/src/lib/streamFile.ts`), `notFound` (`apps/api/src/lib/errors.ts`), `createRateLimiter` (`apps/api/src/middleware/rateLimit.ts`), `PartnerLocals` (`apps/api/src/middleware/partner-auth.ts`).
- Produces: `streamPartnerApplicationDocument(partnerId: string, hubApplicationId: string, documentKey: string): Promise<{doc: DocumentDTO; stream: NodeJS.ReadableStream}>`; `partnerDocumentStreamLimiter` (RequestHandler) and `PARTNER_DOCUMENT_RATE_LIMIT` exported from `rateLimit.ts`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/modules/partner/partner.applications.test.ts`:

```typescript
import { DocumentModel } from '../documents/document.model';

describe('GET /api/partner/applications/:hubApplicationId/documents/:key/file', () => {
  async function makeApplicationWithDocument(partnerId: Types.ObjectId) {
    const { application, provider } = await makeSubmittedApplication(partnerId);
    const student = await UserModel.findOne({}).sort({ _id: -1 }).lean(); // the one just created above
    const doc = await DocumentModel.create({
      ownerUserId: application.studentUserId,
      type: 'income_certificate',
      label: 'Income Certificate 2026',
      storageKey: `${application.studentUserId}/${Date.now()}.pdf`,
      originalName: 'income.pdf',
      mimeType: 'application/pdf',
      size: 10,
      status: 'uploaded',
    });
    await ApplicationModel.updateOne(
      { _id: application._id },
      { $set: { documents: [{ key: 'income_certificate', documentId: doc._id }] } },
    );
    return { application, doc, provider, student };
  }

  it('streams the file when the document belongs to this partner\'s application', async () => {
    const partner = await makePartner();
    const { application } = await makeApplicationWithDocument(partner.id);

    const res = await request(server)
      .get(`/api/partner/applications/${String(application._id)}/documents/income_certificate/file`)
      .set('Authorization', auth(partner.key));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('income.pdf');
  });

  it('404s for another partner\'s application, never leaking whether it exists', async () => {
    const partner = await makePartner();
    const other = await makePartner('Other Partner');
    const { application } = await makeApplicationWithDocument(other.id);

    await request(server)
      .get(`/api/partner/applications/${String(application._id)}/documents/income_certificate/file`)
      .set('Authorization', auth(partner.key))
      .expect(404);
  });

  it('404s for an unknown document key on a real application', async () => {
    const partner = await makePartner();
    const { application } = await makeApplicationWithDocument(partner.id);

    await request(server)
      .get(`/api/partner/applications/${String(application._id)}/documents/nonexistent_key/file`)
      .set('Authorization', auth(partner.key))
      .expect(404);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const partner = await makePartner();
    const { application } = await makeApplicationWithDocument(partner.id);
    await request(server)
      .get(`/api/partner/applications/${String(application._id)}/documents/income_certificate/file`)
      .expect(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/partner/partner.applications.test.ts`
Expected: FAIL — route does not exist (404 for the happy-path test, or the whole file fails to import `streamPartnerApplicationDocument`).

- [ ] **Step 3: Add the streaming function**

Append to `apps/api/src/modules/partner/partner.applications.service.ts`:

```typescript
import { notFound } from '../../lib/errors';
import { storage } from '../../lib/storage';
import { DOCUMENT_FILE_PROJECTION, toDocument } from '../documents/document.model';
import type { DocumentFileDoc } from '../documents/document.model';

/**
 * Resolves a document through THIS application's own `documents[].key` slot
 * — never a raw document id — the same pattern the provider-side route
 * (`streamApplicantDocument`, `application.provider.service.ts`) already
 * uses, scoped by `partnerId` instead of `providerId`.
 */
export async function streamPartnerApplicationDocument(
  partnerId: string,
  hubApplicationId: string,
  documentKey: string,
): Promise<{ doc: ReturnType<typeof toDocument>; stream: NodeJS.ReadableStream }> {
  const owner = Types.ObjectId.isValid(partnerId) ? new Types.ObjectId(partnerId) : null;
  const target = Types.ObjectId.isValid(hubApplicationId) ? new Types.ObjectId(hubApplicationId) : null;
  if (!owner || !target) throw notFound('Document');

  const application = await ApplicationModel.findOne(
    { _id: target, partnerId: owner, status: { $in: SUBMITTED_APPLICATION_STATUSES }, 'documents.key': documentKey },
    { _id: 1, documents: 1 },
  ).lean<{ documents?: { key: string; documentId: Types.ObjectId }[] } | null>();
  if (!application) throw notFound('Document');

  const ref = (application.documents ?? []).find((entry) => entry.key === documentKey);
  if (!ref) throw notFound('Document');

  const doc = await DocumentModel.findOne({ _id: ref.documentId }, DOCUMENT_FILE_PROJECTION)
    .select('+storageKey')
    .lean<DocumentFileDoc | null>();
  if (!doc) throw notFound('Document');

  const stream = await storage.getStream(doc.storageKey);
  return { doc: toDocument(doc), stream };
}
```

- [ ] **Step 4: Add the params schema**

In `apps/api/src/modules/partner/partner.validation.ts`, add:

```typescript
export const partnerApplicationDocumentParams = z.object({
  hubApplicationId: z.string(),
  key: z.string(),
});
export type PartnerApplicationDocumentParams = z.infer<typeof partnerApplicationDocumentParams>;
```

- [ ] **Step 5: Add the partner document rate limiter**

In `apps/api/src/middleware/rateLimit.ts`, add near the other named limiters (after `documentStreamLimiter`):

```typescript
import type { PartnerLocals } from './partner-auth';

/** Keys the partner document limiter by partner id — no anonymous case exists here, `requirePartner` always runs first. */
function partnerRateLimitKey(_req: Request, res: Response): string {
  return (res.locals as PartnerLocals).partner.id;
}

export const PARTNER_DOCUMENT_RATE_LIMIT = { windowMs: 15 * MINUTE, limit: 300 } as const;

export const partnerDocumentStreamLimiter = createRateLimiter({
  name: 'partnerDocumentStream',
  windowMs: PARTNER_DOCUMENT_RATE_LIMIT.windowMs,
  limit: PARTNER_DOCUMENT_RATE_LIMIT.limit,
  keyGenerator: partnerRateLimitKey,
  message: 'This partner has requested a lot of documents recently. Please slow down.',
});
```

(If `rateLimit.ts` importing `partner-auth.ts`'s `PartnerLocals` type creates a circular import with `partner-auth.ts` — check by running `npx tsc --noEmit` after this change — inline the type instead: `{ partner: { id: string; name: string } }`.)

- [ ] **Step 6: Wire the route**

In `apps/api/src/modules/partner/partner.routes.ts`:

```typescript
import { streamPartnerApplicationDocument } from './partner.applications.service';
import { partnerApplicationDocumentParams, type PartnerApplicationDocumentParams, /* existing */ } from './partner.validation';
import { partnerDocumentStreamLimiter } from '../../middleware/rateLimit';
import { sendDocumentFile } from '../../lib/streamFile';
import { contentDispositionHeader } from '../documents/document.service';
```

```typescript
partnerRoutes.get(
  '/applications/:hubApplicationId/documents/:key/file',
  requirePartner,
  partnerDocumentStreamLimiter,
  validate({ params: partnerApplicationDocumentParams }),
  async (_req, res) => {
    const { partner } = res.locals as PartnerLocals;
    const { params } = (res.locals as ValidatedLocals<unknown, unknown, PartnerApplicationDocumentParams>).input;
    const { doc, stream } = await streamPartnerApplicationDocument(partner.id, params.hubApplicationId, params.key);
    await sendDocumentFile(res, doc, stream, contentDispositionHeader);
  },
);
```

(Confirm `contentDispositionHeader` is exported from `apps/api/src/modules/documents/document.service.ts` — it is already imported this way by `application.provider.routes.ts`.)

- [ ] **Step 7: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/partner/partner.applications.test.ts`
Expected: PASS

- [ ] **Step 8: Run the full API suite to confirm nothing else broke**

Run: `cd apps/api && npx vitest run`
Expected: PASS (all files)

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/partner/partner.applications.service.ts \
        apps/api/src/modules/partner/partner.applications.test.ts \
        apps/api/src/modules/partner/partner.validation.ts \
        apps/api/src/modules/partner/partner.routes.ts \
        apps/api/src/middleware/rateLimit.ts
git commit -m "feat(partner): document streaming for applications (sync-back 2A/3)"
```

---

### Task 4: `PUT /api/partner/webhook` — webhook registration + signing secret

**Files:**
- Modify: `apps/api/src/modules/partner/partner.model.ts`
- Modify: `apps/api/src/lib/partner-key.ts`
- Create: `apps/api/src/modules/partner/partner.webhook.service.ts`
- Modify: `apps/api/src/modules/partner/partner.validation.ts`
- Modify: `apps/api/src/modules/partner/partner.routes.ts`
- Test: `apps/api/src/modules/partner/partner.webhook.test.ts`

**Interfaces:**
- Consumes: `PartnerModel`, `requirePartner`/`PartnerLocals`, `validate`.
- Produces: `generateWebhookSecret(): string` (from `partner-key.ts`); `registerPartnerWebhook(partnerId: string, url: string): Promise<{ secret: string }>` (Task 5's dispatcher and Task 6's emit hook both read `Partner.webhookUrl`/`webhookSecret`/`webhookActive` that this sets); `registerWebhookSchema` (Zod).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/partner/partner.webhook.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import request from 'supertest';
import { createApp } from '../../app';
import { startTestServer, stopTestServer } from '../../test/setup';
import { PartnerModel } from './partner.model';
import { generatePartnerKey } from '../../lib/partner-key';
import { WEBHOOK_SECRET_PREFIX } from '../../lib/partner-key';

let server: Server;
beforeAll(async () => { server = await startTestServer(createApp()); });
afterAll(async () => { await stopTestServer(server); });

async function makePartner(name = 'IDAP') {
  const { key, keyHash } = generatePartnerKey();
  const p = await PartnerModel.create({ name, keyHash });
  return { key, id: String(p._id) };
}
const auth = (key: string) => `Bearer ${key}`;

describe('PUT /api/partner/webhook', () => {
  it('registers a webhook url and returns a secret exactly once', async () => {
    const partner = await makePartner();

    const res = await request(server)
      .put('/api/partner/webhook')
      .set('Authorization', auth(partner.key))
      .send({ url: 'https://idap.example.org/api/webhooks/scholarship-hub' })
      .expect(200);

    const body = res.body as { webhookUrl: string; secret: string };
    expect(body.webhookUrl).toBe('https://idap.example.org/api/webhooks/scholarship-hub');
    expect(body.secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);

    const stored = await PartnerModel.findById(partner.id).select('+webhookSecret').lean<{
      webhookUrl?: string; webhookSecret?: string; webhookActive?: boolean;
    } | null>();
    expect(stored?.webhookUrl).toBe('https://idap.example.org/api/webhooks/scholarship-hub');
    expect(stored?.webhookSecret).toBe(body.secret);
    expect(stored?.webhookActive).toBe(true);

    // A default findOne (no explicit +webhookSecret) must never return the secret.
    const plain = await PartnerModel.findById(partner.id).lean<{ webhookSecret?: string } | null>();
    expect(plain?.webhookSecret).toBeUndefined();
  });

  it('rotates the secret on a second call, returning a NEW value', async () => {
    const partner = await makePartner();
    const first = await request(server).put('/api/partner/webhook').set('Authorization', auth(partner.key))
      .send({ url: 'https://idap.example.org/hook' }).expect(200);
    const second = await request(server).put('/api/partner/webhook').set('Authorization', auth(partner.key))
      .send({ url: 'https://idap.example.org/hook-v2' }).expect(200);

    expect((second.body as { secret: string }).secret).not.toBe((first.body as { secret: string }).secret);
    const stored = await PartnerModel.findById(partner.id).select('+webhookSecret').lean<{ webhookUrl?: string; webhookSecret?: string } | null>();
    expect(stored?.webhookUrl).toBe('https://idap.example.org/hook-v2');
    expect(stored?.webhookSecret).toBe((second.body as { secret: string }).secret);
  });

  it('rejects a non-https url with 400', async () => {
    const partner = await makePartner();
    await request(server).put('/api/partner/webhook').set('Authorization', auth(partner.key))
      .send({ url: 'http://idap.example.org/hook' }).expect(400);
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(server).put('/api/partner/webhook').send({ url: 'https://idap.example.org/hook' }).expect(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/partner/partner.webhook.test.ts`
Expected: FAIL — the route does not exist, `webhookSecret`/`webhookUrl` are not schema fields, `generateWebhookSecret`/`WEBHOOK_SECRET_PREFIX` don't exist.

- [ ] **Step 3: Extend `PartnerModel`**

In `apps/api/src/modules/partner/partner.model.ts`:

```typescript
import { model, Schema, type Types } from 'mongoose';

const partnerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    keyHash: { type: String, required: true, unique: true },
    active: { type: Boolean, required: true, default: true },
    /** Where a signed `application.changed` ping is delivered (Sync-Back Plan 2A). Absent until the partner registers one. */
    webhookUrl: { type: String, trim: true },
    /**
     * The HMAC signing secret, stored recoverably (`select: false`, NOT
     * one-way hashed) because — unlike `keyHash`, which only ever needs to
     * be COMPARED against an inbound key — the delivery worker (Task 5) must
     * read the plaintext back to SIGN every outgoing webhook. `select:
     * false` is this codebase's established access-control primitive for a
     * field that must exist in a readable form but must never appear in an
     * ordinary query result (see `Document.storageKey`'s identical
     * reasoning). There is no at-rest encryption layer on the Hub today
     * (unlike IDAP's `IDAP_CREDENTIAL_KEY` vault) — introducing one for this
     * single field is out of scope for this plan; `select: false` is the
     * deliberate, documented trade-off.
     */
    webhookSecret: { type: String, select: false },
    webhookActive: { type: Boolean, required: true, default: false },
  },
  { timestamps: true, collection: 'partners' },
);

export const PartnerModel = model('Partner', partnerSchema);

export interface PartnerDoc {
  _id: Types.ObjectId;
  name: string;
  keyHash: string;
  active: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 4: Add `generateWebhookSecret`**

In `apps/api/src/lib/partner-key.ts`, add:

```typescript
/** All webhook signing secrets carry this prefix, mirroring `PARTNER_KEY_PREFIX`. */
export const WEBHOOK_SECRET_PREFIX = 'sh_whsec_';

/**
 * Unlike `generatePartnerKey`, no hash is returned — the plaintext IS what's
 * stored (see `PartnerModel.webhookSecret`'s doc comment): the delivery
 * worker must read it back to sign every outgoing request.
 */
export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(24).toString('hex');
}
```

- [ ] **Step 5: Add the validation schema**

In `apps/api/src/modules/partner/partner.validation.ts`, add:

```typescript
export const registerWebhookSchema = z.object({
  url: z.string().url().refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'url must be https'),
});
export type RegisterWebhookInput = z.infer<typeof registerWebhookSchema>;
```

- [ ] **Step 6: Implement the service**

Create `apps/api/src/modules/partner/partner.webhook.service.ts`:

```typescript
import { Types } from 'mongoose';
import { generateWebhookSecret } from '../../lib/partner-key';
import { PartnerModel } from './partner.model';

export async function registerPartnerWebhook(partnerId: string, url: string): Promise<{ secret: string }> {
  const secret = generateWebhookSecret();
  await PartnerModel.updateOne(
    { _id: new Types.ObjectId(partnerId) },
    { $set: { webhookUrl: url, webhookSecret: secret, webhookActive: true } },
  );
  return { secret };
}
```

- [ ] **Step 7: Wire the route**

In `apps/api/src/modules/partner/partner.routes.ts`:

```typescript
import { registerWebhookSchema, type RegisterWebhookInput, /* existing */ } from './partner.validation';
import { registerPartnerWebhook } from './partner.webhook.service';
```

```typescript
partnerRoutes.put('/webhook', requirePartner, validate({ body: registerWebhookSchema }), async (_req, res) => {
  const { partner } = res.locals as PartnerLocals;
  const { body } = (res.locals as ValidatedLocals<RegisterWebhookInput>).input;
  const { secret } = await registerPartnerWebhook(partner.id, body.url);
  res.status(200).json({ webhookUrl: body.url, secret });
});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/partner/partner.webhook.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/partner/partner.model.ts \
        apps/api/src/lib/partner-key.ts \
        apps/api/src/modules/partner/partner.webhook.service.ts \
        apps/api/src/modules/partner/partner.webhook.test.ts \
        apps/api/src/modules/partner/partner.validation.ts \
        apps/api/src/modules/partner/partner.routes.ts
git commit -m "feat(partner): webhook registration + signing secret (sync-back 2A/4)"
```

---

### Task 5: `PartnerWebhookDelivery` outbox + signed dispatcher/retry worker

**Files:**
- Create: `apps/api/src/modules/partner/partnerWebhookDelivery.model.ts`
- Modify: `apps/api/src/modules/partner/partner.webhook.service.ts`
- Create: `apps/api/src/jobs/deliverPartnerWebhooks.ts`
- Modify: `apps/api/src/jobs/runJob.ts`
- Modify: `apps/api/package.json`
- Test: `apps/api/src/jobs/deliverPartnerWebhooks.test.ts`

**Interfaces:**
- Consumes: `PartnerModel` (`webhookUrl`/`webhookSecret`/`webhookActive`, from Task 4), `createHmac` (`node:crypto`), global `fetch`.
- Produces: `PartnerWebhookDeliveryModel`; `enqueuePartnerWebhookDelivery(input: {partnerId: Types.ObjectId; payload: Record<string, unknown>}): Promise<void>` (exported from `partner.webhook.service.ts` — this is what Task 6's emit hook calls); `runDeliverPartnerWebhooks(now?: Date): Promise<{scanned: number; delivered: number; failed: number}>` (registered in `runJob.ts`'s `JOBS` map under the key `'webhooks'`).

- [ ] **Step 1: Write the failing model test**

Create `apps/api/src/modules/partner/partnerWebhookDelivery.model.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { PartnerWebhookDeliveryModel } from './partnerWebhookDelivery.model';

describe('PartnerWebhookDeliveryModel', () => {
  it('stores a pending delivery with the fields the dispatcher needs', async () => {
    const partnerId = new Types.ObjectId();
    const row = await PartnerWebhookDeliveryModel.create({
      partnerId,
      url: 'https://idap.example.org/hook',
      payload: { event: 'application.changed', externalRef: 'IDAP:INS0001:abc', hubApplicationId: 'x', changedAt: new Date().toISOString() },
      nextAttemptAt: new Date(),
    });
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);

    const indexes = await PartnerWebhookDeliveryModel.collection.indexes();
    expect(indexes.some((idx) => JSON.stringify(idx.key) === JSON.stringify({ status: 1, nextAttemptAt: 1 }))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/partner/partnerWebhookDelivery.model.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the model**

Create `apps/api/src/modules/partner/partnerWebhookDelivery.model.ts`:

```typescript
import { Schema, model, Types } from 'mongoose';

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * The outbound outbox: one row per `application.changed` ping owed to a
 * partner. `payload` is the exact thin body the dispatcher signs and sends
 * — never regenerated at send time, so what was decided when the event
 * happened is what actually gets delivered, even if the underlying
 * application changes again before delivery.
 */
const partnerWebhookDeliverySchema = new Schema(
  {
    partnerId: { type: Schema.Types.ObjectId, required: true, ref: 'Partner', index: true },
    url: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, required: true, enum: WEBHOOK_DELIVERY_STATUSES, default: 'pending' },
    attempts: { type: Number, required: true, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    lastError: { type: String },
  },
  { timestamps: true, collection: 'partnerWebhookDeliveries' },
);

// The dispatcher's own query: "what's due right now" — status first (highly
// selective: almost everything is 'delivered'), then the time ordering.
partnerWebhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });

export const PartnerWebhookDeliveryModel = model('PartnerWebhookDelivery', partnerWebhookDeliverySchema);

export interface PartnerWebhookDeliveryDoc {
  _id: Types.ObjectId;
  partnerId: Types.ObjectId;
  url: string;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/partner/partnerWebhookDelivery.model.test.ts`
Expected: PASS

- [ ] **Step 5: Add `enqueuePartnerWebhookDelivery`**

Append to `apps/api/src/modules/partner/partner.webhook.service.ts`:

```typescript
import { PartnerWebhookDeliveryModel } from './partnerWebhookDelivery.model';

/**
 * Enqueues one delivery row for immediate dispatch (`nextAttemptAt: now`) —
 * called by the emit hook (Task 6). Does not send anything itself: the
 * scheduled worker (`runDeliverPartnerWebhooks`, below) is the only thing
 * that ever makes the outbound HTTP call, so a caller that enqueues can
 * never be blocked or fail on the partner's endpoint being slow or down.
 */
export async function enqueuePartnerWebhookDelivery(input: {
  partnerId: Types.ObjectId;
  url: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await PartnerWebhookDeliveryModel.create({
    partnerId: input.partnerId,
    url: input.url,
    payload: input.payload,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(),
  });
}
```

- [ ] **Step 6: Write the failing dispatcher test**

Create `apps/api/src/jobs/deliverPartnerWebhooks.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { Types } from 'mongoose';
import { PartnerModel } from '../modules/partner/partner.model';
import { PartnerWebhookDeliveryModel } from '../modules/partner/partnerWebhookDelivery.model';
import { runDeliverPartnerWebhooks } from './deliverPartnerWebhooks';

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeActivePartner() {
  return PartnerModel.create({
    name: 'IDAP', keyHash: `hash-${Date.now()}-${Math.random()}`,
    webhookUrl: 'https://idap.example.org/hook', webhookSecret: 'sh_whsec_testsecret', webhookActive: true,
  });
}

describe('runDeliverPartnerWebhooks', () => {
  it('delivers a due row, signs it correctly, and marks it delivered', async () => {
    const partner = await makeActivePartner();
    const payload = { event: 'application.changed', externalRef: 'IDAP:INS0001:abc', hubApplicationId: 'x', changedAt: '2026-09-06T00:00:00.000Z' };
    const row = await PartnerWebhookDeliveryModel.create({
      partnerId: partner._id, url: partner.webhookUrl, payload, nextAttemptAt: new Date(),
    });

    let capturedUrl = '';
    let capturedInit: RequestInit = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(null, { status: 200 });
    }));

    const result = await runDeliverPartnerWebhooks();
    expect(result).toEqual({ scanned: 1, delivered: 1, failed: 0 });

    expect(capturedUrl).toBe('https://idap.example.org/hook');
    const headers = capturedInit.headers as Record<string, string>;
    const expectedSignature = createHmac('sha256', 'sh_whsec_testsecret').update(JSON.stringify(payload)).digest('hex');
    expect(headers['X-SH-Signature']).toBe(`sha256=${expectedSignature}`);
    expect(headers['X-SH-Timestamp']).toBeDefined();
    expect(JSON.parse(capturedInit.body as string)).toEqual(payload);

    const stored = await PartnerWebhookDeliveryModel.findById(row._id).lean<{ status: string; attempts: number } | null>();
    expect(stored?.status).toBe('delivered');
    expect(stored?.attempts).toBe(1);
  });

  it('backs off on a non-2xx response and retries later, without exceeding the schedule', async () => {
    const partner = await makeActivePartner();
    const row = await PartnerWebhookDeliveryModel.create({
      partnerId: partner._id, url: partner.webhookUrl,
      payload: { event: 'application.changed', externalRef: 'x', hubApplicationId: 'y', changedAt: 'z' },
      nextAttemptAt: new Date(),
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    const before = Date.now();
    const result = await runDeliverPartnerWebhooks();
    expect(result).toEqual({ scanned: 1, delivered: 0, failed: 0 });

    const stored = await PartnerWebhookDeliveryModel.findById(row._id).lean<{ status: string; attempts: number; nextAttemptAt: Date } | null>();
    expect(stored?.status).toBe('pending');
    expect(stored?.attempts).toBe(1);
    expect(stored!.nextAttemptAt.getTime()).toBeGreaterThan(before);
  });

  it('marks a delivery failed after exhausting the retry schedule', async () => {
    const partner = await makeActivePartner();
    const row = await PartnerWebhookDeliveryModel.create({
      partnerId: partner._id, url: partner.webhookUrl,
      payload: { event: 'application.changed', externalRef: 'x', hubApplicationId: 'y', changedAt: 'z' },
      nextAttemptAt: new Date(), attempts: 4, // one below the schedule's length — this run is the last try
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    await runDeliverPartnerWebhooks();

    const stored = await PartnerWebhookDeliveryModel.findById(row._id).lean<{ status: string; lastError?: string } | null>();
    expect(stored?.status).toBe('failed');
    expect(stored?.lastError).toBeDefined();
  });

  it('fails a delivery immediately, with no HTTP call, when the partner has since deactivated the webhook', async () => {
    const partner = await PartnerModel.create({
      name: 'IDAP', keyHash: `hash-${Date.now()}-${Math.random()}`,
      webhookUrl: 'https://idap.example.org/hook', webhookSecret: 'sh_whsec_testsecret', webhookActive: false,
    });
    const row = await PartnerWebhookDeliveryModel.create({
      partnerId: partner._id, url: 'https://idap.example.org/hook',
      payload: { event: 'application.changed', externalRef: 'x', hubApplicationId: 'y', changedAt: 'z' },
      nextAttemptAt: new Date(),
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await runDeliverPartnerWebhooks();

    expect(fetchSpy).not.toHaveBeenCalled();
    const stored = await PartnerWebhookDeliveryModel.findById(row._id).lean<{ status: string } | null>();
    expect(stored?.status).toBe('failed');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/jobs/deliverPartnerWebhooks.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 8: Implement the dispatcher**

Create `apps/api/src/jobs/deliverPartnerWebhooks.ts`:

```typescript
import { createHmac } from 'node:crypto';
import { PartnerModel } from '../modules/partner/partner.model';
import { PartnerWebhookDeliveryModel } from '../modules/partner/partnerWebhookDelivery.model';
import type { PartnerWebhookDeliveryDoc } from '../modules/partner/partnerWebhookDelivery.model';

/**
 * Delay before each retry, indexed by the attempt number BEFORE this one
 * (attempts=0 → first retry after 1 min, ... attempts=3 → fourth retry after
 * 60 min). Once `attempts` reaches this array's length, the delivery is
 * marked `failed` rather than scheduled again — the reconciliation poll
 * (Plan 2B) is the permanent-failure backstop, not an unbounded retry loop.
 */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export async function runDeliverPartnerWebhooks(
  now: Date = new Date(),
): Promise<{ scanned: number; delivered: number; failed: number }> {
  const due = await PartnerWebhookDeliveryModel.find({ status: 'pending', nextAttemptAt: { $lte: now } })
    .limit(100)
    .lean<PartnerWebhookDeliveryDoc[]>();

  let delivered = 0;
  let failed = 0;

  for (const row of due) {
    const partner = await PartnerModel.findOne({ _id: row.partnerId, active: true, webhookActive: true })
      .select('+webhookSecret')
      .lean<{ webhookSecret?: string; webhookUrl?: string } | null>();

    if (!partner || !partner.webhookSecret || !partner.webhookUrl) {
      await PartnerWebhookDeliveryModel.updateOne(
        { _id: row._id },
        { $set: { status: 'failed', lastError: 'webhook no longer active' } },
      );
      failed += 1;
      continue;
    }

    const rawBody = JSON.stringify(row.payload);
    const signature = createHmac('sha256', partner.webhookSecret).update(rawBody).digest('hex');

    let ok = false;
    let errorMessage = '';
    try {
      const response = await fetch(partner.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SH-Signature': `sha256=${signature}`,
          'X-SH-Timestamp': String(Math.floor(now.getTime() / 1000)),
        },
        body: rawBody,
      });
      ok = response.status >= 200 && response.status < 300;
      if (!ok) errorMessage = `webhook responded with status ${response.status}`;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'network error';
    }

    if (ok) {
      await PartnerWebhookDeliveryModel.updateOne(
        { _id: row._id },
        { $set: { status: 'delivered' }, $inc: { attempts: 1 } },
      );
      delivered += 1;
      continue;
    }

    const nextAttempt = row.attempts;
    if (nextAttempt >= RETRY_DELAYS_MS.length) {
      await PartnerWebhookDeliveryModel.updateOne(
        { _id: row._id },
        { $set: { status: 'failed', lastError: errorMessage }, $inc: { attempts: 1 } },
      );
      failed += 1;
      continue;
    }

    await PartnerWebhookDeliveryModel.updateOne(
      { _id: row._id },
      {
        $set: { nextAttemptAt: new Date(now.getTime() + RETRY_DELAYS_MS[nextAttempt]!), lastError: errorMessage },
        $inc: { attempts: 1 },
      },
    );
  }

  return { scanned: due.length, delivered, failed };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/jobs/deliverPartnerWebhooks.test.ts`
Expected: PASS

- [ ] **Step 10: Register the job and add the npm script**

In `apps/api/src/jobs/runJob.ts`, add the import and map entry:

```typescript
import { runDeliverPartnerWebhooks } from './deliverPartnerWebhooks';

const JOBS = {
  deadlines: runDeadlineReminders,
  matches: runNewMatchNotifier,
  webhooks: runDeliverPartnerWebhooks,
} as const;
```

In `apps/api/package.json`, add alongside `job:deadlines`/`job:matches`:

```json
    "job:webhooks": "tsx --env-file-if-exists=.env src/jobs/runJob.ts webhooks"
```

- [ ] **Step 11: Run the full API suite**

Run: `cd apps/api && npx vitest run`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/modules/partner/partnerWebhookDelivery.model.ts \
        apps/api/src/modules/partner/partnerWebhookDelivery.model.test.ts \
        apps/api/src/modules/partner/partner.webhook.service.ts \
        apps/api/src/jobs/deliverPartnerWebhooks.ts \
        apps/api/src/jobs/deliverPartnerWebhooks.test.ts \
        apps/api/src/jobs/runJob.ts \
        apps/api/package.json
git commit -m "feat(partner): webhook outbox + signed delivery worker (sync-back 2A/5)"
```

---

### Task 6: Emit `application.changed` on submit and withdraw

**Files:**
- Modify: `apps/api/src/modules/partner/partner.webhook.service.ts`
- Modify: `apps/api/src/modules/applications/application.service.ts`
- Test: `apps/api/src/modules/applications/application.test.ts` (extend)

**Interfaces:**
- Consumes: `enqueuePartnerWebhookDelivery` (Task 5), `PartnerModel` (Task 4's fields), `ScholarshipModel.externalRef`.
- Produces: `emitApplicationChanged(application: { _id: Types.ObjectId; partnerId?: Types.ObjectId; scholarshipId: Types.ObjectId }): Promise<void>` — called from `submitApplication` and `withdrawApplication`; nothing downstream in this plan consumes it further (Plan 2B consumes the resulting webhook, not this function).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/modules/applications/application.test.ts`, a new top-level `describe` block (place it after the existing `describe('POST /api/student/applications', ...)` block):

```typescript
import { PartnerModel } from '../partner/partner.model';
import { PartnerWebhookDeliveryModel } from '../partner/partnerWebhookDelivery.model';
import { submitApplication as submitApplicationDirect, withdrawApplication } from './application.service';

describe('partner webhook emission on submit/withdraw', () => {
  async function makePartnerScholarshipDraft() {
    const partnerId = new Types.ObjectId();
    const partner = await PartnerModel.create({
      name: 'IDAP', keyHash: `hash-${Date.now()}-${Math.random()}`,
      webhookUrl: 'https://idap.example.org/hook', webhookSecret: 'sh_whsec_x', webhookActive: true,
    });
    const provider = await ProviderModel.create({
      name: 'Infinity School', slug: `infinity-${Date.now()}-${Math.random()}`, type: 'trust',
      externalRef: `IDAP:INS${Date.now()}`, partnerId: partner._id, partnerTrusted: true, verificationStatus: 'verified',
    });
    const scholarship = await ScholarshipModel.create({
      providerId: provider._id, partnerId: partner._id,
      externalRef: `IDAP:${provider.externalRef?.split(':')[1]}:${new Types.ObjectId().toHexString()}`,
      title: 'Emit Scholarship', slug: `emit-scholarship-${Date.now()}`, status: 'published',
      dates: { opensAt: inDays(-1), closesAt: inDays(30) },
    });
    const student = await registerStudent();
    const res = await start(student.token, String(scholarship._id)).expect(201);
    return { partner, scholarship, student, applicationId: applicationOf(res.body).id };
  }

  it('enqueues a webhook delivery when a partner-owned application is submitted', async () => {
    const { partner, scholarship, student, applicationId } = await makePartnerScholarshipDraft();

    await submitApplicationDirect(student.userId, applicationId);

    const deliveries = await PartnerWebhookDeliveryModel.find({ partnerId: partner._id }).lean<
      { payload: Record<string, unknown> }[]
    >();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.payload).toMatchObject({
      event: 'application.changed',
      externalRef: scholarship.externalRef,
      hubApplicationId: applicationId,
    });
  });

  it('enqueues a webhook delivery when a partner-owned application is withdrawn', async () => {
    const { partner, scholarship, student, applicationId } = await makePartnerScholarshipDraft();
    await submitApplicationDirect(student.userId, applicationId);
    await PartnerWebhookDeliveryModel.deleteMany({}); // isolate the withdraw-triggered emit from submit's

    await withdrawApplication(student.userId, applicationId);

    const deliveries = await PartnerWebhookDeliveryModel.find({ partnerId: partner._id }).lean<
      { payload: Record<string, unknown> }[]
    >();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.payload).toMatchObject({ event: 'application.changed', externalRef: scholarship.externalRef });
  });

  it('never enqueues anything for a non-partner application', async () => {
    const provider = await makeProvider();
    const scholarship = await makeScholarship(provider._id);
    const student = await registerStudent();
    const res = await start(student.token, String(scholarship._id)).expect(201);

    await submitApplicationDirect(student.userId, applicationOf(res.body).id);

    expect(await PartnerWebhookDeliveryModel.countDocuments({})).toBe(0);
  });

  it('a webhook enqueue failure never fails the submit itself', async () => {
    const { student, applicationId } = await makePartnerScholarshipDraft();
    const spy = vi
      .spyOn(PartnerWebhookDeliveryModel, 'create')
      .mockRejectedValueOnce(new Error('enqueue exploded'));

    const dto = await submitApplicationDirect(student.userId, applicationId);
    expect(dto.status).toBe('submitted'); // the local transition still succeeded

    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/applications/application.test.ts`
Expected: FAIL — no delivery rows are ever created (the hook does not exist yet).

- [ ] **Step 3: Implement `emitApplicationChanged`**

Append to `apps/api/src/modules/partner/partner.webhook.service.ts`:

```typescript
import { ScholarshipModel } from '../scholarships/scholarship.model';
import { PartnerModel } from './partner.model';

/**
 * The single emit point for a partner-owned application's lifecycle. Called
 * from `submitApplication` and `withdrawApplication` (`application.service.
 * ts`) — never anything that only moves a row back to `draft` (a restart),
 * because IDAP's own applications-list query (Task 2) filters `draft` out
 * entirely, so a ping about one would just cause a wasted, no-op re-pull.
 *
 * No-ops silently — never throws — when the application is not
 * partner-owned, or the owning partner has no active webhook. The caller
 * still wraps this in its own `.catch(...)`: a webhook is a courtesy to a
 * partner, never a condition of the student's own action succeeding.
 */
export async function emitApplicationChanged(application: {
  _id: Types.ObjectId;
  partnerId?: Types.ObjectId;
  scholarshipId: Types.ObjectId;
}): Promise<void> {
  if (!application.partnerId) return;

  const partner = await PartnerModel.findOne({ _id: application.partnerId, active: true, webhookActive: true })
    .select('_id webhookUrl')
    .lean<{ _id: Types.ObjectId; webhookUrl?: string } | null>();
  if (!partner?.webhookUrl) return;

  const scholarship = await ScholarshipModel.findOne({ _id: application.scholarshipId }, { externalRef: 1 })
    .lean<{ externalRef?: string } | null>();
  if (!scholarship?.externalRef) return;

  await enqueuePartnerWebhookDelivery({
    partnerId: partner._id,
    url: partner.webhookUrl,
    payload: {
      event: 'application.changed',
      externalRef: scholarship.externalRef,
      hubApplicationId: String(application._id),
      changedAt: new Date().toISOString(),
    },
  });
}
```

- [ ] **Step 4: Wire the call sites**

In `apps/api/src/modules/applications/application.service.ts`, add the import:

```typescript
import { emitApplicationChanged } from '../partner/partner.webhook.service';
import { logger } from '../../lib/logger';
```

(`logger` may already be imported — check before adding a duplicate import line.)

In `submitApplication`, immediately after the existing `notify(...)` call and before `return toApplication(updated);`:

```typescript
  await notify('application_submitted', [userId, ...(await providerUserIds(String(current.providerId)))], {
    applicationNo,
    scholarshipTitle: current.scholarshipTitle,
    applicationId: id,
  });

  await emitApplicationChanged(updated).catch((err: unknown) =>
    logger.error({ err, applicationId: id }, 'partner webhook emit failed on submit'),
  );

  return toApplication(updated);
}
```

In `withdrawApplication`, after the `audit(...)` call and before `return toApplication(updated);`:

```typescript
  await audit({
    actorUserId: userId,
    actorRole: 'student',
    action: 'application.withdrawn',
    entityType: 'application',
    entityId: id,
    meta: { from: current.status, scholarshipId: String(updated.scholarshipId) },
    ...(ctx.ip !== undefined ? { ip: ctx.ip } : {}),
  });

  await emitApplicationChanged(updated).catch((err: unknown) =>
    logger.error({ err, applicationId: id }, 'partner webhook emit failed on withdraw'),
  );

  return toApplication(updated);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/applications/application.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full API suite**

Run: `cd apps/api && npx vitest run`
Expected: PASS (every file — this is the last task in the plan)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck --workspaces --if-present` (from the repo root) or `cd apps/api && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/partner/partner.webhook.service.ts \
        apps/api/src/modules/applications/application.service.ts \
        apps/api/src/modules/applications/application.test.ts
git commit -m "feat(applications): emit application.changed on submit/withdraw (sync-back 2A/6)"
```

---

## Self-Review

**Spec coverage:** §3.1 (applications-since-cursor list) → Task 2. §3.2 (document streaming) → Task 3. §3.3 (webhook registration + secret) → Task 4. §3.4 (emit hook + outbound dispatcher, thin payload) → Tasks 5 & 6. §3's `partnerId` denormalization prerequisite → Task 1. §5 (security: partner scoping everywhere, HMAC signing, no plaintext body beyond the thin ping) → threaded through every task's tests. §6's failure matrix ("webhook never arrives → poll backfills") → Task 5's bounded retry schedule plus Plan 2B's poll (out of this plan's scope, correctly deferred). No gaps found.

**Placeholder scan:** No "TBD"/"handle errors appropriately"/unshown code. Every step has literal, complete code. The one deliberately open decision (Step 8/9 of Task 1, where to run a `scripts/`-level test) is resolved with a concrete fallback instruction, not left vague — it depends on a repo-config fact (whether `scripts/` is an npm workspace) the implementer must check at execution time, which is exactly the kind of "verify at source" step this plan's own Global Constraints and prior-phase experience call for, not a placeholder.

**Type consistency:** `PartnerApplicationDTO`/`PartnerApplicationDocumentDTO` (Task 2) are the literal shape Task 3's tests read (`item.documents`) and the literal shape Plan 2B's IDAP connector will parse — verified the field names (`hubApplicationId`, `externalRef`, `applicant`, `hubUpdatedAt`) are used identically across Tasks 2 and 3's tests. `enqueuePartnerWebhookDelivery`'s parameter shape (Task 5) matches exactly what `emitApplicationChanged` (Task 6) passes it. `emitApplicationChanged`'s parameter type (`{_id, partnerId?, scholarshipId}`) matches `ApplicationDoc`'s actual shape (Task 1), so passing the `updated` lean document straight through in Task 6 type-checks without a cast. `WEBHOOK_SECRET_PREFIX`/`generateWebhookSecret` (Task 4) are the exact names Task 4's own test imports.
