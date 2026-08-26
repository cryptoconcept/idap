# Platform Connections — Design

**Status:** approved direction, awaiting spec review
**Date:** 2026-08-27
**Phase:** 9 (executed as two plans: 9a framework + PassPercent, 9b FeesBasket)

---

## 1. What this is

IDAP holds an institution's profile, results, fees, scholarships and offers —
and today none of it can leave. External listing platforms (PassPercent,
FeesBasket) each expose a **partner ingestion API** that IDAP can push into,
so an institution maintains its data once, in IDAP, and its public listings
elsewhere stay current.

This phase builds the outbound side: a connection framework inside IDAP with
one **adapter per platform**, per the standing instruction that connectors
live in IDAP itself rather than as separate services.

### Ground truth

Both target APIs were mapped by read-only reconnaissance against their live
route handlers, with every doc/code disagreement recorded. **These two
documents are the binding contract references for this phase — implementers
read them, not the platforms' own docs:**

- `docs/integrations/passpercent-api-map.md` (repo HEAD `ae412fe`)
- `docs/integrations/feesbasket-api-map.md` (repo HEAD `96a357d`)

Key confirmation: the connection-request lifecycle that was missing when this
work was first paused **now exists in PassPercent's live code**, and
FeesBasket's institution-initiated connection-key flow is merged and
self-serve. Both platforms implement the same two-layer contract model the
user described: a platform credential proving "this is IDAP", plus a
per-institution grant proving "this institution authorised IDAP".

### Decisions already made (user-approved 2026-08-27)

1. **One spec, two plans.** Plan 9a: framework + PassPercent adapter (the
   harder connect flow — approval + polling + redeem — proves the framework).
   Plan 9b: FeesBasket adapter.
2. **Manual "Sync now" only** in this phase. Automatic on-publish hooks and
   scheduled sync are follow-ups once the mapping is proven.
3. **Platform credentials live encrypted in the DB**, managed from a
   super-admin UI — not env vars. One env secret (the encryption key)
   instead of N platform keys; onboarding a platform needs no redeploy.

---

## 2. The two contracts, side by side

| | PassPercent | FeesBasket |
|---|---|---|
| Platform credential | `pp_pkey_…` — connection management ONLY, structurally cannot resolve an institution | `fbk_live_…` — used on EVERY call, including data pushes |
| Per-institution grant | `pp_pgrant_…` token, held by IDAP, presented on data pushes | Server-side `PartnerGrant`; IDAP holds **no** per-institution token — the grant is keyed by `(partner, externalId)` |
| Who initiates | IDAP submits a connection request; PassPercent admin matches; a claimed school approves from its own dashboard; IDAP polls, then redeems (single-use) | The institution generates a single-use `fbc_live_…` key (24h TTL) in its FeesBasket portal and pastes it into IDAP; IDAP redeems immediately |
| Push surface | `PATCH /partner/institution` (profile) + `PUT /partner/institution/results/:year` (wholesale per year) | One `POST /partner/institutions/{externalId}` carrying profile/programs/fees/placements/results/scholarships/media as sections of a partial merge |
| Idempotency | None (results PUT is naturally idempotent) | `Idempotency-Key` header **mandatory** (422 without) |
| Quota / limits | 500 writes/day per grant, 5000/day platform aggregate; 60 req/min per grant | 60 req/min per API key; **no** plan-tier gating |
| Self-description | `GET /partner/schema` (fields, enums, rules — route-validated) | `GET /partner/me` (live enum vocabularies) |
| Cannot push | fees detail beyond `{label, annual, oneTime}` rows; anything on an unapproved listing | **offers** (their offers API is session-cookie-only — confirmed in code despite a commit message suggesting otherwise) |

The shared shape: *one platform credential held once, one grant per
institution redeemed once, everything encrypted at rest, all pushes scoped by
the grant rather than by ids IDAP chooses.* That is the framework. The
connect-flow UX and the payload mapping are what each adapter owns.

---

## 3. Data model

### 3.1 `src/models/PlatformCredential.ts` — one row per platform, super-admin-owned

