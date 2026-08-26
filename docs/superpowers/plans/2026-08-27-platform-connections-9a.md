# Platform Connections 9a — Framework + PassPercent Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an institution connect its IDAP account to PassPercent and push its published profile and results there with one button, on a framework a second platform's adapter can plug into.

**Architecture:** Three new models (`PlatformCredential`, `PlatformConnection`, `SyncRun`), an AES-256-GCM credential vault keyed from one env secret, a `PlatformAdapter` interface with a registry, a shared HTTP client, and the PassPercent adapter split into a pure mapping module (unit-tested hard) and a thin protocol module (tested against a mocked HTTP layer). UI lands as a fourth tab on the existing `/integration` page plus a new super-admin `/admin/platforms` page.

**Tech Stack:** Next.js 16 (App Router), Mongoose 8, Zod 4, TypeScript, Vitest 3, node:crypto (AES-256-GCM), Radix/shadcn UI.

**Spec:** `docs/superpowers/specs/2026-08-27-platform-connections-design.md`
**Contract reference (binding):** `docs/integrations/passpercent-api-map.md` — implementers of Tasks 5, 6 and 10 read it in full. Where this plan and the map disagree, the map wins; where the map and PassPercent's own docs disagree, the map already ruled (code wins).

## Global Constraints

- **Tenant scoping is absolute.** Every connection/run read and write is filtered by `institutionId`. Another institution's connection is NOT_FOUND, never FORBIDDEN. A malformed id is NOT_FOUND, never a 500.
- **Plaintext credentials never leave the server and never enter logs.** Credential reads are masked (`pp_pkey_…last4`). The redeem response containing `token` is never logged, never stored unencrypted, never echoed to any client. No credential or grant appears in any error message, `SyncRun` row, or Activity entry.
- **Guard optional bounds with `!= null`, never `?? 0` or truthiness.** In the rollup especially: an unreported `appeared` contributes nothing to a denominator — it does not contribute zero.
- **Mapping losses are warnings, never silent drops and never hard failures.** Every skipped topper, unmapped level, dropped enum value and unparseable year lands in the run's `warnings`.
- **`tsc --noEmit` clean; `npx eslint src` at exactly 0 errors / 7 pre-existing `react-hooks/incompatible-library` warnings.**
- **Never run `git checkout`, `git switch`, or `git worktree add`** — shared working directory; use `git show <ref>:<path>`.
- **`git diff --quiet` is not a valid mutation-restore check** — grep the specific line, printing output when the mutation lands and when restored.
- **Test helpers are positional:** `makeInstitution(institutionId, overrides = {})`, `makeProfiledInstitution(institutionId, overrides = {})`.
- **Browser verification uses Playwright from `/Users/automicai/VVOGI/node_modules/playwright`** (import by absolute path, run script via `cd /Users/automicai/VVOGI && node <script>.mjs`). Never kill or restart any dev server — many unrelated ones run on this machine.
- **No secret is ever committed.** The dev `IDAP_CREDENTIAL_KEY` goes in `.env.local` (git-ignored) only.

---

## File Structure

**Created:** `src/lib/security/credentials.ts` · `src/models/{PlatformCredential,PlatformConnection,SyncRun}.ts` · `src/lib/connectors/{types,http,index,passpercent-mapping,passpercent}.ts` · `src/services/{platform-credential,connection}.service.ts` · routes under `src/app/api/admin/platform-credentials/` and `src/app/api/settings/connections/` · `src/app/(dashboard)/admin/platforms/page.tsx` · `src/components/admin/platform-credentials-panel.tsx` · `src/components/integration/connections-panel.tsx` · tests alongside each.

**Modified:** `src/lib/constants.ts` (platform enums) · `src/models/index.ts` · `src/lib/storage/{types,local,blob}.ts` (`getPublic`) · `src/components/dashboard/nav-config.ts` (admin nav item) · `src/app/(dashboard)/integration/page.tsx` (fourth tab).

**Task ordering:** foundations (1–3), connector plumbing (4), the pure mapping core (5), the adapter (6), credential surface (7), connection surface (8), dashboard UI (9), live E2E (10). Tasks 5 and 6 are split deliberately: the mapping is where correctness lives and must be testable without any HTTP; the adapter is protocol choreography.

---

## Task 1: Constants and the credential vault

**Files:**
- Modify: `src/lib/constants.ts`
- Create: `src/lib/security/credentials.ts`
- Test: `tests/unit/credentials.test.ts`

**Interfaces:**
- Produces: `PLATFORMS`, `Platform`, `PLATFORM_LABELS`, `CONNECTION_STATUSES`, `ConnectionStatus`, `CONNECTION_STATUS_LABELS`, `SYNC_STATUSES`, `SyncStatus`, `SYNC_RUN_KEEP`; `credentialVaultReady(): boolean`, `encryptCredential(plain: string): string`, `decryptCredential(blob: string): string`.

- [ ] **Step 1: Append constants** to `src/lib/constants.ts`:

