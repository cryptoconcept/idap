# Scholarship Hub Applications Sync-Back — Plan 2B (IDAP Receiving Surface) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give IDAP (`/Users/automicai/AEMPlatform`) a receiving surface for Scholarship Hub applications: a new `ScholarshipApplication` model, an idempotent ingestion core, a signed inbound webhook receiver, a reconciliation pull + cron, a document proxy, permissions, a notification, and an inbox UI — so institutions see and act on applications students submit on the Hub.

**Architecture:** Eight tasks, dependency-ordered. (1) The model. (2) A `PlatformCredential` extension + a partner HTTP client reused by every outbound call this plan makes. (3) The ingestion core — one idempotent function every trigger below calls. (4) The reconciliation pull + its cron (the reliability backbone). (5) The inbound webhook receiver, which — because Plan 2A's only partner read is the cursor-list endpoint, not a single-item detail fetch — verifies the signature and then triggers an immediate run of Task 4's SAME pull function, rather than a separate per-item fetch; this is a deliberate ruling, recorded in Task 5. (6) The document proxy. (7) The dashboard service (list/get/assign/decide) + permissions. (8) The inbox UI, the tail task.

**Tech Stack:** Next.js 16 (App Router, Route Handlers), Mongoose 8, Zod 4, Vitest 3 (MongoMemoryServer, `--maxWorkers=4`), `node:crypto` (`createHmac`, `timingSafeEqual`), Vercel Cron (`vercel.json`).

**Spec:** `docs/superpowers/specs/2026-09-06-scholarship-hub-applications-syncback-design.md` (§4 "IDAP receiving surface" is what this plan implements; §5 "Security & trust model" and §6 "Data flow, idempotency & failure handling" bind every task). **Depends on Plan 2A** (`docs/superpowers/plans/2026-09-06-scholarship-hub-applications-syncback-2a-hub-sending-surface.md`) — this plan consumes the live partner contract Plan 2A builds; the exact shapes are repeated below so this plan is self-contained, but Plan 2A must be deployed before any task in this plan is enabled in production.

## Global Constraints