```ts
const PlatformCredentialSchema = new Schema(
  {
    platform: { type: String, enum: PLATFORMS, required: true, unique: true },
    /** AES-256-GCM ciphertext of the platform key (pp_pkey_… / fbk_live_…). */
    keyEncrypted: { type: String, required: true, select: false },
    /** API origin, e.g. https://api.passpercent.in — configurable so dev points at localhost. */
    baseUrl: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
```

`PLATFORMS = ["PASSPERCENT", "FEESBASKET"] as const` in `constants.ts`, with
labels. (EduFleet Exchange joins this enum in a later phase — see §12.)

### 3.2 `src/models/PlatformConnection.ts` — one row per institution × platform

```ts
const PlatformConnectionSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    platform: { type: String, enum: PLATFORMS, required: true },
    status: { type: String, enum: CONNECTION_STATUSES, default: "PENDING" },
    /** The remote system's own status string, verbatim, for display/debugging. */
    remoteStatus: { type: String, trim: true },
    /** PassPercent's connection-request id, needed to poll and redeem. */
    remoteRequestId: { type: String, trim: true },
    /** What IDAP submitted as its identifier for this institution (institutionId). */
    externalRef: { type: String, required: true, trim: true },
    /** AES-256-GCM ciphertext of the per-institution grant (PassPercent only; FeesBasket holds its grant server-side). */
    grantTokenEncrypted: { type: String, select: false },
    /** Scopes the grant carries, as the platform reported them. */
    scopes: { type: [String], default: undefined },
    /** Snapshot of the remote institution identity, from the redeem/connect response. */
    remoteInstitution: {
      type: new Schema({ name: String, city: String, slug: String }, { _id: false }),
      default: undefined,
    },
    lastSyncAt: { type: Date },
    lastSyncStatus: { type: String, enum: SYNC_STATUSES },
    lastError: { type: String, trim: true },
  },
  { timestamps: true },
);
PlatformConnectionSchema.index({ institutionId: 1, platform: 1 }, { unique: true });
```

`CONNECTION_STATUSES = ["PENDING", "AWAITING_APPROVAL", "CONNECTED", "REJECTED", "DISCONNECTED", "ERROR"]`.
PassPercent walks `PENDING → AWAITING_APPROVAL? → CONNECTED`; FeesBasket goes
straight to `CONNECTED` on redeem. `remoteStatus` carries the platform's own
richer string so IDAP's coarse machine never has to mirror every remote state.

### 3.3 `src/models/SyncRun.ts` — the delivery log

The part integrations skip and then cannot support. One row per "Sync now":

```ts
const SyncRunSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    platform: { type: String, enum: PLATFORMS, required: true },
    trigger: { type: String, enum: ["MANUAL"], default: "MANUAL" },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    status: { type: String, enum: SYNC_STATUSES, required: true },
    /** One entry per push step: { step, ok, detail } — "profile", "results:2025-26", … */
    steps: { type: [new Schema({ step: String, ok: Boolean, detail: String }, { _id: false })], default: undefined },
    /** Mapping losses the admin should know about: unmapped streams, skipped toppers, dropped enum values. */
    warnings: { type: [String], default: undefined },
    error: { type: String, trim: true },
  },
  { timestamps: true },
);
SyncRunSchema.index({ institutionId: 1, platform: 1, createdAt: -1 });
```

`SYNC_STATUSES = ["SUCCESS", "PARTIAL", "FAILED"]`. On insert, prune to the
newest 20 per (institution, platform) — a log, not an archive.

### 3.4 Encryption — `src/lib/security/credentials.ts`

AES-256-GCM. Key from env `IDAP_CREDENTIAL_KEY` (32 bytes, base64).
`encryptCredential(plain): string` → `iv.ciphertext.tag` (base64 segments);
`decryptCredential(blob): string`. A missing/malformed env key disables the
whole connections feature with an explicit admin-facing message — never a
crash, and never a silent fallback to plaintext.

---

## 4. The adapter interface — `src/lib/connectors/types.ts`