```ts
export const PLATFORMS = ["PASSPERCENT", "FEESBASKET"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  PASSPERCENT: "PassPercent",
  FEESBASKET: "FeesBasket",
};

export const CONNECTION_STATUSES = [
  "PENDING",
  "AWAITING_APPROVAL",
  "CONNECTED",
  "REJECTED",
  "DISCONNECTED",
  "ERROR",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_STATUS_LABELS: Record<ConnectionStatus, string> = {
  PENDING: "Requested",
  AWAITING_APPROVAL: "Awaiting school approval",
  CONNECTED: "Connected",
  REJECTED: "Rejected",
  DISCONNECTED: "Disconnected",
  ERROR: "Needs attention",
};

export const SYNC_STATUSES = ["SUCCESS", "PARTIAL", "FAILED"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** SyncRun rows kept per (institution, platform) — a log, not an archive. */
export const SYNC_RUN_KEEP = 20;
```

- [ ] **Step 2: Write the failing vault test** — `tests/unit/credentials.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  credentialVaultReady,
  decryptCredential,
  encryptCredential,
} from "@/lib/security/credentials";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

describe("credential vault", () => {
  const original = process.env.IDAP_CREDENTIAL_KEY;
  beforeEach(() => {
    process.env.IDAP_CREDENTIAL_KEY = VALID_KEY;
  });
  afterEach(() => {
    process.env.IDAP_CREDENTIAL_KEY = original;
  });

  it("round-trips a credential", () => {
    const blob = encryptCredential("pp_pkey_secret_value");
    expect(blob).not.toContain("pp_pkey");
    expect(decryptCredential(blob)).toBe("pp_pkey_secret_value");
  });

  it("produces a different ciphertext each call (fresh IV)", () => {
    expect(encryptCredential("same")).not.toBe(encryptCredential("same"));
  });

  it("refuses a tampered ciphertext rather than returning garbage", () => {
    const blob = encryptCredential("secret");
    const parts = blob.split(".");
    parts[1] = Buffer.from("tampered-ciphertext!").toString("base64");
    expect(() => decryptCredential(parts.join("."))).toThrow();
  });

  it("reports not-ready (and never throws) when the env key is absent", () => {
    delete process.env.IDAP_CREDENTIAL_KEY;
    expect(credentialVaultReady()).toBe(false);
  });

  it("reports not-ready for a key that is not 32 bytes", () => {
    process.env.IDAP_CREDENTIAL_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(credentialVaultReady()).toBe(false);
  });

  it("encrypt/decrypt throw a clear error when the vault is not ready", () => {
    delete process.env.IDAP_CREDENTIAL_KEY;
    expect(() => encryptCredential("x")).toThrow(/IDAP_CREDENTIAL_KEY/);
  });
});
```

- [ ] **Step 3: Run to confirm it fails** — `npx vitest run tests/unit/credentials.test.ts` → cannot resolve module.

- [ ] **Step 4: Implement** `src/lib/security/credentials.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM vault for third-party platform credentials. One env secret
 * (`IDAP_CREDENTIAL_KEY`, 32 bytes base64) instead of N platform keys in env;
 * ciphertexts live in MongoDB. Format: `iv.ciphertext.tag`, each base64.
 *
 * The vault being unconfigured DISABLES the connections feature with an
 * explicit message — it never crashes the app and never falls back to
 * storing plaintext.
 */
const ALGO = "aes-256-gcm";

function keyBytes(): Buffer | null {
  const raw = process.env.IDAP_CREDENTIAL_KEY;
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function credentialVaultReady(): boolean {
  return keyBytes() !== null;
}

function requireKey(): Buffer {
  const key = keyBytes();
  if (!key) {
    throw new Error(
      "IDAP_CREDENTIAL_KEY is missing or is not 32 base64-encoded bytes — platform connections are disabled until it is set",
    );
  }
  return key;
}

export function encryptCredential(plain: string): string {
  const key = requireKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, ciphertext, cipher.getAuthTag()]
    .map((part) => part.toString("base64"))
    .join(".");
}

export function decryptCredential(blob: string): string {
  const key = requireKey();
  const [iv, ciphertext, tag] = blob.split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 5: Run to confirm it passes** — 6 tests.

- [ ] **Step 6: Add a dev key to `.env.local`** (git-ignored — verify with `git check-ignore .env.local` before writing): append `IDAP_CREDENTIAL_KEY=<output of: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">`. Do NOT restart the dev server; note in your report that a restart is needed before UI tasks use the vault.

- [ ] **Step 7: Typecheck and commit** — `npx tsc --noEmit`, then commit `feat: add platform constants and the AES-256-GCM credential vault`.

---

## Task 2: The three models

**Files:**
- Create: `src/models/PlatformCredential.ts`, `src/models/PlatformConnection.ts`, `src/models/SyncRun.ts`
- Modify: `src/models/index.ts`
- Test: `tests/unit/platform-models.test.ts`

**Interfaces:**
- Consumes: Task 1's constants.
- Produces: `PlatformCredential`/`PlatformCredentialDoc`, `PlatformConnection`/`PlatformConnectionDoc`, `SyncRun`/`SyncRunDoc`, exported from `@/models`.