- Work only inside `/Users/automicai/AEMPlatform`. Never touch `/Users/automicai/scholarship-hub` — that is Plan 2A's repo, already built separately.
- **A completely separate, unrelated body of uncommitted work may exist in this working directory at execution time** (a UI-uplift effort, documented in `docs/platform-uplift-plan.md` if present) — it is NOT part of this plan, must NEVER be touched, staged, or committed alongside this plan's work, and this plan's own worktree (created fresh from the `main` branch's last commit) will not contain it regardless. If `git status` ever shows files this plan did not itself modify, stop and ask before touching them.
- **The live partner contract this plan consumes** (built by Plan 2A, committed to scholarship-hub main — this contract was CORRECTED during 2A's final whole-branch review, after this plan's tasks were first drafted; two fields below differ from what an earlier draft of this plan assumed, and every task below has already been updated to match): `GET /api/partner/applications?since=<cursor>&limit=<1-200,default 50>` → `{items: PartnerApplicationDTO[], nextCursor: string|null, hasMore: boolean}` where `PartnerApplicationDTO = {hubApplicationId, externalRef, scholarshipTitle, applicant:{name,email?,mobile?}, answers, documents:[{key,label,filename,contentType}], documentsReadable: boolean, status, applicationNo?, submittedAt?, withdrawnAt?, hubUpdatedAt}`. **`nextCursor` is a real, usable, opaque base64url cursor whenever the page has ≥1 item — including the terminal/non-full page** (it is `null` only for a genuinely empty page). IDAP must persist/reuse `nextCursor` verbatim whenever it is non-null, and use `hasMore` — never `nextCursor`'s nullness — as the sole signal for whether to keep polling. (This supersedes the old behavior where a terminal page returned `nextCursor: null` and a consumer had to reconstruct one itself; no such reconstruction is needed or correct anymore — treat `nextCursor` as fully opaque, never decode or construct it.) `documentsReadable` is `false` exactly when `status` is `"withdrawn"` (mirrors the gate the document-streaming endpoint itself enforces — a withdrawn application's documents 404; this flag never lies about whether a fetch would succeed, so the UI/document-proxy consumer can treat a 404 on a `documentsReadable:false` row as an expected state, not an error to retry). `GET /api/partner/applications/:hubApplicationId/documents/:key/file` streams one document's raw bytes (404, not an error, for a withdrawn application's document). `PUT /api/partner/webhook {url}` → `{webhookUrl, secret}` (called once, manually, during deploy setup — not by this plan's code). **The inbound webhook IDAP will receive:** `POST`, headers `X-SH-Signature: sha256=<hex>` and `X-SH-Timestamp: <unix seconds>`. **The HMAC is computed over `${timestampSeconds}.${rawBody}` (Stripe-style, a literal `.` between the `X-SH-Timestamp` value and the exact raw request body string) — NOT the raw body alone.** Body: `{event:"application.changed", externalRef, hubApplicationId, changedAt}`.
- `externalRef` format: `IDAP:{institutionId}:{scholarshipId}` (institutionId alphanumeric, scholarshipId a 24-char hex Mongo id).
- Tenant scoping: every `ScholarshipApplication` row is scoped by `institutionId` (a plain string, mirroring `Lead`/`Application`) — reuse `tenantFilter`/`requireTenantUser`/`requirePermission` from `src/lib/tenant`, never a hand-rolled check.
- `reviewStatus` is IDAP-owned: the ingestion core (Task 3) writes it exactly once, at creation, to `"NEW"`. No sync call — webhook or pull — may ever touch it again. Only the dashboard (Task 7) changes it after that.
- `hubStatus` is Hub-owned: written only by ingestion, verbatim (lowercase, the Hub's own casing) — never retranslated.
- An institution must have a `CONNECTED` `PlatformConnection` for `SCHOLARSHIP_HUB` before any application for it is ingested; an unconnected institution's pings are skipped, not errored.
- `externalRef` from any inbound payload is a claim, not proof: verify it against the local `Scholarship.listing.externalRef` + `institutionId` before writing anything.
- Documents are metadata-only on the model; bytes are fetched from the Hub on demand through the Task 6 proxy, never bulk-copied.
- Run the suite with `npx vitest run --maxWorkers=4 <file>` (MongoMemoryServer pool flakiness at full parallelism — established project-wide constraint). Typecheck with `npx tsc --noEmit`.
- No placeholders, no invented function names — every task's "Produces" block is the literal name and signature the next task imports.

---

### Task 1: `ScholarshipApplication` model

**Files:**
- Modify: `src/lib/constants.ts`
- Create: `src/models/ScholarshipApplication.ts`
- Modify: `src/models/index.ts`
- Test: `tests/unit/scholarship-application-model.test.ts`

**Interfaces:**
- Produces: `HUB_APPLICATION_STATUSES`, `HubApplicationStatus`, `SCHOLARSHIP_APPLICATION_REVIEW_STATUSES`, `ScholarshipApplicationReviewStatus` (from `constants.ts`); `ScholarshipApplication` (Mongoose model) and `ScholarshipApplicationDoc` (type), exported from `src/models/index.ts` — every later task imports these two names from `@/models`.

- [ ] **Step 1: Write the failing model test**

Create `tests/unit/scholarship-application-model.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Types } from "mongoose";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { ScholarshipApplication } from "@/models";

beforeAll(() => startTestDatabase("scholarship-application-model"));
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

function baseFields(overrides: Record<string, unknown> = {}) {
  return {
    institutionId: "INS0001",
    scholarshipId: new Types.ObjectId(),
    externalRef: "IDAP:INS0001:" + new Types.ObjectId().toHexString(),
    hubApplicationId: new Types.ObjectId().toHexString(),
    applicant: { name: "Asha Rao", email: "asha@example.com" },
    hubStatus: "submitted",
    hubUpdatedAt: new Date(),
    lastSyncedAt: new Date(),
    ...overrides,
  };
}

describe("ScholarshipApplication model", () => {
  it("defaults reviewStatus to NEW and persists required fields", async () => {
    const row = await ScholarshipApplication.create(baseFields());
    expect(row.reviewStatus).toBe("NEW");
    expect(row.applicant.name).toBe("Asha Rao");
    expect(row.hubStatus).toBe("submitted");
  });

  it("enforces one row per (institutionId, hubApplicationId)", async () => {
    const hubApplicationId = new Types.ObjectId().toHexString();
    await ScholarshipApplication.create(baseFields({ hubApplicationId }));
    await expect(ScholarshipApplication.create(baseFields({ hubApplicationId }))).rejects.toMatchObject({
      code: 11000,
    });
  });

  it("allows the SAME hubApplicationId across two different institutions", async () => {
    const hubApplicationId = new Types.ObjectId().toHexString();
    await ScholarshipApplication.create(baseFields({ hubApplicationId, institutionId: "INS0001" }));
    await expect(
      ScholarshipApplication.create(baseFields({ hubApplicationId, institutionId: "INS0002" })),
    ).resolves.toBeDefined();
  });

  it("rejects an invalid hubStatus or reviewStatus value", async () => {
    await expect(ScholarshipApplication.create(baseFields({ hubStatus: "not-a-real-status" }))).rejects.toThrow();
    await expect(
      ScholarshipApplication.create(baseFields({ reviewStatus: "NOT_A_REAL_STATUS" })),
    ).rejects.toThrow();
  });

  it("carries the (institutionId, hubApplicationId) unique index", async () => {
    const indexes = await ScholarshipApplication.collection.indexes();
    const target = indexes.find(
      (idx) => JSON.stringify(idx.key) === JSON.stringify({ institutionId: 1, hubApplicationId: 1 }),
    );
    expect(target?.unique).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-application-model.test.ts`
Expected: FAIL — `@/models` has no export named `ScholarshipApplication`.

- [ ] **Step 3: Add the two enums to `constants.ts`**

Add near the existing `APPLICATION_STATUSES`/`LEAD_STATUSES` block in `src/lib/constants.ts`:

```typescript
/**
 * Mirrors the Scholarship Hub's own application status values VERBATIM
 * (lowercase, Hub-cased) — never retranslated, so there is no silent
 * mapping bug between what the Hub sends and what IDAP stores. Excludes
 * "draft": the Hub never syndicates a draft application (Plan 2A's partner
 * list endpoint filters it out), so IDAP never sees one.
 */
export const HUB_APPLICATION_STATUSES = [
  "submitted",
  "under_review",
  "shortlisted",
  "additional_info_required",
  "approved",
  "rejected",
  "withdrawn",
] as const;
export type HubApplicationStatus = (typeof HUB_APPLICATION_STATUSES)[number];

/**
 * IDAP's own institution workflow for a Scholarship Hub application —
 * written once at creation (always "NEW") and thereafter only by the
 * dashboard (Task 7's `updateReviewStatus`). Separate from `hubStatus`
 * entirely: a withdrawn-on-Hub application can still carry any reviewStatus
 * here, by design (see the plan's failure-matrix note in Task 3).
 */
export const SCHOLARSHIP_APPLICATION_REVIEW_STATUSES = [
  "NEW",
  "UNDER_REVIEW",
  "SHORTLISTED",
  "APPROVED",
  "REJECTED",
] as const;
export type ScholarshipApplicationReviewStatus = (typeof SCHOLARSHIP_APPLICATION_REVIEW_STATUSES)[number];
```

- [ ] **Step 4: Create the model**

Create `src/models/ScholarshipApplication.ts`:

```typescript
import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";
import { HUB_APPLICATION_STATUSES, SCHOLARSHIP_APPLICATION_REVIEW_STATUSES } from "@/lib/constants";

const ScholarshipApplicationDocumentSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
  },
  { _id: false },
);

const ScholarshipApplicantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true },
    mobile: { type: String, trim: true },
  },
  { _id: false },
);

const ScholarshipApplicationSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    scholarshipId: { type: Schema.Types.ObjectId, required: true, index: true },
    externalRef: { type: String, required: true },
    /**
     * The Scholarship Hub's own Application `_id` (a 24-char hex string) —
     * the idempotency key sync-back ingests on (see the unique index
     * below). Unlike `Lead`/`Application`'s `idempotencyKey` (optional,
     * partial-unique — only some rows carry one), EVERY row here always has
     * one: there is no manually-created ScholarshipApplication, so a plain
     * (not partial) unique compound index is correct here, and simpler.
     */
    hubApplicationId: { type: String, required: true },
    applicationNo: { type: String, trim: true },

    applicant: { type: ScholarshipApplicantSchema, required: true },
    answers: { type: Schema.Types.Mixed, default: () => ({}) },
    documents: { type: [ScholarshipApplicationDocumentSchema], default: [] },

    hubStatus: { type: String, required: true, enum: HUB_APPLICATION_STATUSES },
    reviewStatus: {
      type: String,
      required: true,
      enum: SCHOLARSHIP_APPLICATION_REVIEW_STATUSES,
      default: "NEW",
    },

    assignedTo: { type: String, index: true },
    assignedAt: { type: Date },

    submittedAt: { type: Date },
    withdrawnAt: { type: Date },

    /**
     * The Hub's own `updatedAt` for this application, copied verbatim at
     * every sync. The ingestion core's ordering guard (Task 3) compares an
     * incoming payload's `hubUpdatedAt` against this stored value before
     * writing any Hub-owned field, so a stale poll snapshot racing a newer
     * webhook-triggered pull can never revert it.
     */
    hubUpdatedAt: { type: Date, required: true },
    lastSyncedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "scholarshipApplications" },
);

ScholarshipApplicationSchema.index({ institutionId: 1, hubApplicationId: 1 }, { unique: true });
ScholarshipApplicationSchema.index({ institutionId: 1, createdAt: -1 });
ScholarshipApplicationSchema.index({ institutionId: 1, hubStatus: 1, createdAt: -1 });
ScholarshipApplicationSchema.index({ institutionId: 1, reviewStatus: 1, createdAt: -1 });
ScholarshipApplicationSchema.index({ institutionId: 1, assignedTo: 1, createdAt: -1 });
ScholarshipApplicationSchema.index({ institutionId: 1, scholarshipId: 1 });

export type ScholarshipApplicationDoc = InferSchemaType<typeof ScholarshipApplicationSchema> & {
  _id: Types.ObjectId;
};

export const ScholarshipApplication: Model<ScholarshipApplicationDoc> =
  (models.ScholarshipApplication as Model<ScholarshipApplicationDoc>) ??
  model<ScholarshipApplicationDoc>("ScholarshipApplication", ScholarshipApplicationSchema);
```

- [ ] **Step 5: Export it from the models barrel**

In `src/models/index.ts`, add after the `Vacancy` export line:

```typescript
export { ScholarshipApplication, type ScholarshipApplicationDoc } from "./ScholarshipApplication";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-application-model.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/constants.ts src/models/ScholarshipApplication.ts src/models/index.ts tests/unit/scholarship-application-model.test.ts
git commit -m "feat(scholarship-applications): add the ScholarshipApplication model (sync-back 2B/1)"
```

---

### Task 2: `PlatformCredential` extension + partner HTTP client

**Files:**
- Modify: `src/models/PlatformCredential.ts`
- Create: `src/lib/connectors/scholarship-hub-partner-client.ts`
- Test: `tests/unit/scholarship-hub-partner-client.test.ts`

**Interfaces:**
- Consumes: `PlatformCredential` (`@/models`), `credentialVaultReady`/`decryptCredential`/`encryptCredential` (`@/lib/security/credentials`), `createConnectorHttp`/`ConnectorHttp` (`@/lib/connectors/http`), `notFound` (`@/lib/api/errors`).
- Produces: `loadScholarshipHubPartnerContext(): Promise<{baseUrl, platformKey, http: ConnectorHttp}>`; `loadScholarshipHubWebhookSecret(): Promise<string | null>`; `fetchScholarshipHubDocument(hubApplicationId: string, documentKey: string): Promise<Response>` — all three consumed by Tasks 4, 5, 6.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scholarship-hub-partner-client.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { PlatformCredential } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";
import {
  loadScholarshipHubPartnerContext,
  loadScholarshipHubWebhookSecret,
  fetchScholarshipHubDocument,
} from "@/lib/connectors/scholarship-hub-partner-client";

const ORIGINAL_KEY = process.env.IDAP_CREDENTIAL_KEY;

beforeAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  return startTestDatabase("scholarship-hub-partner-client");
});
afterAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = ORIGINAL_KEY;
  return stopTestDatabase();
});
beforeEach(clearDatabase);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadScholarshipHubPartnerContext", () => {
  it("404s when no active credential exists", async () => {
    await expect(loadScholarshipHubPartnerContext()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("decrypts the platform key and returns a bound http client", async () => {
    await PlatformCredential.create({
      platform: "SCHOLARSHIP_HUB",
      keyEncrypted: encryptCredential("sh_pkey_test"),
      baseUrl: "https://hub.test",
      active: true,
    });

    const ctx = await loadScholarshipHubPartnerContext();
    expect(ctx.baseUrl).toBe("https://hub.test");
    expect(ctx.platformKey).toBe("sh_pkey_test");
    expect(typeof ctx.http).toBe("function");
  });
});

describe("loadScholarshipHubWebhookSecret", () => {
  it("returns null when no credential or no secret is set", async () => {
    expect(await loadScholarshipHubWebhookSecret()).toBeNull();
    await PlatformCredential.create({
      platform: "SCHOLARSHIP_HUB",
      keyEncrypted: encryptCredential("sh_pkey_test"),
      baseUrl: "https://hub.test",
      active: true,
    });
    expect(await loadScholarshipHubWebhookSecret()).toBeNull();
  });

  it("decrypts the webhook secret when set", async () => {
    await PlatformCredential.create({
      platform: "SCHOLARSHIP_HUB",
      keyEncrypted: encryptCredential("sh_pkey_test"),
      webhookSecretEncrypted: encryptCredential("sh_whsec_test"),
      baseUrl: "https://hub.test",
      active: true,
    });
    expect(await loadScholarshipHubWebhookSecret()).toBe("sh_whsec_test");
  });
});

describe("fetchScholarshipHubDocument", () => {
  it("fetches the exact partner document URL with the platform key as a bearer token", async () => {
    await PlatformCredential.create({
      platform: "SCHOLARSHIP_HUB",
      keyEncrypted: encryptCredential("sh_pkey_test"),
      baseUrl: "https://hub.test",
      active: true,
    });

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init.headers as Record<string, string>;
        return new Response("file-bytes", { status: 200 });
      }),
    );

    const response = await fetchScholarshipHubDocument("hub-app-1", "income_certificate");
    expect(response.status).toBe(200);
    expect(capturedUrl).toBe("https://hub.test/api/partner/applications/hub-app-1/documents/income_certificate/file");
    expect(capturedHeaders.Authorization).toBe("Bearer sh_pkey_test");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-hub-partner-client.test.ts`
Expected: FAIL — module does not exist, and `PlatformCredential` has no `webhookSecretEncrypted` path.

- [ ] **Step 3: Extend `PlatformCredential`**

In `src/models/PlatformCredential.ts`, add two fields after `baseUrl`:

```typescript
const PlatformCredentialSchema = new Schema(
  {
    platform: { type: String, enum: PLATFORMS, required: true, unique: true },
    /** AES-256-GCM ciphertext of the platform key (pp_pkey_… / fbk_live_…). */
    keyEncrypted: { type: String, required: true, select: false },
    /** API origin, e.g. https://api.passpercent.in — configurable so dev points at localhost. */
    baseUrl: { type: String, required: true, trim: true },
    /**
     * HMAC signing secret for verifying the Scholarship Hub's inbound
     * `application.changed` webhook (sync-back Plan 2B). AES-256-GCM,
     * same vault as `keyEncrypted`. Absent until the webhook is registered
     * (`PUT /api/partner/webhook` on the Hub, done once during deploy
     * setup) — Task 5's receiver treats its absence as "not configured yet"
     * and 401s, never a 500.
     */
    webhookSecretEncrypted: { type: String, select: false },
    /**
     * Opaque pagination cursor for the reconciliation pull (Task 4) — one
     * platform-wide stream, since the Hub's partner API is partner-scoped,
     * not institution-scoped. Treated as opaque everywhere except Task 4's
     * own documented, flagged construction of one from a known item.
     */
    applicationsSyncCursor: { type: String },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
```

- [ ] **Step 4: Implement the client**

Create `src/lib/connectors/scholarship-hub-partner-client.ts`:

```typescript
import "server-only";
import { PlatformCredential } from "@/models";
import type { PlatformCredentialDoc } from "@/models";
import { credentialVaultReady, decryptCredential } from "@/lib/security/credentials";
import { createConnectorHttp } from "@/lib/connectors/http";
import type { ConnectorHttp } from "@/lib/connectors/http";
import { notFound } from "@/lib/api/errors";

const PLATFORM = "SCHOLARSHIP_HUB" as const;

export type ScholarshipHubPartnerContext = {
  baseUrl: string;
  platformKey: string;
  http: ConnectorHttp;
};

/**
 * Loads and decrypts the Scholarship Hub platform credential — the same
 * `sh_pkey_...` key Phase 1's outbound connector already uses, now also
 * what sync-back's pull (Task 4) and document proxy (Task 6) authenticate
 * with. 404s (not 500) when unconfigured, mirroring
 * `scholarship-publish.service.ts`'s own `buildContext`.
 */
export async function loadScholarshipHubPartnerContext(): Promise<ScholarshipHubPartnerContext> {
  if (!credentialVaultReady()) throw notFound("Scholarship Hub is not configured");
  const credential = await PlatformCredential.findOne({ platform: PLATFORM, active: true })
    .select("+keyEncrypted")
    .lean();
  if (!credential) throw notFound("Scholarship Hub is not configured");
  const baseUrl = credential.baseUrl;
  return {
    baseUrl,
    platformKey: decryptCredential((credential as PlatformCredentialDoc).keyEncrypted),
    http: createConnectorHttp(baseUrl),
  };
}

/**
 * The webhook signing secret, decrypted — platform-wide (Contract 1), like
 * the partner key itself. Returns null (not throw) when unset, since a
 * fresh deploy may not have registered a webhook yet — Task 5's receiver
 * decides whether that's fatal for a given request.
 */
export async function loadScholarshipHubWebhookSecret(): Promise<string | null> {
  if (!credentialVaultReady()) return null;
  const credential = await PlatformCredential.findOne({ platform: PLATFORM, active: true })
    .select("+webhookSecretEncrypted")
    .lean();
  const encrypted = (
    credential as (PlatformCredentialDoc & { webhookSecretEncrypted?: string }) | null
  )?.webhookSecretEncrypted;
  if (!encrypted) return null;
  return decryptCredential(encrypted);
}

/**
 * Streams one partner-scoped document's raw bytes from the Hub. Deliberately
 * NOT built on `ConnectorHttp` — that type always JSON-parses the response
 * body (`createConnectorHttp`'s `parseBody` does `JSON.parse` then falls
 * back to text), which would corrupt binary file bytes. This does a plain
 * authenticated `fetch` and hands back the raw `Response` so Task 6 can
 * stream its `.body` through untouched.
 */
export async function fetchScholarshipHubDocument(
  hubApplicationId: string,
  documentKey: string,
): Promise<Response> {
  const ctx = await loadScholarshipHubPartnerContext();
  const url = `${ctx.baseUrl.replace(/\/+$/, "")}/api/partner/applications/${encodeURIComponent(hubApplicationId)}/documents/${encodeURIComponent(documentKey)}/file`;
  return fetch(url, { headers: { Authorization: `Bearer ${ctx.platformKey}` } });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-hub-partner-client.test.ts`
Expected: PASS

- [ ] **Step 6: Run the platform-credential/connection suite to confirm no regression**

Run: `npx vitest run --maxWorkers=4 tests/unit/platform-models.test.ts tests/integration/connection-service.test.ts`
Expected: PASS (the new optional fields must not break any existing credential test)

- [ ] **Step 7: Commit**

```bash
git add src/models/PlatformCredential.ts src/lib/connectors/scholarship-hub-partner-client.ts tests/unit/scholarship-hub-partner-client.test.ts
git commit -m "feat(scholarship-applications): webhook secret field + partner HTTP client (sync-back 2B/2)"
```

---

### Task 3: Ingestion core (`upsertFromHubPayload`) + the `notifyNewHubApplication` notification

**Files:**
- Create: `src/services/scholarship-application-sync.service.ts`
- Modify: `src/services/notification.service.ts`
- Test: `tests/integration/scholarship-application-sync.test.ts`

**Interfaces:**
- Consumes: `ScholarshipApplication`, `Scholarship`, `PlatformConnection` (`@/models`), `afterResponse` (`@/lib/after-response`), `NotificationService` (`@/services/notification.service`).
- Produces: `HubApplicationPayload` (type — the exact shape Task 4's pull and Task 5's receiver both construct); `IngestOutcome` (type); `upsertFromHubPayload(payload: HubApplicationPayload): Promise<IngestOutcome>` — Tasks 4 and 5 both call this and only this.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/scholarship-application-sync.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Types } from "mongoose";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Scholarship, PlatformConnection, ScholarshipApplication } from "@/models";
import * as fcm from "@/lib/push/fcm";
import { upsertFromHubPayload, type HubApplicationPayload } from "@/services/scholarship-application-sync.service";

vi.mock("@/lib/push/fcm", () => ({
  sendPush: vi.fn(async () => ({ deadTokens: [] as string[] })),
}));
const sendPush = vi.mocked(fcm.sendPush);

beforeAll(() => startTestDatabase("scholarship-application-sync"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  sendPush.mockReset();
  sendPush.mockResolvedValue({ deadTokens: [] });
});

async function connectedScholarship(institutionId = "INS0001") {
  await makeInstitution(institutionId);
  await PlatformConnection.create({
    institutionId,
    platform: "SCHOLARSHIP_HUB",
    status: "CONNECTED",
    externalRef: `IDAP:${institutionId}`,
  });
  const scholarshipId = new Types.ObjectId();
  const externalRef = `IDAP:${institutionId}:${scholarshipId.toHexString()}`;
  await Scholarship.create({
    _id: scholarshipId,
    institutionId,
    name: "Merit Scholarship",
    amount: "₹10,000",
    criteria: "merit",
    listing: {
      hubId: "hub-listing-1",
      externalRef,
      remoteStatus: "published",
      lastPushedAt: new Date(),
    },
  });
  return { institutionId, scholarshipId, externalRef };
}

function payloadFor(externalRef: string, overrides: Partial<HubApplicationPayload> = {}): HubApplicationPayload {
  return {
    hubApplicationId: new Types.ObjectId().toHexString(),
    externalRef,
    scholarshipTitle: "Merit Scholarship",
    applicant: { name: "Asha Rao", email: "asha@example.com" },
    answers: { why: "need it" },
    documents: [],
    status: "submitted",
    hubUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("upsertFromHubPayload", () => {
  it("inserts a new row as reviewStatus NEW and fires the notification", async () => {
    const { externalRef, institutionId } = await connectedScholarship();
    const payload = payloadFor(externalRef);

    const outcome = await upsertFromHubPayload(payload);
    expect(outcome.kind).toBe("INSERTED");

    const row = await ScholarshipApplication.findOne({ institutionId, hubApplicationId: payload.hubApplicationId }).lean();
    expect(row?.reviewStatus).toBe("NEW");
    expect(row?.hubStatus).toBe("submitted");
    expect(row?.applicant.name).toBe("Asha Rao");
    await vi.waitFor(() => expect(sendPush).toHaveBeenCalledTimes(1));
  });

  it("replaying the same payload updates, never duplicates, and never touches reviewStatus", async () => {
    const { externalRef, institutionId } = await connectedScholarship();
    const payload = payloadFor(externalRef);
    await upsertFromHubPayload(payload);

    const row = await ScholarshipApplication.findOne({ institutionId, hubApplicationId: payload.hubApplicationId });
    row!.reviewStatus = "SHORTLISTED";
    await row!.save();

    const later = payloadFor(externalRef, {
      hubApplicationId: payload.hubApplicationId,
      status: "under_review",
      hubUpdatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const outcome = await upsertFromHubPayload(later);
    expect(outcome.kind).toBe("UPDATED");

    const updated = await ScholarshipApplication.findOne({ institutionId, hubApplicationId: payload.hubApplicationId }).lean();
    expect(updated?.hubStatus).toBe("under_review"); // Hub-owned field DID update
    expect(updated?.reviewStatus).toBe("SHORTLISTED"); // IDAP-owned field untouched
    expect(await ScholarshipApplication.countDocuments({})).toBe(1);
  });

  it("the ordering guard: a stale payload (older hubUpdatedAt) never reverts a newer one", async () => {
    const { externalRef, institutionId } = await connectedScholarship();
    const hubApplicationId = new Types.ObjectId().toHexString();
    const now = new Date();
    await upsertFromHubPayload(
      payloadFor(externalRef, { hubApplicationId, status: "under_review", hubUpdatedAt: now.toISOString() }),
    );

    const stale = payloadFor(externalRef, {
      hubApplicationId,
      status: "submitted",
      hubUpdatedAt: new Date(now.getTime() - 5000).toISOString(),
    });
    const outcome = await upsertFromHubPayload(stale);
    expect(outcome.kind).toBe("STALE");

    const row = await ScholarshipApplication.findOne({ institutionId, hubApplicationId }).lean();
    expect(row?.hubStatus).toBe("under_review"); // unchanged by the stale write
  });

  it("skips (does not throw) when the institution has no CONNECTED SCHOLARSHIP_HUB connection", async () => {
    await makeInstitution("INS0002");
    const scholarshipId = new Types.ObjectId();
    const externalRef = `IDAP:INS0002:${scholarshipId.toHexString()}`;
    await Scholarship.create({
      _id: scholarshipId, institutionId: "INS0002", name: "X", amount: "1", criteria: "x",
      listing: { hubId: "h2", externalRef, remoteStatus: "published", lastPushedAt: new Date() },
    });
    // No PlatformConnection created — institution never connected.

    const outcome = await upsertFromHubPayload(payloadFor(externalRef));
    expect(outcome).toEqual({ kind: "SKIPPED", reason: "NOT_CONNECTED" });
    expect(await ScholarshipApplication.countDocuments({})).toBe(0);
  });

  it("skips a malformed externalRef", async () => {
    const outcome = await upsertFromHubPayload(payloadFor("not-a-real-ref"));
    expect(outcome).toEqual({ kind: "SKIPPED", reason: "MALFORMED_REF" });
  });

  it("skips when the local scholarship's listing.externalRef does not match the payload's (forged/stale ref)", async () => {
    const { institutionId, scholarshipId } = await connectedScholarship();
    const forgedRef = `IDAP:${institutionId}:${scholarshipId.toHexString()}`;
    // Overwrite the scholarship's real listing.externalRef to something else,
    // simulating a stale/forged ping that no longer matches reality.
    await Scholarship.updateOne({ _id: scholarshipId }, { $set: { "listing.externalRef": "IDAP:INS0001:000000000000000000000000" } });

    const outcome = await upsertFromHubPayload(payloadFor(forgedRef));
    expect(outcome).toEqual({ kind: "SKIPPED", reason: "REF_MISMATCH" });
  });

  it("skips when the referenced scholarship does not exist locally", async () => {
    await makeInstitution("INS0003");
    await PlatformConnection.create({ institutionId: "INS0003", platform: "SCHOLARSHIP_HUB", status: "CONNECTED", externalRef: "IDAP:INS0003" });
    const fakeRef = `IDAP:INS0003:${new Types.ObjectId().toHexString()}`;

    const outcome = await upsertFromHubPayload(payloadFor(fakeRef));
    expect(outcome).toEqual({ kind: "SKIPPED", reason: "SCHOLARSHIP_NOT_FOUND" });
  });

  it("two concurrent inserts of the same new application never produce two rows", async () => {
    const { externalRef, institutionId } = await connectedScholarship();
    const payload = payloadFor(externalRef);

    const results = await Promise.all([upsertFromHubPayload(payload), upsertFromHubPayload(payload)]);
    expect(results.map((r) => r.kind).sort()).toEqual(["INSERTED", "UPDATED"].sort());
    expect(await ScholarshipApplication.countDocuments({ institutionId, hubApplicationId: payload.hubApplicationId })).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-application-sync.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Add `notifyNewHubApplication`**

In `src/services/notification.service.ts`, add a new method to the `NotificationService` object, after `notifyNewApplication`:

```typescript
  async notifyNewHubApplication(input: {
    institutionId: string;
    applicantName: string;
    scholarshipTitle: string;
  }) {
    await dispatch(input.institutionId, (pushToken) => ({
      pushToken,
      title: "New scholarship application",
      body: `${input.applicantName} — ${input.scholarshipTitle}`,
      data: { type: "scholarship-application" },
    }));
  },
```

- [ ] **Step 4: Implement the ingestion core**

Create `src/services/scholarship-application-sync.service.ts`:

```typescript
import "server-only";
import { Types } from "mongoose";
import { ScholarshipApplication, Scholarship, PlatformConnection } from "@/models";
import { NotificationService } from "./notification.service";
import { afterResponse } from "@/lib/after-response";

export type HubApplicationPayload = {
  hubApplicationId: string;
  externalRef: string;
  scholarshipTitle: string;
  applicant: { name: string; email?: string; mobile?: string };
  answers: Record<string, unknown>;
  documents: { key: string; label: string; filename: string; contentType: string }[];
  status: string;
  applicationNo?: string;
  submittedAt?: string;
  withdrawnAt?: string;
  hubUpdatedAt: string;
};

export type IngestOutcome =
  | { kind: "SKIPPED"; reason: "NOT_CONNECTED" | "REF_MISMATCH" | "MALFORMED_REF" | "SCHOLARSHIP_NOT_FOUND" }
  | { kind: "STALE" }
  | { kind: "INSERTED"; id: string }
  | { kind: "UPDATED"; id: string };

function parseExternalRef(externalRef: string): { institutionId: string; scholarshipId: string } | null {
  const match = /^IDAP:([A-Za-z0-9]+):([a-f0-9]{24})$/.exec(externalRef);
  if (!match) return null;
  return { institutionId: match[1]!, scholarshipId: match[2]! };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}

/**
 * The single idempotent ingestion core both the webhook receiver (Task 5)
 * and the reconciliation pull (Task 4) call. Keyed on
 * (institutionId, hubApplicationId). NEVER writes `reviewStatus`/
 * `assignedTo` past the first insert — those are IDAP-owned fields only the
 * dashboard (Task 7) changes.
 *
 * A withdrawn-on-Hub application whose reviewStatus is already e.g.
 * SHORTLISTED is left exactly that way — `hubStatus` and `reviewStatus`
 * simply coexist, by design (spec §6's failure matrix: "withdraw-after-
 * decision... the inbox surfaces 'withdrawn on Hub' prominently. No data
 * loss — both truths visible").
 */
export async function upsertFromHubPayload(payload: HubApplicationPayload): Promise<IngestOutcome> {
  const parsed = parseExternalRef(payload.externalRef);
  if (!parsed) return { kind: "SKIPPED", reason: "MALFORMED_REF" };
  const { institutionId, scholarshipId } = parsed;

  const connection = await PlatformConnection.findOne({ institutionId, platform: "SCHOLARSHIP_HUB" })
    .select("status")
    .lean();
  if (!connection || connection.status !== "CONNECTED") {
    return { kind: "SKIPPED", reason: "NOT_CONNECTED" };
  }

  const scholarship = await Scholarship.findOne({ _id: scholarshipId, institutionId })
    .select("listing.externalRef")
    .lean();
  if (!scholarship) return { kind: "SKIPPED", reason: "SCHOLARSHIP_NOT_FOUND" };
  if (scholarship.listing?.externalRef !== payload.externalRef) {
    return { kind: "SKIPPED", reason: "REF_MISMATCH" };
  }

  const hubUpdatedAt = new Date(payload.hubUpdatedAt);
  const existing = await ScholarshipApplication.findOne({
    institutionId,
    hubApplicationId: payload.hubApplicationId,
  })
    .select("hubUpdatedAt")
    .lean();

  if (existing && existing.hubUpdatedAt.getTime() >= hubUpdatedAt.getTime()) {
    return { kind: "STALE" };
  }

  const hubOwnedFields = {
    institutionId,
    scholarshipId: new Types.ObjectId(scholarshipId),
    externalRef: payload.externalRef,
    hubApplicationId: payload.hubApplicationId,
    applicant: payload.applicant,
    answers: payload.answers,
    documents: payload.documents,
    hubStatus: payload.status,
    ...(payload.applicationNo !== undefined ? { applicationNo: payload.applicationNo } : {}),
    ...(payload.submittedAt !== undefined ? { submittedAt: new Date(payload.submittedAt) } : {}),
    ...(payload.withdrawnAt !== undefined ? { withdrawnAt: new Date(payload.withdrawnAt) } : {}),
    hubUpdatedAt,
    lastSyncedAt: new Date(),
  };

  if (!existing) {
    try {
      const created = await ScholarshipApplication.create({ ...hubOwnedFields, reviewStatus: "NEW" });
      await afterResponse(() =>
        NotificationService.notifyNewHubApplication({
          institutionId,
          applicantName: payload.applicant.name,
          scholarshipTitle: payload.scholarshipTitle,
        }).catch((err: unknown) => console.error("[push] hub application notification failed", err)),
      );
      return { kind: "INSERTED", id: String(created._id) };
    } catch (error) {
      // Lost a race to a concurrent ingest of the same application — the
      // Hub payload is idempotent by construction, so falling through to
      // the update path below (rather than erroring) is correct, not just
      // tolerant.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  const updated = await ScholarshipApplication.findOneAndUpdate(
    { institutionId, hubApplicationId: payload.hubApplicationId },
    { $set: hubOwnedFields },
    { new: true, projection: { _id: 1 } },
  ).lean();
  if (!updated) throw new Error("scholarship-application sync: row vanished between insert and update");
  return { kind: "UPDATED", id: String(updated._id) };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-application-sync.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/scholarship-application-sync.service.ts src/services/notification.service.ts tests/integration/scholarship-application-sync.test.ts
git commit -m "feat(scholarship-applications): idempotent ingestion core (sync-back 2B/3)"
```

---

### Task 4: Reconciliation pull + cron

**Files:**
- Modify: `src/services/scholarship-application-sync.service.ts`
- Create: `src/app/api/cron/scholarship-hub-sync/route.ts`
- Modify: `vercel.json`
- Test: `tests/integration/scholarship-hub-reconciliation-pull.test.ts`

**Interfaces:**
- Consumes: `loadScholarshipHubPartnerContext` (Task 2), `upsertFromHubPayload` (Task 3), `PlatformCredential` (`@/models`), `jsonSuccess` (`@/lib/api/response`).
- Produces: `runReconciliationPull(): Promise<{scanned: number; ingested: number; cursorAdvanced: boolean}>` — Task 5's webhook receiver calls this directly, in-process.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/scholarship-hub-reconciliation-pull.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { Types } from "mongoose";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Scholarship, PlatformConnection, PlatformCredential, ScholarshipApplication } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";
import { runReconciliationPull } from "@/services/scholarship-application-sync.service";

const ORIGINAL_KEY = process.env.IDAP_CREDENTIAL_KEY;

beforeAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  return startTestDatabase("scholarship-hub-reconciliation-pull");
});
afterAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = ORIGINAL_KEY;
  return stopTestDatabase();
});
beforeEach(clearDatabase);
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const institutionId = "INS0001";
  await makeInstitution(institutionId);
  await PlatformConnection.create({ institutionId, platform: "SCHOLARSHIP_HUB", status: "CONNECTED", externalRef: `IDAP:${institutionId}` });
  await PlatformCredential.create({ platform: "SCHOLARSHIP_HUB", keyEncrypted: encryptCredential("sh_pkey_test"), baseUrl: "https://hub.test", active: true });
  const scholarshipId = new Types.ObjectId();
  const externalRef = `IDAP:${institutionId}:${scholarshipId.toHexString()}`;
  await Scholarship.create({
    _id: scholarshipId, institutionId, name: "Merit", amount: "1", criteria: "merit",
    listing: { hubId: "h1", externalRef, remoteStatus: "published", lastPushedAt: new Date() },
  });
  return { institutionId, externalRef };
}

function item(externalRef: string, hubApplicationId: string, hubUpdatedAt: string) {
  return {
    hubApplicationId, externalRef, scholarshipTitle: "Merit",
    applicant: { name: "Asha Rao" }, answers: {}, documents: [],
    status: "submitted", hubUpdatedAt,
  };
}

describe("runReconciliationPull", () => {
  it("ingests every item on a single (terminal) page and advances the stored cursor", async () => {
    const { externalRef, institutionId } = await setup();
    const items = [item(externalRef, "a1", "2026-09-06T00:00:00.000Z"), item(externalRef, "a2", "2026-09-06T00:01:00.000Z")];

    // Terminal page: hasMore is false, but nextCursor is still a REAL value
    // (the list endpoint only returns null for a genuinely empty page).
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items, nextCursor: "opaque-cursor-terminal", hasMore: false }), { status: 200 })));

    const result = await runReconciliationPull();
    expect(result).toEqual({ scanned: 2, ingested: 2, cursorAdvanced: true });
    expect(await ScholarshipApplication.countDocuments({ institutionId })).toBe(2);

    const credential = await PlatformCredential.findOne({ platform: "SCHOLARSHIP_HUB" }).lean();
    expect(credential?.applicationsSyncCursor).toBe("opaque-cursor-terminal");
  });

  it("follows hasMore across multiple pages until caught up", async () => {
    const { externalRef } = await setup();
    const page1 = { items: [item(externalRef, "a1", "2026-09-06T00:00:00.000Z")], nextCursor: "opaque-cursor-1", hasMore: true };
    const page2 = { items: [item(externalRef, "a2", "2026-09-06T00:01:00.000Z")], nextCursor: "opaque-cursor-2", hasMore: false };
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify(calls.length === 1 ? page1 : page2), { status: 200 });
      }),
    );

    const result = await runReconciliationPull();
    expect(result.scanned).toBe(2);
    expect(result.ingested).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("since=opaque-cursor-1");
  });

  it("passes the previously stored cursor as `since` on the next run", async () => {
    await setup();
    await PlatformCredential.updateOne({ platform: "SCHOLARSHIP_HUB" }, { $set: { applicationsSyncCursor: "stored-cursor" } });

    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), { status: 200 });
      }),
    );

    await runReconciliationPull();
    expect(capturedUrl).toContain("since=stored-cursor");
  });

  it("is idempotent: re-ingesting the same page a second time does not create duplicates", async () => {
    const { externalRef, institutionId } = await setup();
    const items = [item(externalRef, "a1", "2026-09-06T00:00:00.000Z")];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items, nextCursor: "opaque-cursor-1", hasMore: false }), { status: 200 })));

    await runReconciliationPull();
    await runReconciliationPull();
    expect(await ScholarshipApplication.countDocuments({ institutionId })).toBe(1);
  });

  it("an empty page returns nextCursor:null and does not advance or crash on a missing cursor", async () => {
    await setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), { status: 200 })));

    const result = await runReconciliationPull();
    expect(result).toEqual({ scanned: 0, ingested: 0, cursorAdvanced: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-hub-reconciliation-pull.test.ts`
Expected: FAIL — `runReconciliationPull` is not exported.

- [ ] **Step 3: Implement `runReconciliationPull`**

Append to `src/services/scholarship-application-sync.service.ts`:

```typescript
import { loadScholarshipHubPartnerContext } from "@/lib/connectors/scholarship-hub-partner-client";
import { PlatformCredential } from "@/models";

type PartnerApplicationDTO = HubApplicationPayload; // Plan 2A's wire shape matches HubApplicationPayload exactly.

/**
 * The reconciliation backbone — called by the cron (below) on a schedule,
 * and by the webhook receiver (Task 5) immediately on a valid signed ping.
 * Walks the partner list endpoint from the stored cursor until caught up
 * (a page whose `hasMore` is false), ingesting every item through the SAME
 * `upsertFromHubPayload` the webhook path uses — this is what makes a
 * missed or failed webhook non-fatal: the next scheduled run of this same
 * function backfills it.
 *
 * The list endpoint always returns a real, usable `nextCursor` whenever a
 * page has ≥1 item (even the terminal/non-full page) — `nextCursor` is
 * `null` only for a genuinely empty page. `hasMore` is the sole signal for
 * whether another page exists; IDAP never decodes or reconstructs a
 * cursor itself, it only ever persists and replays the opaque value the
 * Hub hands back.
 */
export async function runReconciliationPull(): Promise<{
  scanned: number;
  ingested: number;
  cursorAdvanced: boolean;
}> {
  const ctx = await loadScholarshipHubPartnerContext();
  const stored = await PlatformCredential.findOne({ platform: "SCHOLARSHIP_HUB", active: true })
    .select("applicationsSyncCursor")
    .lean();

  let cursor = stored?.applicationsSyncCursor;
  const initialCursor = cursor;
  let scanned = 0;
  let ingested = 0;

  // Bounded loop: a safety cap on pages so a misbehaving upstream (an
  // endless `hasMore: true` chain) can never hang this call forever. 50
  // pages at 200/page is 10,000 applications per run — far beyond one poll
  // cycle's realistic volume.
  for (let page = 0; page < 50; page += 1) {
    const query = cursor ? `?since=${encodeURIComponent(cursor)}&limit=200` : `?limit=200`;
    const resp = await ctx.http(`/api/partner/applications${query}`, { method: "GET", token: ctx.platformKey });
    if (resp.status !== 200) break;

    const body = resp.body as { items: PartnerApplicationDTO[]; nextCursor: string | null; hasMore: boolean };
    scanned += body.items.length;

    for (const item of body.items) {
      const outcome = await upsertFromHubPayload(item);
      if (outcome.kind === "INSERTED" || outcome.kind === "UPDATED") ingested += 1;
    }

    if (body.nextCursor) cursor = body.nextCursor;
    if (!body.hasMore) break;
  }

  const cursorAdvanced = cursor !== undefined && cursor !== initialCursor;
  if (cursorAdvanced) {
    await PlatformCredential.updateOne(
      { platform: "SCHOLARSHIP_HUB" },
      { $set: { applicationsSyncCursor: cursor } },
    );
  }

  return { scanned, ingested, cursorAdvanced };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-hub-reconciliation-pull.test.ts`
Expected: PASS

- [ ] **Step 5: Add the cron route**

Create `src/app/api/cron/scholarship-hub-sync/route.ts`:

```typescript
import { runReconciliationPull } from "@/services/scholarship-application-sync.service";
import { jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel signs its own cron requests with this header when CRON_SECRET is
 * set — no session, no CSRF, this is a machine-to-machine endpoint, exactly
 * mirroring `follow-up-reminders`'s own cron route.
 */
export async function GET(request: Request) {
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== expected) {
    return new Response(null, { status: 401 });
  }

  const result = await runReconciliationPull();
  return jsonSuccess(result);
}
```

- [ ] **Step 6: Write the failing cron-route test**

Create `tests/integration/scholarship-hub-sync-cron.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { PlatformCredential } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";

const ORIGINAL_SECRET = process.env.CRON_SECRET;
const ORIGINAL_KEY = process.env.IDAP_CREDENTIAL_KEY;

beforeAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  return startTestDatabase("scholarship-hub-sync-cron");
});
afterAll(() => {
  process.env.CRON_SECRET = ORIGINAL_SECRET;
  process.env.IDAP_CREDENTIAL_KEY = ORIGINAL_KEY;
  return stopTestDatabase();
});
beforeEach(async () => {
  await clearDatabase();
  process.env.CRON_SECRET = "test-cron-secret";
});
afterEach(() => vi.unstubAllGlobals());

function cronRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  return { headers } as unknown as Request;
}

describe("GET /api/cron/scholarship-hub-sync", () => {
  it("401s without the correct CRON_SECRET", async () => {
    const { GET } = await import("@/app/api/cron/scholarship-hub-sync/route");
    expect((await GET(cronRequest("wrong"))).status).toBe(401);
    expect((await GET(cronRequest())).status).toBe(401);
  });

  it("runs the pull and returns its summary when authorized", async () => {
    await PlatformCredential.create({
      platform: "SCHOLARSHIP_HUB", keyEncrypted: encryptCredential("sh_pkey_test"),
      baseUrl: "https://hub.test", active: true,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), { status: 200 })));

    const { GET } = await import("@/app/api/cron/scholarship-hub-sync/route");
    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; scanned: number };
    expect(body.success).toBe(true);
    expect(body.scanned).toBe(0);
  });
});
```

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-hub-sync-cron.test.ts`
Expected: PASS

- [ ] **Step 7: Register the cron in `vercel.json`**

Modify `vercel.json` — add a second entry to the `crons` array:

```json
{
  "crons": [
    {
      "path": "/api/cron/follow-up-reminders",
      "schedule": "0 2 * * *"
    },
    {
      "path": "/api/cron/scholarship-hub-sync",
      "schedule": "*/10 * * * *"
    }
  ]
}
```

- [ ] **Step 8: Commit**

```bash
git add src/services/scholarship-application-sync.service.ts \
        src/app/api/cron/scholarship-hub-sync/route.ts \
        tests/integration/scholarship-hub-reconciliation-pull.test.ts \
        tests/integration/scholarship-hub-sync-cron.test.ts \
        vercel.json
git commit -m "feat(scholarship-applications): reconciliation pull + cron (sync-back 2B/4)"
```

---

### Task 5: Inbound webhook receiver (`POST /api/webhooks/scholarship-hub`)

**Files:**
- Create: `src/app/api/webhooks/scholarship-hub/route.ts`
- Test: `tests/integration/scholarship-hub-webhook.test.ts`

**Interfaces:**
- Consumes: `loadScholarshipHubWebhookSecret` (Task 2), `runReconciliationPull` (Task 4), `consumeRateLimit`/`rateLimitHeaders` (`@/lib/security/rate-limit`), `getClientIp` (`@/lib/security/request`), `jsonError`/`jsonSuccess` (`@/lib/api/response`).
- Produces: nothing new — this is a leaf route. **Ruling, recorded here:** Plan 2A exposes only the cursor-list endpoint, not a single-item detail fetch, so "pull the full application detail from the same endpoint the poll uses" (spec §2.1) means: on a valid signed ping, trigger an immediate run of Task 4's `runReconciliationPull()` rather than a separate per-item HTTP call. This reuses 100% of the ingestion/ordering/idempotency logic, needs no new Hub endpoint, and is MORE robust than a single-item fetch (it naturally catches up on anything else pending too) — consistent with the spec's own design philosophy that push is a latency optimization over a pull that is the correctness guarantee.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/scholarship-hub-webhook.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { PlatformCredential } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";

const ORIGINAL_KEY = process.env.IDAP_CREDENTIAL_KEY;
const SECRET = "sh_whsec_test";

beforeAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  return startTestDatabase("scholarship-hub-webhook");
});
afterAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = ORIGINAL_KEY;
  return stopTestDatabase();
});
beforeEach(clearDatabase);
afterEach(() => vi.unstubAllGlobals());

async function withSecret() {
  await PlatformCredential.create({
    platform: "SCHOLARSHIP_HUB",
    keyEncrypted: encryptCredential("sh_pkey_test"),
    webhookSecretEncrypted: encryptCredential(SECRET),
    baseUrl: "https://hub.test",
    active: true,
  });
}

/**
 * Signs `${timestampSeconds}.${rawBody}` (Stripe-style) — the Hub's
 * dispatcher signs this exact concatenation, not the raw body alone, so the
 * timestamp itself is covered by the signature and can't be swapped onto a
 * captured valid signature to defeat the replay window.
 */
function sign(body: string, timestampSeconds: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex")}`;
}

function webhookRequest(body: string, opts: { signature?: string; timestamp?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.signature !== undefined) headers.set("x-sh-signature", opts.signature);
  if (opts.timestamp !== undefined) headers.set("x-sh-timestamp", opts.timestamp);
  return new Request("https://idap.test/api/webhooks/scholarship-hub", { method: "POST", headers, body });
}

const validPayload = JSON.stringify({
  event: "application.changed",
  externalRef: "IDAP:INS0001:507f1f77bcf86cd799439011",
  hubApplicationId: "507f191e810c19729de860ea",
  changedAt: new Date().toISOString(),
});

describe("POST /api/webhooks/scholarship-hub", () => {
  it("401s when no webhook secret has been configured yet", async () => {
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    const response = await POST(webhookRequest(validPayload, { signature: sign(validPayload, now), timestamp: now }));
    expect(response.status).toBe(401);
  });

  it("401s on a missing or malformed signature header", async () => {
    await withSecret();
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    expect((await POST(webhookRequest(validPayload, { timestamp: now }))).status).toBe(401);
    expect((await POST(webhookRequest(validPayload, { signature: "not-a-real-signature", timestamp: now }))).status).toBe(401);
  });

  it("401s when the signature was computed with the wrong secret", async () => {
    await withSecret();
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    const response = await POST(webhookRequest(validPayload, { signature: sign(validPayload, now, "sh_whsec_wrong"), timestamp: now }));
    expect(response.status).toBe(401);
  });

  it("401s on a timestamp outside the replay window, even when genuinely signed with that stale timestamp", async () => {
    await withSecret();
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    // A real sender would sign `${old}.${body}` and send `X-SH-Timestamp: old`
    // together — consistent, validly-signed, but stale. This must fail at
    // the replay-window check, not the signature check.
    const old = String(Math.floor(Date.now() / 1000) - 10_000);
    const response = await POST(webhookRequest(validPayload, { signature: sign(validPayload, old), timestamp: old }));
    expect(response.status).toBe(401);
  });

  it("400s on a well-signed but malformed body", async () => {
    await withSecret();
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    const badBody = JSON.stringify({ event: "application.changed" }); // missing required fields
    const response = await POST(webhookRequest(badBody, { signature: sign(badBody, now), timestamp: now }));
    expect(response.status).toBe(400);
  });

  it("verifies against the RAW body, not a re-serialized one (whitespace matters)", async () => {
    await withSecret();
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    // Same JSON content, different literal bytes (extra space) — the
    // signature was computed over `validPayload`, so it must NOT verify
    // against this semantically-equal-but-byte-different body.
    const respaced = validPayload.replace('"event"', '"event" ');
    const response = await POST(webhookRequest(respaced, { signature: sign(validPayload, now), timestamp: now }));
    expect(response.status).toBe(401);
  });

  it("401s when the signature was computed over a DIFFERENT timestamp than the one sent in the header", async () => {
    await withSecret();
    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    const otherTimestamp = String(Number(now) - 1);
    // Proves the timestamp is genuinely covered by the signature: signing
    // with one timestamp and presenting a different one in the header (even
    // one still inside the replay window) must fail verification — a
    // captured valid signature can no longer be replayed with a fresh
    // X-SH-Timestamp.
    const response = await POST(webhookRequest(validPayload, { signature: sign(validPayload, otherTimestamp), timestamp: now }));
    expect(response.status).toBe(401);
  });

  it("triggers a reconciliation pull and returns 200 on a validly signed, well-formed ping", async () => {
    await withSecret();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    const response = await POST(webhookRequest(validPayload, { signature: sign(validPayload, now), timestamp: now }));

    expect(response.status).toBe(200);
    // The pull hit the Hub's list endpoint — proof it actually ran, not just
    // returned 200 without doing anything.
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("returns 500 (so the Hub retries) when the triggered pull itself fails", async () => {
    await withSecret();
    // Force a real throw (not just a non-2xx response) to simulate a
    // network failure, which is what makes runReconciliationPull itself
    // reject rather than just returning a PARTIAL/short result.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    const { POST } = await import("@/app/api/webhooks/scholarship-hub/route");
    const now = String(Math.floor(Date.now() / 1000));
    const response = await POST(webhookRequest(validPayload, { signature: sign(validPayload, now), timestamp: now }));
    expect(response.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-hub-webhook.test.ts`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement the route**

Create `src/app/api/webhooks/scholarship-hub/route.ts`:

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { loadScholarshipHubWebhookSecret } from "@/lib/connectors/scholarship-hub-partner-client";
import { runReconciliationPull } from "@/services/scholarship-application-sync.service";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { jsonError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RATE_LIMIT = { limit: 60, windowSeconds: 60 };
/** How far a signature's timestamp may drift from "now" before it's treated as a replay. */
const SIGNATURE_WINDOW_SECONDS = 300;
const MAX_BODY_BYTES = 10_000;

const webhookPayloadSchema = z.object({
  event: z.literal("application.changed"),
  externalRef: z.string(),
  hubApplicationId: z.string(),
  changedAt: z.string(),
});

/**
 * Verifies against `${timestampHeader}.${rawBody}` (Stripe-style) — NOT the
 * raw body alone. The timestamp value is the literal `X-SH-Timestamp`
 * header string, taken as-is (not re-formatted), concatenated with a `.`
 * then the exact raw body text — not a re-`JSON.stringify`d one, which
 * could differ in whitespace/key order from what was actually signed.
 * Covering the timestamp in the signature is what makes the replay window
 * below meaningful: a captured valid signature can no longer be replayed
 * with a fresh `X-SH-Timestamp`, because changing the timestamp changes
 * what the signature must cover.
 *
 * Mirrors `verifySecret`'s (`src/lib/security/tokens.ts`)
 * length-check-before-`timingSafeEqual` shape: `timingSafeEqual` throws on
 * unequal-length buffers, so the length check must come first.
 */
function verifySignature(rawBody: string, timestampHeader: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const signedPayload = `${timestampHeader}.${rawBody}`;
  const expectedHex = createHmac("sha256", secret).update(signedPayload).digest("hex");
  const candidate = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (candidate.length === 0 || candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/**
 * IDAP's first externally-reachable inbound POST receiver. Order of checks
 * is deliberate: rate limit and body-size cap first (cheap, protects
 * against flooding before any crypto work), THEN signature — which now
 * requires the raw `X-SH-Timestamp` header value as an input, so that
 * header is read (but NOT yet validated as "recent") before the signature
 * check runs — THEN the replay-window check on that same timestamp value,
 * THEN shape validation, THEN the actual work. No branch below the
 * signature check can be reached without a valid HMAC over this exact
 * body AND this exact timestamp.
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const limit = await consumeRateLimit(`webhook:scholarship-hub:${ip}`, RATE_LIMIT.limit, RATE_LIMIT.windowSeconds);
  if (!limit.allowed) {
    return jsonError("RATE_LIMITED", "Too many webhook deliveries.", { headers: rateLimitHeaders(limit) });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  const secret = await loadScholarshipHubWebhookSecret();
  if (!secret) return new Response(null, { status: 401 });

  const timestampHeader = request.headers.get("x-sh-timestamp");
  if (!timestampHeader || !verifySignature(rawBody, timestampHeader, request.headers.get("x-sh-signature"), secret)) {
    return new Response(null, { status: 401 });
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_WINDOW_SECONDS) {
    return new Response(null, { status: 401 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return new Response(null, { status: 400 });
  }
  const result = webhookPayloadSchema.safeParse(parsedBody);
  if (!result.success) return new Response(null, { status: 400 });

  try {
    await runReconciliationPull();
  } catch (error) {
    console.error("[webhook] scholarship-hub triggered pull failed", error);
    return new Response(null, { status: 500 });
  }

  return jsonSuccess({ received: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-hub-webhook.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/webhooks/scholarship-hub/route.ts tests/integration/scholarship-hub-webhook.test.ts
git commit -m "feat(scholarship-applications): signed inbound webhook receiver (sync-back 2B/5)"
```

---

### Task 6: Document proxy

**Files:**
- Create: `src/app/api/scholarship-applications/[id]/documents/[key]/file/route.ts`
- Modify: `src/lib/constants.ts`
- Test: `tests/integration/scholarship-application-document-proxy.test.ts`

**Interfaces:**
- Consumes: `fetchScholarshipHubDocument` (Task 2), `ScholarshipApplication` (Task 1), `requireApiUser`/`tenantFilter` (`@/lib/tenant`), `requirePermission` (`@/lib/tenant/permissions`), `consumeRateLimit`/`rateLimitHeaders` (`@/lib/security/rate-limit`), `handleApiError`/`jsonError` (`@/lib/api/response`).
- Produces: the `SCHOLARSHIP_APPLICATIONS_VIEW` permission constant (also consumed by Task 7/8) — added here since this is the first task that needs it; Task 7 adds the remaining two (`DECIDE`/`ASSIGN`).

- [ ] **Step 1: Add the first new permission**

In `src/lib/constants.ts`, add to the `PERMISSIONS` array (after `APPLICATIONS_DECIDE`):

```typescript
  "APPLICATIONS_VIEW",
  "APPLICATIONS_CREATE",
  "APPLICATIONS_DECIDE",
  // Scholarship Hub applications carry the same applicant-PII sensitivity as
  // admission applications — a separate permission namespace (not reusing
  // APPLICATIONS_*) because an institution may want different staff to see
  // these than its admission pipeline.
  "SCHOLARSHIP_APPLICATIONS_VIEW",
] as const;
```

And grant it to `INSTITUTION_ADMIN` AND `COUNSELOR` (per the spec's explicit decision — unlike admission `APPLICATIONS_VIEW`, which is INSTITUTION_ADMIN-only) in `ROLE_PERMISSIONS`:

```typescript
  INSTITUTION_ADMIN: new Set([
    // ...existing entries...
    "APPLICATIONS_VIEW",
    "APPLICATIONS_CREATE",
    "APPLICATIONS_DECIDE",
    "SCHOLARSHIP_APPLICATIONS_VIEW",
  ]),
  COUNSELOR: new Set(["LEADS_VIEW_OWN", "LEADS_UPDATE", "LEADS_SET_FOLLOWUP", "SCHOLARSHIP_APPLICATIONS_VIEW"]),
```

- [ ] **Step 2: Write the failing test**

Create `tests/integration/scholarship-application-document-proxy.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { Types } from "mongoose";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { ScholarshipApplication, PlatformCredential } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";
import type { NextRequest } from "next/server";

const ORIGINAL_KEY = process.env.IDAP_CREDENTIAL_KEY;

beforeAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  return startTestDatabase("scholarship-application-document-proxy");
});
afterAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = ORIGINAL_KEY;
  return stopTestDatabase();
});
beforeEach(clearDatabase);
afterEach(() => vi.unstubAllGlobals());

function routeRequest() {
  const url = new URL("http://localhost/api/scholarship-applications/x/documents/y/file");
  const headers = new Headers({ host: "localhost" });
  return { headers, nextUrl: url, url: url.toString() } as unknown as NextRequest;
}

async function signIn(institutionId: string, role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK") {
  const user = await makeUser(institutionId, role);
  const token = await signSession({ sub: String(user._id), role, institutionId, name: user.name, email: user.email, v: 0 });
  (await cookies()).set(SESSION_COOKIE, token);
  return user;
}

async function makeApplication(institutionId: string, documents: { key: string }[] = [{ key: "income_certificate" }]) {
  await PlatformCredential.create({ platform: "SCHOLARSHIP_HUB", keyEncrypted: encryptCredential("sh_pkey_test"), baseUrl: "https://hub.test", active: true });
  return ScholarshipApplication.create({
    institutionId, scholarshipId: new Types.ObjectId(), externalRef: `IDAP:${institutionId}:${new Types.ObjectId().toHexString()}`,
    hubApplicationId: "hub-app-1", applicant: { name: "Asha Rao" }, hubStatus: "submitted",
    documents: documents.map((d) => ({ ...d, label: "Income Certificate", filename: "income.pdf", contentType: "application/pdf" })),
    hubUpdatedAt: new Date(), lastSyncedAt: new Date(),
  });
}

describe("GET /api/scholarship-applications/[id]/documents/[key]/file", () => {
  it("streams the file when it belongs to this institution's application", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "INSTITUTION_ADMIN");
    const application = await makeApplication("INS0001");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("file-bytes", {
      status: 200,
      headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="income.pdf"' },
    })));

    const { GET } = await import("@/app/api/scholarship-applications/[id]/documents/[key]/file/route");
    const response = await GET(routeRequest(), {
      params: Promise.resolve({ id: String(application._id), key: "income_certificate" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await response.text()).toBe("file-bytes");
  });

  it("404s for another institution's application", async () => {
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
    await signIn("INS0001", "INSTITUTION_ADMIN");
    const application = await makeApplication("INS0002");

    const { GET } = await import("@/app/api/scholarship-applications/[id]/documents/[key]/file/route");
    const response = await GET(routeRequest(), {
      params: Promise.resolve({ id: String(application._id), key: "income_certificate" }),
    });
    expect(response.status).toBe(404);
  });

  it("404s for an unknown document key on a real application", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "INSTITUTION_ADMIN");
    const application = await makeApplication("INS0001");

    const { GET } = await import("@/app/api/scholarship-applications/[id]/documents/[key]/file/route");
    const response = await GET(routeRequest(), {
      params: Promise.resolve({ id: String(application._id), key: "nonexistent" }),
    });
    expect(response.status).toBe(404);
  });

  it("403s for FRONT_DESK, which holds no SCHOLARSHIP_APPLICATIONS_VIEW permission", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "FRONT_DESK");
    const application = await makeApplication("INS0001");

    const { GET } = await import("@/app/api/scholarship-applications/[id]/documents/[key]/file/route");
    const response = await GET(routeRequest(), {
      params: Promise.resolve({ id: String(application._id), key: "income_certificate" }),
    });
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-application-document-proxy.test.ts`
Expected: FAIL — route does not exist.

- [ ] **Step 4: Implement the route**

Create `src/app/api/scholarship-applications/[id]/documents/[key]/file/route.ts`:

```typescript
import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { fetchScholarshipHubDocument } from "@/lib/connectors/scholarship-hub-partner-client";
import { ScholarshipApplication } from "@/models";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { handleApiError, jsonError } from "@/lib/api/response";

export const dynamic = "force-dynamic";

const DOCUMENT_RATE_LIMIT = { limit: 120, windowSeconds: 900 };

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/scholarship-applications/[id]/documents/[key]/file">,
) {
  try {
    const { user } = await requireApiUser(request);
    requirePermission(user, "SCHOLARSHIP_APPLICATIONS_VIEW");
    const { id, key } = await context.params;

    const limit = await consumeRateLimit(`scholarship-app-doc:${user.id}`, DOCUMENT_RATE_LIMIT.limit, DOCUMENT_RATE_LIMIT.windowSeconds);
    if (!limit.allowed) {
      return jsonError("RATE_LIMITED", "You've requested a lot of documents recently. Please slow down.", { headers: rateLimitHeaders(limit) });
    }

    const application = await ScholarshipApplication.findOne({ _id: id, ...tenantFilter(user) })
      .select("hubApplicationId documents")
      .lean();
    if (!application) return jsonError("NOT_FOUND", "Document not found", { status: 404 });

    const hasDocument = (application.documents ?? []).some((d) => d.key === key);
    if (!hasDocument) return jsonError("NOT_FOUND", "Document not found", { status: 404 });

    const upstream = await fetchScholarshipHubDocument(application.hubApplicationId, key);
    if (!upstream.ok || !upstream.body) {
      return jsonError("NOT_FOUND", "Document not found", { status: 404 });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "Content-Disposition": upstream.headers.get("content-disposition") ?? "attachment",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-application-document-proxy.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/api/scholarship-applications/[id]/documents/[key]/file/route.ts src/lib/constants.ts tests/integration/scholarship-application-document-proxy.test.ts
git commit -m "feat(scholarship-applications): document proxy + SCHOLARSHIP_APPLICATIONS_VIEW permission (sync-back 2B/6)"
```

---

### Task 7: Dashboard service (list/get/assign/decide) + the remaining permissions

**Files:**
- Modify: `src/lib/constants.ts`
- Modify: `src/lib/validation/application.ts` (or create `src/lib/validation/scholarship-application.ts` — see Step 1)
- Create: `src/services/scholarship-application.service.ts`
- Create: `src/app/api/scholarship-applications/[id]/route.ts`
- Create: `src/app/api/scholarship-applications/[id]/assign/route.ts`
- Test: `tests/integration/scholarship-application-service.test.ts`
- Test: `tests/integration/scholarship-application-routes.test.ts`

**Interfaces:**
- Consumes: `ScholarshipApplication`/`ScholarshipApplicationDoc` (Task 1), `tenantFilter`/`requireApiUser` (`@/lib/tenant`), `requirePermission`/`hasPermission` (`@/lib/tenant/permissions`), `ActivityService.record` (`@/services/activity.service`), `assertSameOrigin` (`@/lib/api/csrf`).
- Produces: `SCHOLARSHIP_APPLICATIONS_DECIDE`/`SCHOLARSHIP_APPLICATIONS_ASSIGN` permissions; `ScholarshipApplicationDTO` (type); `ScholarshipApplicationService.list/get/assign/updateReviewStatus` — Task 8's UI consumes all four directly (server components call `list`/`get`; the two client controls call the two new routes, which call `assign`/`updateReviewStatus`).

- [ ] **Step 1: Add the remaining two permissions**

In `src/lib/constants.ts`, extend the `PERMISSIONS` array and `ROLE_PERMISSIONS`:

```typescript
  "SCHOLARSHIP_APPLICATIONS_VIEW",
  "SCHOLARSHIP_APPLICATIONS_DECIDE",
  "SCHOLARSHIP_APPLICATIONS_ASSIGN",
] as const;
```

```typescript
  INSTITUTION_ADMIN: new Set([
    // ...existing entries, including SCHOLARSHIP_APPLICATIONS_VIEW from Task 6...
    "SCHOLARSHIP_APPLICATIONS_DECIDE",
    "SCHOLARSHIP_APPLICATIONS_ASSIGN",
  ]),
  COUNSELOR: new Set([
    "LEADS_VIEW_OWN", "LEADS_UPDATE", "LEADS_SET_FOLLOWUP",
    "SCHOLARSHIP_APPLICATIONS_VIEW", "SCHOLARSHIP_APPLICATIONS_DECIDE",
  ]),
```

(`COUNSELOR` gets `DECIDE` but not `ASSIGN` — a counselor works the applications assigned to them, but reassignment is an admin action, mirroring the Lead permission split where `LEADS_ASSIGN` is INSTITUTION_ADMIN-only.)

- [ ] **Step 2: Add the query/mutation validation schemas**

Create `src/lib/validation/scholarship-application.ts`:

```typescript
import { z } from "zod";
import { HUB_APPLICATION_STATUSES, SCHOLARSHIP_APPLICATION_REVIEW_STATUSES } from "@/lib/constants";

export const scholarshipApplicationQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  hubStatus: z.enum(HUB_APPLICATION_STATUSES).optional(),
  reviewStatus: z.enum(SCHOLARSHIP_APPLICATION_REVIEW_STATUSES).optional(),
  assignedTo: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ScholarshipApplicationQuery = z.infer<typeof scholarshipApplicationQuerySchema>;

export const updateScholarshipApplicationReviewStatusSchema = z.object({
  reviewStatus: z.enum(SCHOLARSHIP_APPLICATION_REVIEW_STATUSES),
});

export const assignScholarshipApplicationSchema = z.object({
  assignedTo: z.string().min(1).nullable(),
});
```

- [ ] **Step 3: Write the failing service test**

Create `tests/integration/scholarship-application-service.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Types } from "mongoose";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { ScholarshipApplication, Activity } from "@/models";
import { ScholarshipApplicationService } from "@/services/scholarship-application.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(() => startTestDatabase("scholarship-application-service"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

async function makeApplication(institutionId: string, overrides: Record<string, unknown> = {}) {
  return ScholarshipApplication.create({
    institutionId, scholarshipId: new Types.ObjectId(), externalRef: `IDAP:${institutionId}:${new Types.ObjectId().toHexString()}`,
    hubApplicationId: new Types.ObjectId().toHexString(), applicant: { name: "Asha Rao" }, hubStatus: "submitted",
    hubUpdatedAt: new Date(), lastSyncedAt: new Date(), ...overrides,
  });
}

describe("ScholarshipApplicationService.list", () => {
  it("scopes strictly to one tenant", async () => {
    await makeApplication("INS0001");
    await makeApplication("INS0002");
    const result = await ScholarshipApplicationService.list({ institutionId: "INS0001" }, {});
    expect(result.total).toBe(1);
  });

  it("filters by hubStatus and reviewStatus independently", async () => {
    await makeApplication("INS0001", { hubStatus: "withdrawn" });
    await makeApplication("INS0001", { hubStatus: "submitted", reviewStatus: "SHORTLISTED" });

    expect((await ScholarshipApplicationService.list({ institutionId: "INS0001" }, { hubStatus: "withdrawn" })).total).toBe(1);
    expect((await ScholarshipApplicationService.list({ institutionId: "INS0001" }, { reviewStatus: "SHORTLISTED" })).total).toBe(1);
  });

  it("paginates", async () => {
    for (let i = 0; i < 5; i += 1) await makeApplication("INS0001");
    const page = await ScholarshipApplicationService.list({ institutionId: "INS0001" }, { page: 2, pageSize: 2 });
    expect(page.total).toBe(5);
    expect(page.totalPages).toBe(3);
    expect(page.items).toHaveLength(2);
  });
});

describe("ScholarshipApplicationService.assign", () => {
  it("assigns and audits", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR");
    const application = await makeApplication("INS0001");

    const updated = await ScholarshipApplicationService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: String(application._id),
      assignedTo: String(counselor._id),
      actor,
    });

    expect(updated.assignedTo).toBe(String(counselor._id));
    expect(updated.assignedAt).toBeDefined();
    const activity = await Activity.find({ entityType: "SCHOLARSHIP_APPLICATION", entityId: application._id }).lean();
    expect(activity.some((a) => a.action.toLowerCase().includes("assign"))).toBe(true);
  });

  it("never reaches across tenants", async () => {
    const application = await makeApplication("INS0002");
    await expect(
      ScholarshipApplicationService.assign({
        tenantClause: { institutionId: "INS0001" },
        id: String(application._id),
        assignedTo: "someone",
        actor,
      }),
    ).rejects.toThrow();
  });
});

describe("ScholarshipApplicationService.updateReviewStatus", () => {
  it("updates reviewStatus and audits, leaving hubStatus untouched", async () => {
    const application = await makeApplication("INS0001", { hubStatus: "submitted" });

    const updated = await ScholarshipApplicationService.updateReviewStatus({
      tenantClause: { institutionId: "INS0001" },
      id: String(application._id),
      reviewStatus: "SHORTLISTED",
      actor,
    });

    expect(updated.reviewStatus).toBe("SHORTLISTED");
    expect(updated.hubStatus).toBe("submitted");
  });

  it("a withdrawn-on-Hub application can still have its reviewStatus changed (both coexist)", async () => {
    const application = await makeApplication("INS0001", { hubStatus: "withdrawn" });
    const updated = await ScholarshipApplicationService.updateReviewStatus({
      tenantClause: { institutionId: "INS0001" },
      id: String(application._id),
      reviewStatus: "APPROVED",
      actor,
    });
    expect(updated.hubStatus).toBe("withdrawn");
    expect(updated.reviewStatus).toBe("APPROVED");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-application-service.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 5: Implement the service**

Create `src/services/scholarship-application.service.ts`:

```typescript
import "server-only";
import { Types, type FilterQuery } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { ScholarshipApplication } from "@/models";
import type { ScholarshipApplicationDoc } from "@/models";
import { ActivityService } from "./activity.service";
import { notFound } from "@/lib/api/errors";
import type { ScholarshipApplicationQuery } from "@/lib/validation/scholarship-application";
import type { HubApplicationStatus, ScholarshipApplicationReviewStatus } from "@/lib/constants";

export type ScholarshipApplicationDTO = {
  id: string;
  scholarshipId: string;
  externalRef: string;
  hubApplicationId: string;
  applicationNo?: string;
  applicant: { name: string; email?: string; mobile?: string };
  answers: Record<string, unknown>;
  documents: { key: string; label: string; filename: string; contentType: string }[];
  hubStatus: HubApplicationStatus;
  reviewStatus: ScholarshipApplicationReviewStatus;
  assignedTo?: string;
  assignedAt?: string;
  submittedAt?: string;
  withdrawnAt?: string;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type Paginated<T> = { items: T[]; total: number; page: number; pageSize: number; totalPages: number };

function serialize(doc: ScholarshipApplicationDoc): ScholarshipApplicationDTO {
  return {
    id: String(doc._id),
    scholarshipId: String(doc.scholarshipId),
    externalRef: doc.externalRef,
    hubApplicationId: doc.hubApplicationId,
    ...(doc.applicationNo !== undefined ? { applicationNo: doc.applicationNo } : {}),
    applicant: { name: doc.applicant.name, ...(doc.applicant.email ? { email: doc.applicant.email } : {}), ...(doc.applicant.mobile ? { mobile: doc.applicant.mobile } : {}) },
    answers: (doc.answers ?? {}) as Record<string, unknown>,
    documents: (doc.documents ?? []).map((d) => ({ key: d.key, label: d.label, filename: d.filename, contentType: d.contentType })),
    hubStatus: doc.hubStatus as HubApplicationStatus,
    reviewStatus: doc.reviewStatus as ScholarshipApplicationReviewStatus,
    ...(doc.assignedTo ? { assignedTo: doc.assignedTo } : {}),
    ...(doc.assignedAt ? { assignedAt: new Date(doc.assignedAt).toISOString() } : {}),
    ...(doc.submittedAt ? { submittedAt: new Date(doc.submittedAt).toISOString() } : {}),
    ...(doc.withdrawnAt ? { withdrawnAt: new Date(doc.withdrawnAt).toISOString() } : {}),
    lastSyncedAt: new Date(doc.lastSyncedAt).toISOString(),
    createdAt: new Date((doc as unknown as { createdAt: Date }).createdAt).toISOString(),
    updatedAt: new Date((doc as unknown as { updatedAt: Date }).updatedAt).toISOString(),
  };
}

function buildFilter(
  tenantClause: Record<string, unknown>,
  query: Partial<ScholarshipApplicationQuery>,
): FilterQuery<ScholarshipApplicationDoc> {
  const filter: FilterQuery<ScholarshipApplicationDoc> = { ...tenantClause };
  if (query.hubStatus) filter.hubStatus = query.hubStatus;
  if (query.reviewStatus) filter.reviewStatus = query.reviewStatus;
  if (query.assignedTo) filter.assignedTo = query.assignedTo;
  if (query.q) filter["applicant.name"] = { $regex: `^${query.q.trim()}`, $options: "i" };
  if (query.from || query.to) {
    filter.createdAt = {
      ...(query.from ? { $gte: new Date(query.from) } : {}),
      ...(query.to ? { $lte: new Date(query.to) } : {}),
    };
  }
  return filter;
}

export const ScholarshipApplicationService = {
  async list(
    tenantClause: Record<string, unknown>,
    query: Partial<ScholarshipApplicationQuery>,
  ): Promise<Paginated<ScholarshipApplicationDTO>> {
    await connectToDatabase();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const filter = buildFilter(tenantClause, query);

    const [rows, total] = await Promise.all([
      ScholarshipApplication.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      ScholarshipApplication.countDocuments(filter),
    ]);

    return {
      items: rows.map((row) => serialize(row as ScholarshipApplicationDoc)),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  },

  async get(tenantClause: Record<string, unknown>, id: string): Promise<ScholarshipApplicationDTO> {
    await connectToDatabase();
    if (!Types.ObjectId.isValid(id)) throw notFound("Scholarship application not found");
    const row = await ScholarshipApplication.findOne({ _id: id, ...tenantClause }).lean();
    if (!row) throw notFound("Scholarship application not found");
    return serialize(row as ScholarshipApplicationDoc);
  },

  async assign(input: {
    tenantClause: Record<string, unknown>;
    id: string;
    assignedTo: string | null;
    actor: { id?: string; name?: string };
  }): Promise<ScholarshipApplicationDTO> {
    await connectToDatabase();
    if (!Types.ObjectId.isValid(input.id)) throw notFound("Scholarship application not found");
    const updated = await ScholarshipApplication.findOneAndUpdate(
      { _id: input.id, ...input.tenantClause },
      input.assignedTo
        ? { $set: { assignedTo: input.assignedTo, assignedAt: new Date() } }
        : { $unset: { assignedTo: "", assignedAt: "" } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Scholarship application not found");

    await ActivityService.record({
      institutionId: String((updated as ScholarshipApplicationDoc).institutionId),
      entityType: "SCHOLARSHIP_APPLICATION",
      entityId: (updated as ScholarshipApplicationDoc)._id,
      action: input.assignedTo ? "Scholarship application assigned" : "Scholarship application unassigned",
      performedBy: input.actor.id,
      performedByName: input.actor.name,
    });

    return serialize(updated as ScholarshipApplicationDoc);
  },

  async updateReviewStatus(input: {
    tenantClause: Record<string, unknown>;
    id: string;
    reviewStatus: ScholarshipApplicationReviewStatus;
    actor: { id?: string; name?: string };
  }): Promise<ScholarshipApplicationDTO> {
    await connectToDatabase();
    if (!Types.ObjectId.isValid(input.id)) throw notFound("Scholarship application not found");
    const updated = await ScholarshipApplication.findOneAndUpdate(
      { _id: input.id, ...input.tenantClause },
      { $set: { reviewStatus: input.reviewStatus } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Scholarship application not found");

    await ActivityService.record({
      institutionId: String((updated as ScholarshipApplicationDoc).institutionId),
      entityType: "SCHOLARSHIP_APPLICATION",
      entityId: (updated as ScholarshipApplicationDoc)._id,
      action: `Review status changed to ${input.reviewStatus}`,
      performedBy: input.actor.id,
      performedByName: input.actor.name,
    });

    return serialize(updated as ScholarshipApplicationDoc);
  },
};
```

- [ ] **Step 6: Run the service test to verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-application-service.test.ts`
Expected: PASS

- [ ] **Step 7: Write the failing route test**

Create `tests/integration/scholarship-application-routes.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Types } from "mongoose";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { ScholarshipApplication } from "@/models";
import type { NextRequest } from "next/server";

beforeAll(() => startTestDatabase("scholarship-application-routes"));
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

function cookieRequest(init: { body?: unknown } = {}) {
  const url = new URL("http://localhost/api/scholarship-applications/x");
  const headers = new Headers({ host: "localhost" });
  return { headers, nextUrl: url, url: url.toString(), json: async () => init.body ?? {} } as unknown as NextRequest;
}

async function signIn(institutionId: string, role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK") {
  const user = await makeUser(institutionId, role);
  const token = await signSession({ sub: String(user._id), role, institutionId, name: user.name, email: user.email, v: 0 });
  (await cookies()).set(SESSION_COOKIE, token);
  return user;
}

async function makeApplication(institutionId: string) {
  return ScholarshipApplication.create({
    institutionId, scholarshipId: new Types.ObjectId(), externalRef: `IDAP:${institutionId}:${new Types.ObjectId().toHexString()}`,
    hubApplicationId: new Types.ObjectId().toHexString(), applicant: { name: "Asha Rao" }, hubStatus: "submitted",
    hubUpdatedAt: new Date(), lastSyncedAt: new Date(),
  });
}

describe("PATCH /api/scholarship-applications/[id]", () => {
  it("updates reviewStatus for INSTITUTION_ADMIN", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "INSTITUTION_ADMIN");
    const application = await makeApplication("INS0001");

    const { PATCH } = await import("@/app/api/scholarship-applications/[id]/route");
    const response = await PATCH(cookieRequest({ body: { reviewStatus: "SHORTLISTED" } }), {
      params: Promise.resolve({ id: String(application._id) }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scholarshipApplication: { reviewStatus: string } };
    expect(body.scholarshipApplication.reviewStatus).toBe("SHORTLISTED");
  });

  it("403s for FRONT_DESK (no SCHOLARSHIP_APPLICATIONS_DECIDE)", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "FRONT_DESK");
    const application = await makeApplication("INS0001");

    const { PATCH } = await import("@/app/api/scholarship-applications/[id]/route");
    const response = await PATCH(cookieRequest({ body: { reviewStatus: "SHORTLISTED" } }), {
      params: Promise.resolve({ id: String(application._id) }),
    });
    expect(response.status).toBe(403);
  });
});

describe("POST /api/scholarship-applications/[id]/assign", () => {
  it("assigns for INSTITUTION_ADMIN", async () => {
    await makeInstitution("INS0001");
    const admin = await signIn("INS0001", "INSTITUTION_ADMIN");
    const counselor = await makeUser("INS0001", "COUNSELOR");
    const application = await makeApplication("INS0001");
    void admin;

    const { POST } = await import("@/app/api/scholarship-applications/[id]/assign/route");
    const response = await POST(cookieRequest({ body: { assignedTo: String(counselor._id) } }), {
      params: Promise.resolve({ id: String(application._id) }),
    });
    expect(response.status).toBe(200);
  });

  it("403s for COUNSELOR (no SCHOLARSHIP_APPLICATIONS_ASSIGN)", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "COUNSELOR");
    const application = await makeApplication("INS0001");

    const { POST } = await import("@/app/api/scholarship-applications/[id]/assign/route");
    const response = await POST(cookieRequest({ body: { assignedTo: "someone" } }), {
      params: Promise.resolve({ id: String(application._id) }),
    });
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-application-routes.test.ts`
Expected: FAIL — routes do not exist.

- [ ] **Step 9: Implement the two mutation routes**

Create `src/app/api/scholarship-applications/[id]/route.ts`:

```typescript
import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { assertSameOrigin } from "@/lib/api/csrf";
import { updateScholarshipApplicationReviewStatusSchema } from "@/lib/validation/scholarship-application";
import { ScholarshipApplicationService } from "@/services/scholarship-application.service";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/scholarship-applications/[id]">,
) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    requirePermission(user, "SCHOLARSHIP_APPLICATIONS_DECIDE");
    const { id } = await context.params;

    const body = await request.json().catch(() => ({}));
    const { reviewStatus } = updateScholarshipApplicationReviewStatusSchema.parse(body);

    const scholarshipApplication = await ScholarshipApplicationService.updateReviewStatus({
      tenantClause: tenantFilter(user),
      id,
      reviewStatus,
      actor: { id: user.id, name: user.name },
    });

    return jsonSuccess({ scholarshipApplication });
  } catch (error) {
    return handleApiError(error);
  }
}
```

Create `src/app/api/scholarship-applications/[id]/assign/route.ts`:

```typescript
import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { assertSameOrigin } from "@/lib/api/csrf";
import { assignScholarshipApplicationSchema } from "@/lib/validation/scholarship-application";
import { ScholarshipApplicationService } from "@/services/scholarship-application.service";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/scholarship-applications/[id]/assign">,
) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    requirePermission(user, "SCHOLARSHIP_APPLICATIONS_ASSIGN");
    const { id } = await context.params;

    const body = await request.json().catch(() => ({}));
    const { assignedTo } = assignScholarshipApplicationSchema.parse(body);

    const scholarshipApplication = await ScholarshipApplicationService.assign({
      tenantClause: tenantFilter(user),
      id,
      assignedTo,
      actor: { id: user.id, name: user.name },
    });

    return jsonSuccess({ scholarshipApplication });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/integration/scholarship-application-routes.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/lib/constants.ts src/lib/validation/scholarship-application.ts \
        src/services/scholarship-application.service.ts \
        src/app/api/scholarship-applications/[id]/route.ts \
        src/app/api/scholarship-applications/[id]/assign/route.ts \
        tests/integration/scholarship-application-service.test.ts \
        tests/integration/scholarship-application-routes.test.ts
git commit -m "feat(scholarship-applications): dashboard service + decide/assign permissions (sync-back 2B/7)"
```

---

### Task 8: Inbox UI

**Files:**
- Create: `src/components/scholarship-applications/scholarship-application-review-status-control.tsx`
- Create: `src/components/scholarship-applications/scholarship-application-assign-control.tsx`
- Create: `src/components/scholarship-applications/scholarship-applications-table.tsx`
- Create: `src/components/scholarship-applications/scholarship-applications-list-view.tsx`
- Create: `src/lib/scholarship-applications/status-display.ts`
- Create: `src/app/(dashboard)/scholarship-applications/page.tsx`
- Create: `src/app/(dashboard)/scholarship-applications/[id]/page.tsx`
- Test: `tests/unit/scholarship-application-status-display.test.ts`

**Interfaces:**
- Consumes: `ScholarshipApplicationService` (Task 7), `HUB_APPLICATION_STATUSES`/`SCHOLARSHIP_APPLICATION_REVIEW_STATUSES` (Task 1), `FilterBar`/`Pagination`/`EmptyState`/`PageHeader` (`@/components/shared/*`), `requireTenantUserPage`/`hasPermission`.
- Produces: nothing consumed by a later task — this is the plan's tail task.

- [ ] **Step 1: Write the failing pure-logic test**

No React render harness exists in IDAP (`@testing-library/react` is not installed; `vitest.config.ts` only collects `tests/**/*.test.ts`, never `.tsx`) — the established precedent (Phase 1's `scholarship-listing-display.test.ts`, mirroring `result-editor-logic.test.ts`) is to extract the one piece of DECISION logic behind a status badge into a pure function and test that directly, leaving the component's JSX verified only by `tsc`.

Create `tests/unit/scholarship-application-status-display.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { hubStatusBadge, hubStatusIsClosed } from "@/lib/scholarship-applications/status-display";

describe("hubStatusBadge", () => {
  it("labels every HUB_APPLICATION_STATUSES value distinctly", () => {
    expect(hubStatusBadge("submitted").label).toBe("Submitted");
    expect(hubStatusBadge("under_review").label).toBe("Under review");
    expect(hubStatusBadge("shortlisted").label).toBe("Shortlisted");
    expect(hubStatusBadge("additional_info_required").label).toBe("More info requested");
    expect(hubStatusBadge("approved").label).toBe("Approved");
    expect(hubStatusBadge("rejected").label).toBe("Rejected");
    expect(hubStatusBadge("withdrawn").label).toBe("Withdrawn on Hub");
  });

  it("marks withdrawn with a distinct, attention-drawing variant", () => {
    expect(hubStatusBadge("withdrawn").variant).toBe("destructive");
    expect(hubStatusBadge("submitted").variant).not.toBe("destructive");
  });
});

describe("hubStatusIsClosed", () => {
  it("is true only for withdrawn — the one status the spec's failure matrix says must surface prominently", () => {
    expect(hubStatusIsClosed("withdrawn")).toBe(true);
    expect(hubStatusIsClosed("approved")).toBe(false);
    expect(hubStatusIsClosed("rejected")).toBe(false);
    expect(hubStatusIsClosed("submitted")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-application-status-display.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the pure helper**

Create `src/lib/scholarship-applications/status-display.ts`:

```typescript
import type { HubApplicationStatus } from "@/lib/constants";

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const LABELS: Record<HubApplicationStatus, string> = {
  submitted: "Submitted",
  under_review: "Under review",
  shortlisted: "Shortlisted",
  additional_info_required: "More info requested",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn on Hub",
};

/**
 * `withdrawn` gets the destructive (red) variant deliberately — per the
 * spec's failure matrix, a withdrawn-after-decision application must
 * surface prominently, since `reviewStatus` can still read SHORTLISTED or
 * APPROVED underneath it. Every other status is a neutral/secondary badge.
 */
export function hubStatusBadge(status: HubApplicationStatus): { label: string; variant: BadgeVariant } {
  return { label: LABELS[status], variant: status === "withdrawn" ? "destructive" : "secondary" };
}

export function hubStatusIsClosed(status: HubApplicationStatus): boolean {
  return status === "withdrawn";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --maxWorkers=4 tests/unit/scholarship-application-status-display.test.ts`
Expected: PASS

- [ ] **Step 5: Build the review-status control**

Create `src/components/scholarship-applications/scholarship-application-review-status-control.tsx`, mirroring `src/components/leads/lead-status-control.tsx` exactly:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SCHOLARSHIP_APPLICATION_REVIEW_STATUSES, type ScholarshipApplicationReviewStatus } from "@/lib/constants";

const REVIEW_STATUS_LABELS: Record<ScholarshipApplicationReviewStatus, string> = {
  NEW: "New",
  UNDER_REVIEW: "Under review",
  SHORTLISTED: "Shortlisted",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export function ScholarshipApplicationReviewStatusControl({
  id,
  reviewStatus,
}: {
  id: string;
  reviewStatus: ScholarshipApplicationReviewStatus;
}) {
  const router = useRouter();
  const [value, setValue] = useState<ScholarshipApplicationReviewStatus>(reviewStatus);
  const [saving, setSaving] = useState(false);

  async function change(next: string) {
    const nextStatus = next as ScholarshipApplicationReviewStatus;
    const previous = value;
    setValue(nextStatus);
    setSaving(true);

    try {
      const response = await fetch(`/api/scholarship-applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewStatus: nextStatus }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        setValue(previous);
        toast.error(payload?.error?.message ?? "Could not update the status. Please try again.");
        return;
      }

      toast.success(`Status changed to ${REVIEW_STATUS_LABELS[nextStatus]}`);
      router.refresh();
    } catch {
      setValue(previous);
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Select value={value} onValueChange={change} disabled={saving}>
      <SelectTrigger size="sm" className="min-w-[168px]" aria-label="Review status">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SCHOLARSHIP_APPLICATION_REVIEW_STATUSES.map((option) => (
          <SelectItem key={option} value={option}>
            {REVIEW_STATUS_LABELS[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

- [ ] **Step 6: Build the assign control**

Create `src/components/scholarship-applications/scholarship-application-assign-control.tsx`, mirroring `src/components/leads/lead-assign-control.tsx` exactly (same structure, pointed at `/api/scholarship-applications/{id}/assign`):

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const UNASSIGNED = "__unassigned__";

export function ScholarshipApplicationAssignControl({
  id,
  assignedTo,
  assignees,
}: {
  id: string;
  assignedTo?: string;
  assignees: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(assignedTo ?? UNASSIGNED);
  const [saving, setSaving] = useState(false);

  async function change(next: string) {
    const previous = value;
    setValue(next);
    setSaving(true);

    try {
      const response = await fetch(`/api/scholarship-applications/${id}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedTo: next === UNASSIGNED ? null : next }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        setValue(previous);
        toast.error(payload?.error?.message ?? "Could not reassign. Please try again.");
        return;
      }

      toast.success(next === UNASSIGNED ? "Unassigned" : "Assigned");
      router.refresh();
    } catch {
      setValue(previous);
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Select value={value} onValueChange={change} disabled={saving}>
      <SelectTrigger size="sm" className="min-w-[168px]" aria-label="Assigned to">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
        {assignees.map((person) => (
          <SelectItem key={person.id} value={person.id}>{person.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

- [ ] **Step 7: Build the table**

Create `src/components/scholarship-applications/scholarship-applications-table.tsx`:

```tsx
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { hubStatusBadge } from "@/lib/scholarship-applications/status-display";
import { ScholarshipApplicationReviewStatusControl } from "./scholarship-application-review-status-control";
import type { ScholarshipApplicationDTO } from "@/services/scholarship-application.service";

export function ScholarshipApplicationsTable({
  applications,
}: {
  applications: ScholarshipApplicationDTO[];
}) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs font-medium text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Applicant</th>
            <th className="px-3 py-2">Hub status</th>
            <th className="px-3 py-2">Review status</th>
            <th className="px-3 py-2">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {applications.map((application) => {
            const badge = hubStatusBadge(application.hubStatus);
            return (
              <tr key={application.id} className="border-t">
                <td className="px-3 py-2">
                  <Link href={`/scholarship-applications/${application.id}`} className="font-medium hover:underline">
                    {application.applicant.name}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                  {application.hubStatus === "withdrawn" ? (
                    <p className="mt-1 text-xs text-destructive">Withdrawn on Scholarship Hub</p>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <ScholarshipApplicationReviewStatusControl id={application.id} reviewStatus={application.reviewStatus} />
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {application.submittedAt ? new Date(application.submittedAt).toLocaleDateString() : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

(Verify `@/components/ui/badge` exports a `Badge` component accepting a `variant` prop with at least `"default"|"secondary"|"destructive"|"outline"` — this is a standard shadcn/ui primitive; if the exact variant names differ from `status-display.ts`'s `BadgeVariant` type, align `BadgeVariant` to match the real component rather than the reverse.)

- [ ] **Step 8: Build the list view + its page**

Create `src/components/scholarship-applications/scholarship-applications-list-view.tsx`, mirroring `src/components/applications/applications-list-view.tsx`:

```tsx
import { Suspense } from "react";
import { Inbox } from "lucide-react";
import { ScholarshipApplicationService } from "@/services/scholarship-application.service";
import { scholarshipApplicationQuerySchema } from "@/lib/validation/scholarship-application";
import { HUB_APPLICATION_STATUSES, SCHOLARSHIP_APPLICATION_REVIEW_STATUSES } from "@/lib/constants";
import { tenantFilter } from "@/lib/tenant";
import type { CurrentUser } from "@/lib/auth/current-user";
import { PageHeader } from "@/components/shared/page-header";
import { FilterBar, type FilterDefinition } from "@/components/shared/filter-bar";
import { Pagination } from "@/components/shared/pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ScholarshipApplicationsTable } from "./scholarship-applications-table";
import { Skeleton } from "@/components/ui/skeleton";

export async function ScholarshipApplicationsListView({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const query = scholarshipApplicationQuerySchema.parse(
    Object.fromEntries(Object.entries(searchParams).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])),
  );

  const clause = tenantFilter(user);
  const result = await ScholarshipApplicationService.list(clause, query);

  const filters: FilterDefinition[] = [
    { key: "hubStatus", label: "Hub status", options: HUB_APPLICATION_STATUSES.map((s) => ({ value: s, label: s })) },
    { key: "reviewStatus", label: "Review status", options: SCHOLARSHIP_APPLICATION_REVIEW_STATUSES.map((s) => ({ value: s, label: s })) },
  ];

  const hasFilters = Boolean(query.q || query.hubStatus || query.reviewStatus || query.from || query.to);

  return (
    <>
      <PageHeader title="Scholarship Applications" description="Applications students submitted through Scholarship Hub." />

      <Suspense fallback={<Skeleton className="h-9 w-full max-w-3xl rounded-md" />}>
        <FilterBar searchPlaceholder="Search applicant name..." filters={filters} />
      </Suspense>

      <div className="mt-5">
        {result.items.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={hasFilters ? "No applications match these filters" : "No scholarship applications yet"}
            description={
              hasFilters
                ? "Try a different search term, status, or date range."
                : "Applications students submit through Scholarship Hub will appear here once you've connected and published a scholarship."
            }
          />
        ) : (
          <>
            <ScholarshipApplicationsTable applications={result.items} />
            <Suspense fallback={null}>
              <Pagination page={result.page} totalPages={result.totalPages} total={result.total} pageSize={result.pageSize} />
            </Suspense>
          </>
        )}
      </div>
    </>
  );
}
```

Create `src/app/(dashboard)/scholarship-applications/page.tsx`:

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/tenant/permissions";
import { requireTenantUserPage } from "@/lib/tenant";
import { ScholarshipApplicationsListView } from "@/components/scholarship-applications/scholarship-applications-list-view";

export const metadata: Metadata = { title: "Scholarship Applications" };
export const dynamic = "force-dynamic";

export default async function ScholarshipApplicationsPage(props: PageProps<"/scholarship-applications">) {
  const user = await requireTenantUserPage();
  if (!hasPermission(user, "SCHOLARSHIP_APPLICATIONS_VIEW")) redirect("/dashboard");
  const searchParams = await props.searchParams;

  return <ScholarshipApplicationsListView user={user} searchParams={searchParams} />;
}
```

- [ ] **Step 9: Build the detail page**

Create `src/app/(dashboard)/scholarship-applications/[id]/page.tsx`:

```tsx
import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import { hasPermission } from "@/lib/tenant/permissions";
import { requireTenantUserPage, tenantFilter } from "@/lib/tenant";
import { ScholarshipApplicationService } from "@/services/scholarship-application.service";
import { hubStatusBadge } from "@/lib/scholarship-applications/status-display";
import { Badge } from "@/components/ui/badge";
import { ScholarshipApplicationReviewStatusControl } from "@/components/scholarship-applications/scholarship-application-review-status-control";
import { ScholarshipApplicationAssignControl } from "@/components/scholarship-applications/scholarship-application-assign-control";
import { LeadService } from "@/services/lead.service";

export const metadata: Metadata = { title: "Scholarship Application" };
export const dynamic = "force-dynamic";

export default async function ScholarshipApplicationDetailPage(
  props: PageProps<"/scholarship-applications/[id]">,
) {
  const user = await requireTenantUserPage();
  if (!hasPermission(user, "SCHOLARSHIP_APPLICATIONS_VIEW")) redirect("/dashboard");
  const { id } = await props.params;

  let application;
  try {
    application = await ScholarshipApplicationService.get(tenantFilter(user), id);
  } catch {
    notFound();
  }

  const assignees = hasPermission(user, "SCHOLARSHIP_APPLICATIONS_ASSIGN")
    ? await LeadService.listAssignees(user.institutionId!)
    : [];
  const badge = hubStatusBadge(application.hubStatus);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{application.applicant.name}</h1>
          <p className="text-sm text-muted-foreground">{application.applicant.email ?? application.applicant.mobile ?? "No contact on file"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
      </div>

      {application.hubStatus === "withdrawn" ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          This applicant withdrew their application on Scholarship Hub. Your review status below is unaffected and stays as your institution's own record.
        </div>
      ) : null}

      <div className="flex items-center gap-4">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Review status</p>
          <ScholarshipApplicationReviewStatusControl id={application.id} reviewStatus={application.reviewStatus} />
        </div>
        {hasPermission(user, "SCHOLARSHIP_APPLICATIONS_ASSIGN") ? (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Assigned to</p>
            <ScholarshipApplicationAssignControl id={application.id} assignedTo={application.assignedTo} assignees={assignees} />
          </div>
        ) : null}
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium">Answers</h2>
        <dl className="grid gap-2 text-sm">
          {Object.entries(application.answers).map(([key, value]) => (
            <div key={key} className="rounded-md border p-2">
              <dt className="text-xs text-muted-foreground">{key}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {application.documents.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium">Documents</h2>
          <ul className="space-y-1 text-sm">
            {application.documents.map((doc) => (
              <li key={doc.key}>
                <a
                  href={`/api/scholarship-applications/${application.id}/documents/${doc.key}/file`}
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {doc.label} ({doc.filename})
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
```

(`LeadService.listAssignees(institutionId)` — confirmed at `src/services/lead.service.ts:371-382` — is the exact function the leads detail page already uses for this same purpose: `User.find({institutionId, role: {$in: ["INSTITUTION_ADMIN","COUNSELOR"]}, active: true})` sorted by name, returning `{id, name}[]`. Reused here verbatim rather than duplicated.)

- [ ] **Step 10: Typecheck and run the full suite**

Run: `npx tsc --noEmit`
Expected: 0 errors

Run: `npx vitest run --maxWorkers=4`
Expected: PASS (every file, including every test from Tasks 1–8)

- [ ] **Step 11: Commit**

```bash
git add src/components/scholarship-applications/ \
        src/lib/scholarship-applications/status-display.ts \
        src/app/\(dashboard\)/scholarship-applications/ \
        tests/unit/scholarship-application-status-display.test.ts
git commit -m "feat(scholarship-applications): inbox UI — list, detail, review/assign controls (sync-back 2B/8)"
```

---

## Self-Review

**Spec coverage:** §4.1 (`ScholarshipApplication` model, two status axes) → Task 1. §4.2 (ingestion core, ordering guard, reviewStatus-never-clobbered) → Task 3. §4.4 (reconciliation pull, platform-level cursor) → Task 4. §4.3 (inbound webhook receiver, HMAC-over-raw-body) → Task 5 (with the explicit ruling on "same endpoint" meaning "trigger the pull," since Plan 2A has no single-item detail endpoint). §4.5 (document proxy, partner HTTP client) → Tasks 2 and 6. §4.6 (inbox UI) → Task 8. §4.7 (notifications, permissions) → Tasks 3, 6, 7. §5 (security: constant-time signature compare, raw-body verification, tenant scoping, PII discipline) → threaded through every task's tests, verified explicitly in Task 5's "verifies against the RAW body" test. §6's failure matrix (stale-poll ordering guard, disconnected-institution skip, withdraw-after-decision coexistence, duplicate delivery idempotency) → each has its own test in Task 3. No gaps found.

**Placeholder scan:** No "TBD"/"handle appropriately"/unshown code anywhere. Task 8's original draft named a guessed `StaffService.listAssignable` for the assignee list — caught during self-review, verified at source (`src/app/(dashboard)/enquiries/[leadNumber]/page.tsx:52-53`), and replaced with the real `LeadService.listAssignees(institutionId)` before this plan was finalized.

**Type consistency:** `HubApplicationPayload` (Task 3) is structurally identical to Plan 2A's `PartnerApplicationDTO` — confirmed field-by-field against the committed Plan 2A contract (hubApplicationId, externalRef, scholarshipTitle, applicant, answers, documents, status, applicationNo?, submittedAt?, withdrawnAt?, hubUpdatedAt), so Task 4's `runReconciliationPull` can pass a list-endpoint item straight into `upsertFromHubPayload` with no remapping. `ScholarshipApplicationDTO` (Task 7) is the single shape Task 8's UI reads throughout — `hubStatus`/`reviewStatus` names match the model (Task 1) exactly. `loadScholarshipHubPartnerContext`/`loadScholarshipHubWebhookSecret`/`fetchScholarshipHubDocument` (Task 2) are the exact three names Tasks 4, 5, and 6 import, respectively. The three new permission names (`SCHOLARSHIP_APPLICATIONS_VIEW/DECIDE/ASSIGN`) are introduced once each, in the task that first needs them (6, 7, 7), and used identically by every later task and by Task 8's UI.