```ts
export type ConnectMode = "REQUEST_APPROVE_REDEEM" | "PASTE_KEY";

export interface PlatformAdapter {
  platform: Platform;
  connectMode: ConnectMode;
  /** REQUEST_APPROVE_REDEEM only: submit the connection request. */
  initiate?(ctx: AdapterContext, institution: InstitutionSummary): Promise<InitiateResult>;
  /** REQUEST_APPROVE_REDEEM only: poll remote status; redeem when approved. */
  refresh?(ctx: AdapterContext, connection: ConnectionState): Promise<RefreshResult>;
  /** PASTE_KEY only: redeem a key the institution pasted. */
  connectWithKey?(ctx: AdapterContext, institutionId: string, key: string): Promise<ConnectResult>;
  /** Push everything the scopes allow. Never throws for mapping losses — reports them. */
  sync(ctx: AdapterContext, connection: ConnectionState): Promise<SyncOutcome>;
}
```

`AdapterContext` carries the decrypted platform key, `baseUrl`, and the shared
HTTP client. `SyncOutcome` = `{ status, steps, warnings, error? }` — exactly
what `SyncRun` stores. The service layer owns all persistence and encryption;
adapters are pure protocol + mapping and touch no models directly, which is
what makes them testable against a mocked HTTP layer.

The UI branches on `connectMode`: PassPercent renders "Request connection" →
status → "Check status" (which auto-redeems on approval); FeesBasket renders
a paste-the-key form with instructions pointing at the institution's own
FeesBasket portal.

**Registry:** `src/lib/connectors/index.ts` exports `adapterFor(platform)`.
Adding a platform = one adapter file + one enum member + one credential row.

### 4.1 Shared HTTP client — `src/lib/connectors/http.ts`

`fetch` wrapper: JSON in/out, timeout (15s), normalised
`ConnectorHttpError { status, code?, body }`, and exactly one retry on `429`
honouring `Retry-After`. No other automatic retries — sync is manual, and the
admin's retry button is the retry policy in this phase.

---

## 5. What syncs, and on whose authority

**Only PUBLISHED records leave, and only when the grant's scopes cover them.**
The publish gates are the institution's editorial control (including topper
consent, enforced at publish time); the connection's scopes — chosen by the
institution when it authorised the link — are the sharing consent.

Adapters read **internal service DTOs** (`ResultService.list`,
`FeeStructureService.list`, `ScholarshipService.list`, the Institution doc),
filtered to `status === "PUBLISHED"` — NOT the public projections. This is
deliberate: IDAP's own public API deliberately withholds fields (combinations,
placement, selections are not in `toPublicResult`) that the institution *does*
want on the partner platform — pushing them there is the entire reason Result
Enrichment collected them. Recorded so nobody later "fixes" the adapters to
read the narrower projections.

Institutions whose own `profileStatus` is not `PUBLISHED` cannot sync
(refused with a clear message) — an unpublished IDAP profile pushing to a
public listing elsewhere would be backwards.

---

## 6. PassPercent adapter — `src/lib/connectors/passpercent.ts` (Plan 9a)

### 6.1 Connect flow

Per `passpercent-api-map.md` §2. `initiate` → `POST /api/partner/connection-requests`
with `externalRef = institutionId`, plus name/city/address context fields for
the matching admin. `refresh` → `GET /partner/connection-requests/:id`; maps
`pending → PENDING`, `awaiting_school → AWAITING_APPROVAL`,
`rejected → REJECTED`; on `approved`, immediately redeems
(`POST …/:id/redeem`), encrypts the grant token, stores scopes and the
institution snapshot, → `CONNECTED`. Redeem is single-use and the token is
shown once — the redeem response is never logged.

Two lifecycle wrinkles the map documents, both handled: a re-submitted
`externalRef` can return `201` with a *new* requestId after the remote swept
an orphan (adopt the new id); and `409 {requestId}` on initiate means an open
request already exists (adopt that id rather than erroring).

### 6.2 Sync order — profile first, always

PassPercent rejects results for a stream the institution hasn't declared
(validation order in map §3), so: **step 1** `PATCH /partner/institution`
(includes `streams`), **step 2** one `PUT /partner/institution/results/:year`
per academic year. A profile-step failure aborts the run as `FAILED`; a
per-year failure records that step and continues (`PARTIAL`).

### 6.3 Profile mapping

