# eduFleet Connection Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** IDAP can obtain a per-school grant from eduFleet Exchange through its four-step consent chain, and prove it against the live API.

**Architecture:** A new `PlatformAdapter` registered into the existing connector framework, using the `REQUEST_APPROVE_REDEEM` mode PassPercent already uses. No vacancy data leaves IDAP in this plan — the push is Plan B2.

**Tech Stack:** Next.js 16 App Router, Mongoose 8, Zod 4, TypeScript, Vitest 3.

**Spec:** `docs/superpowers/specs/2026-08-28-edufleet-vacancies-design.md` (§8 is this plan; §5-§7 are Plan B2's)

**Reconnaissance source (binding):** `docs/integrations/edufleet-api-map.md` (2026-08-28), §1 and §2. Where this plan and that map disagree, **the map wins** — report the disagreement rather than silently following either. eduFleet's repo at `/Users/automicai/edufleet-exchange` is **READ-ONLY**: never edit, commit, lint, or run anything in it.

## Global Constraints

Every task's requirements implicitly include these.

- **Tenant scoping is absolute.** Every read and write is `institutionId`-scoped.
- **A grant token is a credential.** It is stored encrypted via the existing vault path and must never be logged, echoed in an error, or returned from a service to a route. eduFleet returns it exactly once — there is no second chance to fetch it.
- **Adapters never touch models.** The service loads data and passes it in; that is the stated contract of `SyncSourceData` in `src/lib/connectors/types.ts`.
- `npx tsc --noEmit` → 0 errors. `npx eslint src` → **exactly 0 errors / 7 warnings**. Run eslint yourself and report the count.
- Full suite green. **Baseline at plan start: 1537 tests / 121 files.**
- **No `git checkout`, `git switch`, `git worktree add`, or `git stash`** — shared working directory. A stash has already silently reverted work once here.
- **Restore verification:** `git diff --quiet` is not valid, and neither is a plain `git diff` on a file **untracked** at mutation time — git does not show untracked files, so an empty result is guaranteed regardless of contents. Use `grep` or a scratchpad copy.
- **After a mutate/restore cycle, a suite failure whose signature matches the mutation is a stale `node_modules/.vite` transform cache suspect first, not a flake.** It keys on mtime granularity and produced exactly that false signal on the previous branch. Clear it before attributing anything.
- `rate-limit`, `token-endpoints`, `tenant-isolation` and several integration files genuinely flake under full-suite load with an `ECONNREFUSED 127.0.0.1:27017` signature. Re-run in isolation before attributing anything.
- **A test must FAIL when the behaviour it guards is removed**, and a mutation check is only valid if the mutated line lies on the path the assertion actually executes. Twelve confounded tests have been found on this project across four plans.
- Never kill a dev server by name or pattern; find the PID with `lsof -nP -iTCP:3000 -sTCP:LISTEN -t`, confirm its cwd, kill by PID.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/constants.ts` | `"EDUFLEET"` in `PLATFORMS`, its `PLATFORM_LABELS` entry. |
| `src/lib/connectors/edufleet.ts` (new) | The adapter: `initiate`, `refresh`, and a placeholder `sync`. |
| `src/lib/connectors/index.ts` | One side-effect import line. |
| `tests/unit/edufleet-adapter.test.ts` (new) | Adapter behaviour against a stubbed `ConnectorHttp`. |

---

### Task 1: Register the platform and implement `initiate`

**Files:**
- Modify: `src/lib/constants.ts`, `src/lib/connectors/index.ts`
- Create: `src/lib/connectors/edufleet.ts`
- Test: `tests/unit/edufleet-adapter.test.ts`

**Interfaces:**
- Consumes: `PlatformAdapter`, `AdapterContext`, `InitiateResult` from `src/lib/connectors/types.ts`; `registerAdapter` from `./index`.
- Produces: the `EDUFLEET` platform member and a registered adapter with `connectMode: "REQUEST_APPROVE_REDEEM"`. Task 2 extends the same module.

**Read `src/lib/connectors/passpercent.ts` first and mirror its structure.** It is the only existing implementation of this mode, and its `initiate` already handles the duplicate-request case in the shape eduFleet also uses.

`PLATFORM_LABELS` is `Record<Platform, string>`, so adding to `PLATFORMS` **forces** the label at compile time — that is the intended safety, not an inconvenience to work around with a cast.

**The endpoint** (api-map §1.2 step 1): `POST /api/partner/connection-requests`, authenticated with the **platform key** as `Authorization: Bearer <token>` — which is what `createConnectorHttp` already sends. Body requires `externalRef` (IDAP's own `institutionId`) and `payload.institutionName`. Success is **201** with `{ requestId, status }`.

**The 409 that is not an error.** On a collision eduFleet returns 409 `duplicate_open_request` **with the existing `requestId` in the body**. That is the same adopt-and-continue case PassPercent's `initiate` already implements: an open request already exists for this partner and institution, so IDAP should adopt its id and carry on rather than fail. Treating it as an error would strand a school with a request it can never complete.

- [ ] **Step 1: Write the failing tests**

Cover, each as its own named test, against a stubbed `ConnectorHttp` (no network):

- A 201 returns `{ remoteRequestId, remoteStatus }` from the response body.
- A **409 `duplicate_open_request`** returns the **existing** `requestId` from the error body rather than throwing — name this `MUTATION-DISTINGUISHING: an existing open request is adopted, not treated as a failure`.
- A 409 with **no** `requestId` in the body throws rather than returning `undefined` as an id — a malformed response must not become a connection pointing at nothing.
- Any other non-2xx throws.
- The request body carries `externalRef` and `payload.institutionName`, and **does not** carry the platform key in the body — it belongs in the header.

- [ ] **Step 2: Run to verify they fail. Step 3: Implement. Step 4: Run to verify they pass.**

- [ ] **Step 5: Mutation-check**

(a) Make the 409 branch rethrow → the adopt test fails.
(b) Drop the `requestId`-present check → the malformed-409 test fails.

Restore each, verify by `grep`, report both messages.

- [ ] **Step 6: Commit**

```bash
git add src/lib/constants.ts src/lib/connectors/edufleet.ts src/lib/connectors/index.ts tests/unit/edufleet-adapter.test.ts
git commit -m "feat: register the eduFleet platform and implement initiate"
```

---

### Task 2: `refresh`, redeem, and the placeholder `sync`

**Files:**
- Modify: `src/lib/connectors/edufleet.ts`
- Test: `tests/unit/edufleet-adapter.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's adapter module; `RefreshResult`, `SyncOutcome`, `ConnectorAuthError` from `src/lib/connectors/types.ts`.
- Produces: a complete connection lifecycle. Plan B2 replaces `sync`'s body.

**The state machine** (api-map §1.2). eduFleet's `PartnerConnectionRequest.status` is one of `pending`, `awaiting_school`, `approved`, `rejected`, `completed`. Map them onto `RefreshResult`:

| eduFleet status | `RefreshResult.kind` |
|---|---|
| `pending` | `PENDING` — an admin has not matched it to a school yet |
| `awaiting_school` | `AWAITING_APPROVAL` — matched; the school itself has not confirmed |
| `rejected` | `REJECTED` |
| `approved` | redeem, then `CONNECTED` |
| `completed` | see the defensive branch below |

**Redeem** (§1.2 step 4): `POST /api/partner/connection-requests/{id}/redeem` with the platform key. Response, **returned once and never again**:

```json
{ "token": "ef_pgrant_...", "schoolId": "...", "externalRef": "...", "scopes": ["jobs:write"], "prefix": "ef_pgrant_xxxx" }
```

Three things about that response matter:

1. **It contains no school name, city or slug.** `RefreshResult.remoteInstitution` therefore needs a **follow-up `GET /api/partner/school`** using the just-minted grant. Do that inside `refresh`, and treat its failure as non-fatal: a connection with an unnamed school is still a working connection, and losing the grant because a cosmetic lookup failed would be far worse.
2. **`slug` can never be populated.** eduFleet's `School` model has no slug field at all. Leave it `undefined` — do not invent one from the name.
3. **The token is the credential.** Never log it, never include it in an error message, never return it anywhere but the `RefreshResult`.

**The defensive `completed` branch.** A request already `completed` means something redeemed it — and since the grant is returned exactly once, IDAP cannot obtain it now. PassPercent's `refresh` already has this shape for the same reason. Return a non-`CONNECTED` result with a detail an operator can act on, rather than throwing or silently retrying. eduFleet also returns 409 `already_redeemed` and 409 `not_approved` on the redeem endpoint; both are the same class.

**Revocation.** When a school disconnects on eduFleet's side, a grant-authenticated call returns **401 with reason `revoked`**. Throw **`ConnectorAuthError`** — verified at `types.ts:90`; that is the actual export name. The connection service catches it and flips the connection's state. Read its docblock before using it: it exists precisely to distinguish "the grant we hold is no longer honoured" from any other request-shaped failure.

**The placeholder `sync`.** `sync` is required on `PlatformAdapter` and this plan has nothing to push. `SyncStatus` is `"SUCCESS" | "PARTIAL" | "FAILED"` (`constants.ts:472` — verified), so the honest answer must be one of three.

Return **`PARTIAL`**, with one step `{ step: "vacancies", ok: false, … }` and a warning saying plainly that vacancy publishing is not enabled yet. The reasoning, because the choice is not obvious: `SUCCESS` is the fabrication this plan refuses — nothing was pushed. `FAILED` is also untrue and worse in practice: nothing broke, and painting a normal state red trains an operator to ignore red. `PARTIAL` is the only remaining option that is true, with the warning carrying what an operator needs to know. **Do not throw.** Plan B2 replaces this body.

- [ ] **Step 1: Write the failing tests**

- Each of the four straightforward statuses maps to its `RefreshResult.kind`.
- `approved` triggers redeem and returns `CONNECTED` carrying the grant token and scopes.
- After a successful redeem, `remoteInstitution.name` and `.city` come from the follow-up call, and **`slug` is `undefined`** — name this `MUTATION-DISTINGUISHING: slug has no source in eduFleet and is never invented`.
- A **failing follow-up call still returns `CONNECTED`** with the grant intact — name this `MUTATION-DISTINGUISHING: a cosmetic lookup failure never costs the grant`.
- `completed` returns a non-`CONNECTED` result with an actionable detail.
- A 401 whose body reason is `revoked` throws `GrantRevokedError`; a 401 with any other reason does not.
- `sync` returns `PARTIAL` with `ok: false` on its single step and a warning naming the reason — **not** `SUCCESS`, and not a throw.

- [ ] **Step 2: Run to verify they fail. Step 3: Implement. Step 4: Run to verify they pass.**

- [ ] **Step 5: Mutation-check**

(a) Make the follow-up call's failure propagate → the grant-intact test fails.
(b) Populate `slug` from the school name → the slug test fails.
(c) Remove the `revoked` reason check so every 401 throws `ConnectorAuthError` → the other-reason test fails.

Restore each, verify by `grep`, report all three messages.

- [ ] **Step 6: Commit**

```bash
git add src/lib/connectors/edufleet.ts tests/unit/edufleet-adapter.test.ts
git commit -m "feat: complete the eduFleet connection lifecycle"
```

---

### Task 3: Live verification against the running eduFleet

**Files:** none (a verification task; the report is the deliverable)

This is the reason the connection half was split from the push. Mocks prove the adapter matches the map; only the live API proves the map matches eduFleet.

**Both applications must be running.** IDAP's dev server on :3000 — restart it by PID first, confirming its cwd is this repo, **never by name or pattern**. eduFleet is a separate Next.js app at `/Users/automicai/edufleet-exchange`; start it on a **different port** and note which. That repo is **READ-ONLY** — running its own dev server is permitted, editing it is not.

IDAP login: `admin@infinityschool.edu.in` / `Infinity!2026` (INS0001). The platform admin is `admin@leadplatform.app` / `Qxw7J-ectTR-dgNhN` — read from `.env.local`'s `SEED_SUPER_ADMIN_*`, not the seed script's fallback.

Walk the whole chain and record each step's request and response:

1. Issue a partner key in eduFleet's admin surface. Store it in IDAP's vault via the super-admin Platforms page. **Confirm it is encrypted at rest** — read the stored document and verify the plaintext key does not appear.
2. From INS0001's Integration tab, open a connection request. Verify IDAP records the `requestId` and shows `PENDING`.
3. Refresh before any admin action — must stay `PENDING`.
4. Open a **second** request for the same institution. It must **adopt** the existing `requestId`, not fail.
5. In eduFleet, match the request to a school. Refresh → `AWAITING_APPROVAL`.
6. As that school in eduFleet, confirm. Refresh → redeem happens, connection becomes `CONNECTED`, and the school's **name and city** appear from the follow-up call while **slug is absent**.
7. Refresh again — must not attempt a second redeem, and must not lose the grant.
8. In eduFleet, have the school **disconnect**. Trigger a grant-authenticated call from IDAP and confirm the `401 revoked` path marks the connection disconnected rather than surfacing a generic error.
9. Press Sync. Confirm the honest placeholder appears — not a fabricated success.
10. Console and server logs: **confirm the grant token appears in neither.**

**Cleanup.** You are in the **dev database**. Note what exists before you start; remove only what you created, in both applications; verify by listing. If you cannot tell whether something was yours, say so and leave it.

- [ ] Record every command, request, response and screenshot in the task report.

---

## Self-Review

**Spec coverage:** spec §8 (the adapter and connection lifecycle) → Tasks 1-2; live proof → Task 3. §5, §6, §7 and §9-§12 are **Plan B2's** — reference data for the payload, the contract split, listing state, error mapping for pushes, and consent copy all require a push that does not exist here.

**Deliberately deferred to Plan B2, named so nobody builds them early:** the `listing` block on `Vacancy`, the publish action and its disclosure copy, claim handling, `FILLED` → `closed`, the vacancy→job mapping module, and the two obligations Plan A's review carried forward (gate publish on `Institution.city`; replace `remove`'s hard delete before a vacancy id doubles as a live advert's id).

**Placeholder scan:** no TBDs. The one deliberate placeholder — `sync`'s body — is specified as returning an honest non-success, with its replacement named.

**Type consistency:** `EDUFLEET` is added to `PLATFORMS` in Task 1 and consumed by the registry in the same task. `RefreshResult`, `SyncOutcome` and `ConnectorAuthError` are existing exports of `src/lib/connectors/types.ts`, not new types — the error class was checked at source after an earlier draft of this plan invented the name "GrantRevokedError" from its docblock's prose.

**Verified at source while writing this plan:** `PlatformAdapter`'s shape and that `sync` is **required**, not optional (`types.ts:58-63`); that `SyncSourceData` is Result-centric and has no vacancy field; that the registry self-registers by side-effect import (`connectors/index.ts`); that `PLATFORM_LABELS` is `Record<Platform, string>` so the enum addition forces the label; that `connections-panel.tsx` reads `PLATFORM_LABELS[entry.platform]` and so needs no per-platform code; and eduFleet's four-step chain, its five request states, its exact redeem response shape and its `duplicate_open_request` 409, all from api-map §1.

---

## Task 4 (amendment) — make the adapter work against the live API

Tasks 1-2 built the adapter from `docs/integrations/edufleet-api-map.md` and
tested it against a stubbed HTTP client, so it passed everything the map said
it should. Task 3 drove the *live* eduFleet and found the map had gone stale
the same day it was written: `POST /api/partner/connection-requests` had
acquired a required `scopes` array, and without it every request comes back
`400 validation_failed` — **the adapter could not open a connection at all.**
Four further defects surfaced alongside it. Task 4 is the fix wave, and the
api-map itself is part of the deliverable: it is the document Plan B2 will be
built from, and this task is the proof that a stale map yields a broken
adapter.

1. **BLOCKING — send `scopes` on the connection request.** `REQUESTED_SCOPES
   = ["jobs:write"]`, copied fresh per call, in `buildConnectionRequestBody`.
2. **Make a failed request diagnosable.** `describeFailure` folds eduFleet's
   `reason` and first `details[].message` into the thrown error (capped at 200
   chars — the body is remote-controlled and the string is persisted as
   `lastError` and displayed), at all three throw sites.
3. **A poll that finds `completed` must not destroy a working connection.**
   eduFleet keeps the request row queryable forever after redeem, so every
   refresh of a live connection landed on that branch and overwrote
   `CONNECTED` with `REJECTED`. The grant IDAP already holds separates the two
   cases.
4. **A re-connect must not report "Requested" when eduFleet is already waiting
   on the school.** eduFleet's auto-remap returns `201
   {"status":"awaiting_school"}`; `InitiateResult` grows an optional `kind` the
   service honours, defaulting to `PENDING` for adapters that omit it.
5. **`refresh` must recognise a revoked grant instead of throwing a generic
   502.** `ConnectionService.refresh`'s catch gains a `ConnectorAuthError`
   branch that flips the row to `DISCONNECTED` and unsets the dead ciphertext.
   Deliberately *not* the `redeem` restructure Task 3's report recommended:
   every other failure between redeem and persist is already swallowed by
   `fetchRemoteInstitution`, so only the `401 revoked` path throws — and there
   the grant is already dead. The handling was broken, not the ordering.
6. **The documents, and one line of copy.** The admin Platforms page now names
   eduFleet Exchange; the api-map is re-verified in place (scopes, auto-remap,
   the 20-reason catalog, contract 1.1.0, the `openapi.json` gap that hid the
   `scopes` requirement, and the MongoDB replica-set prerequisite for partner
   onboarding).

### Explicit input to Plan B2

Two properties B1 leaves open by design. Neither is reachable in B1, and both
become live the moment B2's push exists — they are recorded here so B2 starts
holding them rather than discovering them.

> **Plan B2 obligation — `sync` is the sole revocation detector.** No path in
> B1 makes a grant-authenticated call for an established connection, so a
> school's revocation is invisible until B2's push runs. B2's `sync` must treat
> a `401 revoked` as authoritative and route it through the
> `ConnectorAuthError` branch.

> **Plan B2 obligation — do not resurrect a dead grant.** Once B2's `sync` can
> raise `ConnectorAuthError`, `syncNow`'s `ERROR` path leaves a known-dead
> ciphertext on the row while `refresh`'s `completed`-with-grant branch returns
> `CONNECTED` on the strength of that ciphertext alone. Resolve the
> `ERROR`-vs-`DISCONNECTED` asymmetry, or have the `completed` branch consider
> the stored status, before the push ships.