- [ ] **Step 1: Write the failing model test** — `tests/unit/platform-models.test.ts` covering: credential defaults (`active: true`), credential unique-per-platform (second create for same platform rejects after `syncIndexes`), credential `keyEncrypted` has `select: false` (a plain `findOne` does not return it; `.select("+keyEncrypted")` does); connection defaults (`status: "PENDING"`), connection unique on `(institutionId, platform)`, `grantTokenEncrypted` also `select: false`; SyncRun requires `status` and `startedAt`, rejects a status outside the enum. Model the file on `tests/unit/scholarship-model.test.ts` (same `startTestDatabase`/`syncIndexes` bootstrap).

- [ ] **Step 2: Run to confirm failure** (models unresolved).

- [ ] **Step 3: Create the three models** exactly as spec §3.1–3.3 defines them (field-for-field — the spec blocks are the source of truth; copy them, adding `keyEncrypted`/`grantTokenEncrypted` `select: false` which §3 notes via the schema snippets). Export all three from `src/models/index.ts` in the house style (`export { PlatformCredential, type PlatformCredentialDoc } from "./PlatformCredential";` …).

- [ ] **Step 4: Run tests** → green. **Step 5: `npx tsc --noEmit`, commit** `feat: add PlatformCredential, PlatformConnection and SyncRun models`.

---

## Task 3: `storage.getPublic`

**Files:**
- Modify: `src/lib/storage/types.ts`, `src/lib/storage/local.ts`, `src/lib/storage/blob.ts`
- Test: `tests/unit/storage-get-public.test.ts`

**Interfaces:**
- Produces: `StorageAdapter.getPublic(key: string): Promise<{ body: Buffer; contentType: string } | null>` on both adapters.

Why: topper photos are public media whose stored key is a relative path on the local adapter but an absolute blob URL on Vercel Blob. The PassPercent adapter must read bytes to inline base64; duplicating that resolution inside a connector would fork the logic the media route already owns.