| IDAP | PassPercent | Note |
|---|---|---|
| `institutionName` | `name` | |
| `city` | `city` | |
| `description` | `about` | |
| `phone`, `website` | same | |
| `address`, `area`, `district`, `taluk`, `state`, `pincode` | `addressLine`, `area`, `district`, `taluk`, `state`, `pincode` | |
| `academic.board` | `board` | Only if the value appears in `GET /partner/schema`'s enum — else dropped + warned |
| — | `type` | **Always omitted.** Write-restricted to `School`/`College`; sending anything else 409s (map §3) |
| derived | `streams` | Union of segment-derived streams and every stream results will push (§6.4) — MUST be a superset of the results payload's keys |

**Enum-valued fields are validated against the live `GET /partner/schema`
response at sync time** — a value outside the platform's enum is dropped from
the patch and reported as a warning, never sent to fail the whole request.
The self-describing endpoint exists for exactly this; a frozen local copy of
their enums would drift.

### 6.4 Stream mapping (results)

IDAP `Result.level` (+ institution type for UG) → PassPercent stream key:

| IDAP level | Stream | |
|---|---|---|
| `CLASS_10` | `sslc` | |
| `CLASS_12`, `PUC_2` | `puc` | |
| `UG` + `ENGINEERING_COLLEGE` | `engineering` | |
| `UG` + `MEDICAL_COLLEGE` / `NURSING_COLLEGE` | `medical` | |
| `UG` + other types | `degree` | |
| `PUC_1`, `PG`, `DIPLOMA`, `OTHER` | **unmapped** | Skipped and named in `SyncRun.warnings` + the UI — silence is indistinguishable from a sync bug (Result Enrichment spec §12.3) |

A code-level constant, not a per-institution config table. *Deviation from
Result Enrichment §12.1, which suggested a config table:* no per-institution
variance exists to configure yet, and the load-bearing requirement — the
explicit, surfaced unmapped outcome — is met by the warnings channel. A table
can replace the constant when a second platform's stream vocabulary disagrees.

**Rollup rule (Result Enrichment §12.2, binding):** when several IDAP results
land on one (stream, year) — e.g. two CLASS_12 boards — `appeared`/`passed`
are **summed and `passPct` recomputed** from the sums. Percentages are never
averaged. Bounds guarded with `!= null`: a result with unreported
`appeared` contributes nothing to the denominator and adds a warning.

### 6.5 Results payload mapping

Per map §5. Toppers: `{rank, name, pct}` all required by PassPercent — IDAP
toppers missing `rank` or `percentage` are skipped with a warning (deriving a
rank would publish invented data). Topper photos: fetched from IDAP storage,
inlined base64 when ≤ 200KB raw, else pushed without photo + warning.
Combinations → `combinations` map keyed by the IDAP label; recruiters'
`category` maps 1:1 lowercase (`IT→it` …); selections map 1:1
(`NEET→neet, JEE_MAIN→jeeMain, JEE_ADVANCED→jeeAdvanced, KCET→kcet,
COMEDK→comedk` — verified against both codebases). Gender splits and grade
buckets pass through by their matching names.

### 6.6 Refusals the adapter must classify

`403 needs_school_consent` → connection stays `CONNECTED`, run `FAILED` with
that reason surfaced verbatim (the school disconnected or the listing lost
consent remotely). `401` on a grant call → connection → `ERROR`, "reconnect
required". `429` (either quota body) → `FAILED` with the quota message; the
daily caps (500/grant) are far above one manual sync's needs, so no pacing
logic in this phase.

---

## 7. FeesBasket adapter — `src/lib/connectors/feesbasket.ts` (Plan 9b)

### 7.1 Connect flow

`connectWithKey` → `POST /api/v1/partner/connections {connectionKey,
externalId: institutionId}` → `201` → `CONNECTED`, storing scopes + the
institution snapshot. No token to hold: every later call uses the platform
key, addressing the institution by `externalId`. The paste form's helper text
tells the admin where the key comes from (their FeesBasket portal →
Integrations) and that it expires in 24h, single-use.

### 7.2 Sync — one idempotent POST

Read current remote state (`GET /partner/institutions/{externalId}` — pushes
are partial merges, so remote state cannot be inferred from send history),
then one `POST /partner/institutions/{externalId}` with:

- `Idempotency-Key: <syncRunId>` — mandatory; retrying a failed run reuses a
  NEW run id (their journal replays same-key-same-payload verbatim, and a
  changed payload under an old key would 409).
- Sections filtered to the grant's scopes (`catalog`/`fees`/`outcomes`/`media`
  gate sections, not fields — map §4).

Every push body is whole-payload atomic on their side; a 422 lists
`{paths, issues}` which land verbatim in the run's error detail.

### 7.3 Mapping

| IDAP | FeesBasket section | Notes |
|---|---|---|
| Institution profile | `profile` | Near-field-parity (name, type, city, state, tagline, description, address block, geo, contacts, logoUrl/coverImageUrl as **absolute** URLs). `type` maps IDAP's 12 → their 20 (`SCHOOL→school, PU_COLLEGE→puc, DEGREE_COLLEGE→degree, ENGINEERING_COLLEGE→engineering, MEDICAL_COLLEGE→medical, B_ED_COLLEGE→education, NURSING_COLLEGE→nursing`, rest → `other`) |
| AcademicUnit (leaf) + its FeeStructure | `programs[]` with nested `fees.components[]` | `externalId = academicUnitId`; `level` maps like `type` above (their `level` reuses the institution-type enum — map §4's trap); fee line items → components: label→`type` by keyword table (tuition/admission/exam/transport/hostel/books/uniform/lab/mess/activity, else `other`), `ANNUAL→annual`, `ONE_TIME→one_time` |
| Result | `results[]` | `{externalId: resultId, year, metric, value}` — their result is a free-text metric/value pair; IDAP sends `metric: "Pass %"`, `value: "<passPct>"` plus appeared/passed as separate metric rows |
| Result.placement | `placements[]` under the matching program when resolvable, else skipped + warned | |
| Scholarship | `scholarships[]` | 1:1 — their shape (`name`, free-text `criteria`/`amount`) matches IDAP's model exactly |
| Gallery | `media[]` | `kind: "image"`, absolute URLs; **videos and brochures join when the Media phase lands** (§12) |
| Offer | — | **Not pushable.** Their offers API is session-cookie-only; the map confirms `IngestionPayload` has no offers field. Recorded prominently: the closest partner-writable analogue is `scholarships`. |

Deletions: IDAP's first version never sends `deletes.*` — a record
unpublished in IDAP simply stops being pushed, and stale remote rows are the
institution's to prune in the portal. Recorded as a known limitation (§11).

Enum vocabularies are read live from `GET /partner/me` at sync time and
unmapped values dropped + warned, same policy as §6.3.

---

## 8. Services and routes

### 8.1 `src/services/connection.service.ts`

`list(institutionId)` (connections + which platforms have active credentials),
`initiate(institutionId, platform, actor)`, `refresh(...)` (poll/redeem),
`connectWithKey(...)`, `syncNow(...)` (runs the adapter, writes the `SyncRun`,
updates the connection's lastSync fields), `disconnect(...)` (local: status →
`DISCONNECTED`, grant ciphertext deleted; the remote grant is revoked from the
platform's own dashboard — surfaced in the UI copy), `listRuns(...)`.
All tenant-scoped; every action `ActivityService.record`-logged
(`entityType: "PLATFORM_CONNECTION"`). Concurrent `syncNow` for one
connection is refused with a clear "already running" (an atomic
status-guarded update, not a pre-read).

`src/services/platform-credential.service.ts` (super-admin only): `list`
(masked — plaintext never leaves the server after write), `upsert`, `remove`.

### 8.2 Routes

Dashboard (INSTITUTION_ADMIN, CSRF-guarded, mirroring the settings-route
house pattern):

```
GET    /api/settings/connections
POST   /api/settings/connections/[platform]/initiate      (PassPercent)
POST   /api/settings/connections/[platform]/refresh       (PassPercent)
POST   /api/settings/connections/[platform]/connect-key   (FeesBasket)
POST   /api/settings/connections/[platform]/sync
DELETE /api/settings/connections/[platform]
GET    /api/settings/connections/[platform]/runs
```

Admin (SUPER_ADMIN, CSRF-guarded):

```
GET/PUT/DELETE /api/admin/platform-credentials[...]
```

Nothing new is publicly readable. No inbound webhooks in this phase — neither
platform emits any; PassPercent's own docs say "poll hourly is plenty".

### 8.3 UI

- **`/integration`** (existing admin-only page) gains a "Connected platforms"
  section: one card per platform — status badge, connect action branched on
  `connectMode`, Sync now, last-sync summary, expandable recent runs with
  their warnings (the unmapped/skipped channel §6.4 depends on), disconnect.
- **`/admin/platforms`** (new SUPER_ADMIN page + nav item): per platform —
  base URL, key (write-only field, masked after save), active toggle.

---

## 9. Testing

1. **Encryption round-trip** + missing-env behaviour (feature disabled, no crash).
2. **Mapping units (pure functions, the bulk of the value):** stream map incl.
   every unmapped level; the rollup rule (sums, never averaged percentages;
   `!= null` guards — a result with unreported `appeared` warns rather than
   contributing 0); topper skip rules; exam-code and recruiter-category maps;
   fee label→type keywords; institution-type maps; absolute-URL derivation.
3. **Connection lifecycle (integration, HTTP mocked):** initiate → 409-adopt;
   refresh through pending/awaiting/approved with single-use redeem; the
   swept-orphan 201-with-new-id case; paste-key happy path + expired/wrong
   key; tenant isolation (another institution's connection is NOT_FOUND).
4. **Sync (integration, HTTP mocked):** profile-before-results ordering;
   PARTIAL on a per-year failure; `needs_school_consent` classification;
   grant-401 → ERROR; SyncRun written + pruned at 20; concurrent-sync refusal;
   FeesBasket idempotency-key present and fresh per run; scope-filtered
   sections; only-PUBLISHED filtering.
5. **Credential routes:** masked reads (plaintext never in any GET), role
   guards (institution admin cannot reach `/api/admin/platform-credentials`).
6. **Manual E2E against the real platforms (verification step, not CI):**
   both repos run on this machine. Plan 9a ends with: run PassPercent's
   backend locally, mint a partner key via its admin, walk
   initiate→approve→redeem→sync for the seeded institution, and confirm the
   pushed data renders on the PassPercent listing. Plan 9b likewise with
   FeesBasket's dev server and portal-issued connection key. This is the
   browser-verification lesson applied to an integration: the mocked suite
   proves IDAP's logic, only the real platform proves the contract.

---

## 10. Definition of done (per plan)

**9a:** models + encryption + adapter interface + HTTP client + PassPercent
adapter + connection/credential services + all routes + both UI surfaces +
tests 1–5 + the 9a manual E2E. **9b:** FeesBasket adapter + its tests + the
9b manual E2E. Suite green, `tsc` clean, lint at baseline (0 errors /
7 warnings) throughout.

---

## 11. Known limitations

1. **Manual sync only.** Nothing pushes on publish; the admin clicks.
2. **No deletion propagation** (FeesBasket `deletes.*` unused; PassPercent
   results are wholesale-per-year so year-level deletion DOES propagate, an
   asymmetry worth knowing).
3. **PassPercent `type` never written**; `board` only when it matches their enum.
4. **Toppers without rank/percentage are skipped** (with warnings), not ranked
   by inference.
5. **FeesBasket offers cannot be pushed** — their API has no partner-writable
   offers surface.
6. **One credential set per deployment** — no per-environment credential rows
   beyond `baseUrl` being editable.
7. **Media pushes are images-only** until the Media phase lands (§12).

---

## 12. Roadmap context (what follows this phase)

1. **Media phase (videos + brochures)** — prerequisite for FeesBasket's
   `video`/`brochure`/`prospectus` media kinds. Sequenced BEFORE Plan 9b if
   ready in time; otherwise 9b ships images-only and the media kinds join in
   a follow-up. Gets its own spec.
2. **Teacher recruitment posts → EduFleet Exchange** — a third adapter, plus a
   new IDAP domain (recruitment posts do not exist in IDAP today), plus —
   pending reconnaissance now in flight — possibly the *receiving* partner API
   on the EduFleet side, which unlike PassPercent/FeesBasket may not exist
   yet. Own spec once recon lands; the §4 registry is where its adapter plugs in.
3. **Auto-sync on publish + scheduled reconciliation** — once manual sync has
   proven the mapping in production use.