- [ ] **Step 1: Failing test** — round-trip on the LOCAL adapter (`putPublic` then `getPublic` returns the same bytes and content type; `getPublic("missing/key")` returns `null`); for the BLOB adapter, stub global `fetch` and assert `getPublic("https://blob.example/x.jpg")` fetches that URL and returns bytes/content-type, and a non-OK response returns `null`. Import the concrete adapters directly (`localStorageAdapter` / the blob adapter's export — read `src/lib/storage/local.ts` and `blob.ts` for their real export names first and use those).

- [ ] **Step 2: Confirm failure.** **Step 3: Implement.** Interface addition in `types.ts` with a doc comment mirroring `putPublic`'s ("public media ONLY"). Local: resolve under the same `PUBLIC_UPLOAD_DIR ?? .uploads-public` root the media route uses, with the same path-escape guard (`resolve` + `startsWith(root + sep)` — copy the guard from `src/app/api/media/[...key]/route.ts`), reading the `.content-type` sidecar as that route does. Blob: keys are absolute URLs — `fetch`, return `null` unless `response.ok`.

**Testing the escape guard — the trap:** a traversal fixture must resolve to a path that ACTUALLY EXISTS, or the test passes via ENOENT whether or not the guard ran. From this repo's root, `../../etc/passwd` resolves to `/Users/automicai/etc/passwd` (nonexistent) and is therefore confounded; `../../../../etc/hosts` resolves to the real `/etc/hosts`. Verify by mutation: disable the guard and confirm the traversal test FAILS — found by Task 3's implementer, whose first-pass fixture came from this plan and was confounded.

- [ ] **Step 4: Green. Step 5: `npx tsc --noEmit` (this proves both adapters still satisfy the widened interface), commit** `feat: add getPublic to the storage adapters`.

---

## Task 4: Connector plumbing — types, HTTP client, registry

**Files:**
- Create: `src/lib/connectors/types.ts`, `src/lib/connectors/http.ts`, `src/lib/connectors/index.ts`
- Test: `tests/unit/connector-http.test.ts`

**Interfaces (later tasks depend on these exact names):**

```ts
// types.ts
export type ConnectMode = "REQUEST_APPROVE_REDEEM" | "PASTE_KEY";
export type SyncStep = { step: string; ok: boolean; detail?: string };
export type SyncOutcome = { status: SyncStatus; steps: SyncStep[]; warnings: string[]; error?: string };
export type InitiateResult = { remoteRequestId: string; remoteStatus: string };
export type RefreshResult =
  | { kind: "PENDING" | "AWAITING_APPROVAL" | "REJECTED"; remoteStatus: string; detail?: string }
  | { kind: "CONNECTED"; remoteStatus: string; grantToken: string; scopes: string[];
      remoteInstitution?: { name?: string; city?: string; slug?: string } };
export type ConnectResult = { scopes: string[]; remoteInstitution?: { name?: string; city?: string; slug?: string } };
export type InstitutionSummary = { institutionId: string; name: string; city?: string;
  address?: { addressLine?: string; area?: string; district?: string; state?: string; pincode?: string };
  phone?: string; website?: string; contactName?: string; contactEmail?: string };
export type ConnectionState = { institutionId: string; externalRef: string;
  remoteRequestId?: string; grantToken?: string; scopes?: string[] };
export type AdapterContext = { baseUrl: string; platformKey: string; http: ConnectorHttp };

export interface PlatformAdapter {
  platform: Platform;
  connectMode: ConnectMode;
  initiate?(ctx: AdapterContext, institution: InstitutionSummary): Promise<InitiateResult>;
  refresh?(ctx: AdapterContext, connection: ConnectionState): Promise<RefreshResult>;
  connectWithKey?(ctx: AdapterContext, institutionId: string, key: string): Promise<ConnectResult>;
  sync(ctx: AdapterContext, connection: ConnectionState, data: SyncSourceData): Promise<SyncOutcome>;
}

/** Everything an adapter may push, loaded by the service so adapters never touch models. */
export type SyncSourceData = {
  institution: Record<string, unknown>;
  results: Record<string, unknown>[];   // PUBLISHED only, full internal DTO shape
  readPublicMedia: (key: string) => Promise<{ body: Buffer; contentType: string } | null>;
};
```

```ts
// http.ts
export class ConnectorHttpError extends Error {
  constructor(public status: number, public body: unknown, message?: string) { ... }
}
export type ConnectorHttp = (path: string, init: {
  method: "GET" | "POST" | "PUT" | "PATCH";
  token: string;                    // sent as Authorization: Bearer <token>
  body?: unknown;
  headers?: Record<string, string>;
}) => Promise<{ status: number; body: unknown }>;
export function createConnectorHttp(baseUrl: string): ConnectorHttp;
```

Behaviour to implement and test (mock `fetch`): JSON request/response; 15s timeout via `AbortSignal.timeout`; on `429`, exactly ONE retry after `Retry-After` seconds when the header is present, else after 2 seconds (use fake timers in the test); non-2xx after retries → resolve normally with `{status, body}` (adapters classify — the client throws `ConnectorHttpError` only on network failure/timeout so protocol errors stay inspectable); the platform token never appears in any thrown error's message.

`index.ts`: `adapterFor(platform: Platform): PlatformAdapter` — throws for a platform with no registered adapter (FeesBasket registers in Plan 9b), so Task 8's service has a single lookup point.

- [ ] Steps: failing test (429-retry-once with/without Retry-After; timeout; JSON; token-not-in-error) → red → implement → green → `tsc` → commit `feat: add the connector adapter types, HTTP client and registry`.

---

## Task 5: PassPercent mapping — the pure core

**Files:**
- Create: `src/lib/connectors/passpercent-mapping.ts`
- Test: `tests/unit/passpercent-mapping.test.ts`

**Interfaces:**
- Consumes: nothing but types — every function is pure `(inputs) → { value, warnings }`. No HTTP, no models, no Date.now.
- Produces (Task 6 calls exactly these):

```ts
export function mapStream(level: string, institutionType: string): string | null;
export function buildProfilePatch(input: {
  institution: Record<string, unknown>;
  streams: string[];                       // pre-computed union, see below
  schemaFields: { name: string; enum?: string[] }[];   // from live GET /partner/schema
}): { patch: Record<string, unknown>; warnings: string[] };
export function deriveStreams(input: {
  segments: string[]; institutionType: string; mappedResultStreams: string[];
}): string[];
export function buildResultsPayloads(input: {
  results: Record<string, unknown>[];      // PUBLISHED internal DTOs
  institutionType: string;
}): { byYear: Map<string, { streams: Record<string, unknown> }>; warnings: string[] };
```

The brief for this task carries the complete mapping rules from spec §6.3–6.5 plus these exact pinned values (all verified against both codebases — do not re-derive):

- **Stream map:** `CLASS_10→sslc`; `CLASS_12→puc`; `PUC_2→puc`; `UG` by institutionType (`ENGINEERING_COLLEGE→engineering`, `MEDICAL_COLLEGE|NURSING_COLLEGE→medical`, else `degree`); `PUC_1|PG|DIPLOMA|OTHER→null` (unmapped → warning naming the result's level and year).
- **Segment-derived streams:** `SCHOOL→sslc`, `PRE_UNIVERSITY→puc`, `DEGREE→degree`, `ENGINEERING→engineering`; `MEDICAL_COLLEGE` institution type adds `medical`. `deriveStreams` returns the union with `mappedResultStreams` — the streams field MUST be a superset of every key the results payload uses, or PassPercent rejects the results push.
- **Year filter:** academicYear must match `/^\d{4}(-\d{2,4})?$/` — else that result is skipped + warned.
- **Rollup (two results on one (stream, year)):** `appeared`/`passed` summed only across results where the field `!= null` (a result with `appeared == null` contributes nothing and adds a warning); `passPct` recomputed as `passed/appeared*100` to 1 decimal, only when the summed `appeared > 0`; `boys`/`girls` summed with the same `!= null` discipline; `grades` buckets summed key-by-key (keys are identical in both systems: `"90+","80-90","70-80","60-70","50-60","below50"`); toppers concatenated; `combinations` merged by label — a duplicate label keeps the FIRST and warns; `placement`/`selections` taken from the first result carrying them — a second carrier warns and is ignored.
- **Toppers:** PassPercent requires `{rank, name, pct}`. IDAP topper `percentage` is always present (DTO-typed `number`); a topper with `rank == null` is SKIPPED + warned. Map `percentage→pct`, keep `name`, `rank`; `note→subject` is NOT mapped (semantics differ) — omit. Photos are Task 6's job (they need I/O); the mapping emits `photoKey` alongside each topper for the adapter to resolve, and the adapter strips it before sending.
- **Combinations:** keyed by `label` verbatim; fields `appeared, passed, distinction, firstClass, highestScore→highestScore, averageScore→avgScore, grades, boys, girls, toppers` (same topper rules). Note the one rename: IDAP `averageScore` → PassPercent `avgScore`.
- **Placement:** `eligible, placed, highestPackage, averagePackage→avgPackage`; `placementPct` computed (`placed/eligible*100`, 1dp) only when both `!= null` and `eligible > 0`; recruiters → `companies` array of `{name, category: lowercased, selected, avgPackage: recruiter.averagePackage, tieUp, roles}` — category map is identity-lowercase (`IT→it, PRODUCT→product, CORE→core, CONSULTING→consulting, STARTUP→startup, OTHER→other`).
- **Selections:** map keyed by exam code: `NEET→neet, JEE_MAIN→jeeMain, JEE_ADVANCED→jeeAdvanced, KCET→kcet, COMEDK→comedk`; fields `appeared, qualified, bestRank`; selection toppers → `{name, rank, score?}` — a selection topper with `rank == null` is skipped + warned.
- **Profile patch:** `institutionName→name`, `city`, `description→about`, `phone`, `website`, `address→addressLine`, `area`, `district`, `taluk`, `state`, `pincode`, `streams`. `academic.board` included ONLY if the schema's `board` field lists it in its `enum` (case-sensitive membership; else dropped + warned). `type` is NEVER emitted. Fields whose IDAP value is `undefined`/empty are omitted (never send `""` — PassPercent 400s on empty `name`/`city`).

Tests (~25 cases): every stream-map row incl. all four unmapped levels; superset property of `deriveStreams`; each rollup rule with a two-result fixture (including the null-appeared warning case and the duplicate-combination-label case); rank-less topper skip; the `averageScore→avgScore` and `averagePackage→avgPackage` renames asserted by exact key (`expect(combo).toHaveProperty("avgScore")` AND `expect(combo).not.toHaveProperty("averageScore")`); exam-code and category maps exhaustively; year-regex rejection; board enum-gate both ways; `type` never present in any produced patch (assert on a fixture whose institution HAS a type).

- [ ] Steps: failing tests → red → implement → green → **mutation-check the rollup's `!= null` guard** (regress `appeared != null` to truthiness; the fixture where one result has `appeared: 0` must flip outcome — include such a fixture; grep-verified restore) → `tsc` → commit `feat: add the PassPercent pure mapping module`.

---

## Task 6: The PassPercent adapter

**Files:**
- Create: `src/lib/connectors/passpercent.ts`
- Modify: `src/lib/connectors/index.ts` (register it)
- Test: `tests/unit/passpercent-adapter.test.ts`

**Interfaces:**
- Consumes: Task 4's types/http, Task 5's mapping, map §§2–4 endpoints.
- Produces: `passpercentAdapter: PlatformAdapter` with `connectMode: "REQUEST_APPROVE_REDEEM"`.

Protocol behaviour, per `docs/integrations/passpercent-api-map.md` (the brief tells the implementer to read §§2–4 and §7.1 in full):

- `initiate` → `POST /api/partner/connection-requests` with `{externalRef, name, city, …address/contact context}`. `201 → {remoteRequestId, remoteStatus:"pending"}`. **`409` with a `requestId` in the body → ADOPT that id** (an open request already exists), returning it as the result — not an error.
- `refresh` → `GET /api/partner/connection-requests/:id`. `pending→PENDING`, `awaiting_school→AWAITING_APPROVAL`, `rejected→REJECTED` (detail = `rejectReason`). On `approved` → immediately `POST …/:id/redeem`; on `200` return `kind:"CONNECTED"` with `grantToken`, `scopes`, `remoteInstitution` from the response. A redeem race (`409`/`404` because someone redeemed already) → surface as REJECTED-kind with detail "already redeemed — reconnect from PassPercent" (the token from the winning redeem is gone; only a fresh request recovers).
- `sync(ctx, connection, data)`:
  1. `GET /partner/schema` with the GRANT token (map: dual-auth route) → `fields` for the enum gate.
  2. Build streams union + profile patch (Task 5); `PATCH /partner/institution` with the grant token. Non-2xx → run `FAILED` (steps recorded), stop — results would be rejected against undeclared streams anyway.
  3. `buildResultsPayloads`; for each year ascending: resolve each topper `photoKey` via `data.readPublicMedia` — inline `photo` as `data:image/...;base64,…`? **No:** the map says inline base64 with a ~200KB raw cap but does not fix the wrapper format — the brief instructs the implementer to check `GET /partner/schema`'s `results` block / example for the expected photo encoding at runtime, and if absent, send the topper WITHOUT the photo and warn once per run (`"topper photos skipped: PassPercent schema does not document an inline encoding"`). Never guess an encoding into a live partner API.
  4. `PUT /partner/institution/results/:year` per year. Per-year non-2xx → step recorded `ok:false`, continue (final status `PARTIAL`); all steps ok → `SUCCESS`.
  5. Classifications: any `403` whose body carries `reason:"needs_school_consent"` → run `FAILED`, error verbatim `"PassPercent: the school has not consented (or has withdrawn consent) — ask them to approve the connection on their PassPercent dashboard"`. Any `401` on a grant call → throw `ConnectorAuthError` (exported from types.ts — add it: `class ConnectorAuthError extends Error`) so Task 8's service flips the connection to `ERROR`. `429` bodies (both quota shapes) → step `ok:false` with the quota message, run `FAILED`.

Tests, all against a stubbed `ConnectorHttp` (a vi.fn returning scripted `{status, body}` sequences — no real network): initiate 201; initiate 409-adopt; refresh through pending → awaiting → approved-with-redeem (assert redeem called exactly once and the token returned, never logged — spy on console); redeem race; sync happy path asserting ORDER (schema → PATCH → PUTs ascending by year) via the mock's call log; profile failure aborts before any PUT; one-year failure yields PARTIAL with the other year still pushed; needs_school_consent classification; 401 → ConnectorAuthError; photo resolved via a stubbed `readPublicMedia` and dropped-with-warning when >200KB (`Buffer.alloc(210_000)`).

- [ ] Steps: failing tests → red → implement → green → `tsc` → commit `feat: add the PassPercent adapter`.

---

## Task 7: Platform credentials — service, admin routes, admin UI

**Files:**
- Create: `src/services/platform-credential.service.ts`, `src/app/api/admin/platform-credentials/route.ts`, `src/app/api/admin/platform-credentials/[platform]/route.ts`, `src/app/(dashboard)/admin/platforms/page.tsx`, `src/components/admin/platform-credentials-panel.tsx`
- Modify: `src/components/dashboard/nav-config.ts`
- Test: `tests/integration/platform-credentials.test.ts`

Service: `list()` → `{platform, baseUrl, active, keyMasked, updatedAt}[]` where `keyMasked` is `…` + last 4 of the DECRYPTED key (requires `.select("+keyEncrypted")`; when the vault is not ready, `keyMasked: null` and a top-level `vaultReady: false` accompanies the list); `upsert(platform, {key?, baseUrl, active}, actor)` — `key` optional on update so baseUrl/active can change without re-entering the secret; encrypts before save; `remove(platform, actor)`. All `ActivityService.record`-logged (`entityType: "PLATFORM_CREDENTIAL"`, description NEVER contains the key). Routes: `GET`/`PUT` collection + `DELETE` per platform, guarded `await requireSuperAdmin()` (from `@/lib/tenant`) + `assertSameOrigin` on mutations, in the exact style of `src/app/api/institutions/route.ts`.

Admin UI: new page `/admin/platforms` (guard: redirect non-SUPER_ADMIN to `/dashboard` — mirror `src/app/(dashboard)/admin/` siblings' guard blocks; read one first), a card per `PLATFORMS` entry: baseUrl input, write-only key input (`type="password"`, placeholder shows the mask when a key exists), active toggle, save. A banner when `vaultReady` is false explaining `IDAP_CREDENTIAL_KEY`. Nav: add `{ href: "/admin/platforms", label: "Platforms", icon: Cable }` to `SUPER_ADMIN_NAV`'s first group (verify `Cable` exists in lucide-react before using; fall back to `Plug` — already imported — if not).

Tests (mirror `fee-structure-routes.test.ts`'s session mocking): masked list never contains the plaintext or the ciphertext; upsert-then-list round-trip shows last-4; update without `key` preserves the stored secret (decrypt and compare via the service internals — reach through the model with `.select("+keyEncrypted")` in the test); INSTITUTION_ADMIN session → 403 on every route; CSRF: refused PUT leaves the collection unchanged (strong assertion: count + stored ciphertext identical).

- [ ] Steps: failing tests → red → implement → green → `tsc` + `eslint` at baseline → commit `feat: add platform credential vault service, admin routes and UI`.

---

## Task 8: Connections — service and settings routes

**Files:**
- Create: `src/services/connection.service.ts`, and routes: `src/app/api/settings/connections/route.ts`, `.../[platform]/initiate/route.ts`, `.../[platform]/refresh/route.ts`, `.../[platform]/connect-key/route.ts`, `.../[platform]/sync/route.ts`, `.../[platform]/route.ts` (DELETE), `.../[platform]/runs/route.ts`
- Test: `tests/integration/connection-service.test.ts`, `tests/integration/connection-routes.test.ts`

Service methods (all `institutionId`-scoped; `[platform]` param validated against `PLATFORMS` else NOT_FOUND):

- `list(institutionId)` → per platform: `{platform, configured, status?, remoteStatus?, remoteInstitution?, scopes?, lastSyncAt?, lastSyncStatus?, lastError?}` (`configured` = active credential exists AND vault ready).
- `initiate(institutionId, platform, actor)` — loads credential (404 "not configured" if absent/inactive/vault-down), builds `InstitutionSummary` from the Institution doc, calls the adapter's `initiate`, upserts the connection (`status: PENDING`, `remoteRequestId`, `externalRef: institutionId`). Refuses (validation error) when a connection is already `CONNECTED`.
- `refresh(institutionId, platform, actor)` — adapter `refresh`; on `CONNECTED`: encrypt `grantToken` → `grantTokenEncrypted`, store scopes + snapshot. Maps kinds to statuses 1:1.
- `connectWithKey(...)` — Plan 9b wires FeesBasket; in 9a it returns a validation error "not supported for this platform" when the adapter lacks `connectWithKey` (write it generically against the interface now).
- `syncNow(institutionId, platform, actor)` — **atomic lock:** flip a `syncInProgress: boolean` on the connection via `findOneAndUpdate({..., syncInProgress: {$ne: true}}, {$set: {syncInProgress: true}})`; a null result → validation error "a sync is already running". (Add `syncInProgress: { type: Boolean, default: false }` to the connection schema in this task — a one-field migration-free addition.) Then: institution `profileStatus !== "PUBLISHED"` → refuse with the spec §5 message; load PUBLISHED results via `ResultService.list` filtered by status; build `SyncSourceData` with `readPublicMedia: storage.getPublic`; run the adapter; write the `SyncRun` (+ prune to `SYNC_RUN_KEEP` newest); update `lastSyncAt/lastSyncStatus/lastError`; `ConnectorAuthError` → connection `status: "ERROR"`. `finally` clears `syncInProgress`.
- `disconnect(...)` — `status: DISCONNECTED`, `$unset` the grant ciphertext; UI copy (Task 9) explains remote revocation happens on PassPercent's own dashboard.
- `listRuns(institutionId, platform)` — newest first.

All actions Activity-logged (`entityType: "PLATFORM_CONNECTION"`). Routes: thin wrappers, `requireInstitution` + `assertSameOrigin` on mutations, house style.

Service tests use a **fake adapter** injected via the registry (add `registerAdapterForTest`/`__setAdapter` — or export the registry map — decide by reading how `src/lib/db/mongoose` style singletons are tested here; simplest: `vi.mock("@/lib/connectors", …)` in the test) so no PassPercent protocol is re-tested: lifecycle transitions; grant encrypted at rest (read raw doc, assert no plaintext); sync writes a run and prunes at `SYNC_RUN_KEEP` (insert 21, expect 20); concurrent-sync refusal (start a sync whose fake adapter awaits a deferred promise, second call refuses, release, both settle); unpublished-profile refusal; ConnectorAuthError → ERROR; tenant isolation (INS0002's connection invisible to INS0001 — mutation-check this one: drop `institutionId` from the service's `findOne`, exactly that test fails, grep-verified restore). Route tests: the 7 routes' happy paths + CSRF-refused sync makes NO adapter call and writes NO run (strong assertion) + unknown platform 404.

- [ ] Steps: failing tests → red → implement → green → mutation check → `tsc`/eslint → commit `feat: add the connection service and settings routes`.

---

## Task 9: Dashboard UI — the Connected platforms tab

**Files:**
- Create: `src/components/integration/connections-panel.tsx`
- Modify: `src/app/(dashboard)/integration/page.tsx`
- Test: browser verification (no new unit tests — the logic lives in Task 8; this is wiring + rendering)

Add `{ value: "connections", label: "Connected platforms" }` to the page's `TABS` and render `<ConnectionsPanel …/>` for it, passing `ConnectionService.list(...)` data. Panel per platform card: status badge (reuse the badge tone vocabulary from `scholarship-status-badge.tsx` — `CONNECTED` filled, `PENDING`/`AWAITING_APPROVAL` outlined, `ERROR`/`REJECTED` destructive-tinted, map in-component since these statuses have no shared badge yet); "Not configured" quiet state when `configured` is false; for PassPercent: "Request connection" button (POST initiate) when absent/DISCONNECTED/REJECTED, "Check status" (POST refresh) when PENDING/AWAITING_APPROVAL with helper copy that a PassPercent admin (and possibly the school) must approve; when CONNECTED: remote institution name/city, scopes, "Sync now" (POST sync, disabled while in flight, toast on success/partial/fail), last-sync line, expandable recent runs (GET runs) rendering each run's steps and — prominently — its `warnings` (the unmapped/skipped channel is the product surface here, not debug noise), and "Disconnect" behind the same confirm-dialog pattern as `scholarship-actions.tsx` with copy noting the school also revokes on PassPercent's dashboard.

Browser verification (Playwright, absolute path per Global Constraints; dev server on port 3000 — restart it FIRST by PID since new models landed since it started; find with `lsof -nP -iTCP:3000 -sTCP:LISTEN -t`, confirm its cwd is this repo before killing):
1. Log in as `admin@infinityschool.edu.in` / `Infinity!2026`; `/integration?tab=connections` renders both platform cards, PassPercent showing "Not configured".
2. As super admin (`admin@aemplatform.local` / `ChangeMe!2026`), `/admin/platforms` renders; save a PassPercent credential (key `pp_pkey_test`, baseUrl `http://localhost:9`) → masked display shows `…test`.
3. Back as institution admin: card now shows "Request connection"; clicking it fails gracefully (baseUrl points nowhere) — assert the error surfaces as a toast/inline message, NOT an unhandled crash, and no connection row is stuck in a broken state (card still offers the action).
4. Seed a CONNECTED connection + 2 SyncRuns directly via a `npx tsx` script against the dev DB (write it in the scratchpad, not the repo); reload → status badge, sync button, runs with warnings render.
5. Console: zero page errors. Then DELETE the seeded rows and the test credential (script cleanup + remove via the admin UI), leaving the dev DB as found — verify by listing.

- [ ] Steps: implement → browser-verify → `tsc`/eslint at baseline → commit `feat: add the Connected platforms tab and admin platforms page wiring`.

---

## Task 10: Manual E2E against real PassPercent

**Files:** none in this repo (a verification task; report + spec as-built notes are the deliverable)

Per spec §9.6. Steps, adapted from `docs/integrations/passpercent-api-map.md`:

1. Start PassPercent's backend locally (read its repo README/package.json for the dev command; it needs its own MongoDB — check its config; do NOT touch IDAP's dev server or database). If it cannot be started (missing env, seed, or admin account), STOP and report exactly what is missing — do not simulate success.
2. Via its admin surface (`super_admin`), `POST /admin/partners` to register "IDAP" and capture the `pp_pkey_…` (shown once).
3. In IDAP's `/admin/platforms`, save that key with the local baseUrl.
4. As the institution admin, Request connection → in PassPercent's admin, match/draft the institution (unclaimed path → straight to approved) → back in IDAP, Check status → auto-redeem → CONNECTED.
5. Sync now. Verify in PassPercent (its DB or UI): profile fields landed; streams declared; the seeded PUBLISHED result's year present with the mapped stream; toppers with ranks present; the run's warnings list matches expectation (e.g. unmapped levels named).
6. Sync again → verify idempotence (results PUT wholesale-replace; no duplicates).
7. Record everything — commands, responses, screenshots/DB queries — in the task report. Clean up on the PassPercent side (delete the test partner/connection) only if its admin surface supports it; otherwise note what was left.

Findings that reveal IDAP-side bugs enter the normal fix loop; findings that reveal map/contract drift get recorded in `docs/integrations/passpercent-api-map.md` via a dated addendum section (the only allowed edit to that file).

---

## Self-Review

**Spec coverage:** §3.1–3.4→Tasks 1–2 (+vault); §4/4.1→Task 4; §5→Task 8 (`PUBLISHED`-only, internal DTOs, profileStatus gate); §6.1→Task 6 (initiate/refresh/redeem incl. both wrinkles); §6.2→Task 6 (order) + Task 8; §6.3–6.5→Task 5 (+photo I/O in 6); §6.6→Task 6; §8.1–8.2→Tasks 7–8; §8.3→Tasks 7 (admin UI) + 9; §9.1–9.5→distributed as listed; §9.6→Task 10. §7 (FeesBasket) is Plan 9b — the interface hooks (`connectWithKey`, registry, `PLATFORMS` including FEESBASKET) land here so 9b is adapter-only. No gaps.

**Type consistency:** `SyncOutcome`/`SyncStep`/`RefreshResult` declared once (Task 4) and consumed by 5/6/8; `SyncSourceData.readPublicMedia` matches `storage.getPublic`'s signature (Task 3); statuses come from Task 1's enums everywhere.

**Verified at source while writing this plan:** `requireSuperAdmin` exists (`src/lib/tenant/index.ts:88`); `ResultDTO.toppers[].percentage` is non-optional (so the skip rule keys on `rank` alone); `averageScore`/`averagePackage` are IDAP's names and `avgScore`/`avgPackage` PassPercent's (map §5) — the renames are asserted-by-exact-key in Task 5's tests; the `/integration` page is tab-driven with a `TABS` array; storage has NO public read today (hence Task 3); `.env.local` is the env file the dev server loads.

**Deviations decided while planning:** (1) topper-photo inline encoding is checked against the live schema at sync time rather than pinned here — the map documents the size cap but not the wire encoding, and guessing an encoding into a live partner API is worse than shipping photos in a fast follow. (2) `syncInProgress` lives on the connection row (atomic flip) rather than a separate lock collection — one document, one guarded update, matching the codebase's refuse-by-index habit. (3) `connectWithKey` is implemented generically in Task 8 despite no 9a adapter using it, because writing the service against the full interface now is what makes 9b adapter-only.
