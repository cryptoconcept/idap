# eduFleet Vacancy Push (Plan B2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A school publishes an `OPEN` vacancy from IDAP and it appears as a live job on eduFleet Exchange; edits, fills and closes follow it.

**Architecture:** A `listing` block on the vacancy records what eduFleet knows. A pure mapping module turns a vacancy into either contract's payload and refuses locally anything eduFleet would reject. New optional adapter methods carry per-record CRUD — deliberately *not* an extension of `SyncSourceData`, which is Result-centric by construction. A publish service picks the contract per push (school grant when connected, platform key otherwise), and `sync` becomes a reconciler that also detects revocation.

**Tech Stack:** Next.js 16 App Router, Mongoose 8, Zod 4, TypeScript, Vitest 3, react-hook-form, Radix/shadcn, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-28-edufleet-vacancies-design.md`

**Live re-verification (binding):** `docs/integrations/edufleet-jobs-reverification.md`, 2026-08-28, against eduFleet at `e580f17`. It supersedes `docs/integrations/edufleet-api-map.md` wherever the two disagree — 11 map claims are stale and four of them change this plan's design. Where this plan states an eduFleet fact, it is from the re-verification, not the map.

## Global Constraints

- **eduFleet's repo (`/Users/automicai/edufleet-exchange`) is READ-ONLY.** Read it to check any claim. Never edit, lint, commit, or start its dev server.
- **`spendWrite` runs BEFORE validation on all four job routes.** Every `400` and every `409` permanently burns a daily write unit (500/day platform key, 100/day grant). **Never retry a 400 or a 409.** Validate locally before every push — that is the entire purpose of Task 2's pre-validation, and it is a quota-protection measure, not a nicety.
- **`403 claimed` is NOT terminal.** It has four triggers; `claimed` and `withdrawn` are terminal, but `claim_pending` reverts to `unclaimed` on admin claim-rejection and `hiddenPendingReview` clears on takedown-restore. **Never permanently retire a vacancy on a 403.** The spec's §7.1 is wrong on this point and this plan overrides it.
- **Contract Two's PATCH short-circuits on `status: "closed"`** — every other field in the same body is silently discarded and the 200 reports the pre-patch values. **Never combine a close with field edits in one call.**
- **A missing `title` or `description` escapes as an uncataloged 500 with no `reason`**, after burning a write. IDAP's model requires both, so this must stay structurally impossible; do not add a code path that can push a vacancy without them.
- `state` defaults to `"Karnataka"` on **Contract One only**. Contract Two never accepts `state`.
- `externalJobId` uniqueness is `(partnerId, externalJobId)` and **shared across both contracts**. On a 409, trust the response's `contract` field over any local assumption.
- **`sanitizeFacilities()` silently discards** unrecognised benefit labels — no error, no signal. Validate against `VACANCY_BENEFITS` before sending.
- Suite, `tsc --noEmit` and `eslint src` must stay green. Baseline: **1578 tests / 122 files, tsc 0, eslint 0 errors / 7 warnings.**
- Every test mutation-checked: break the guarded line, watch that test fail, restore, verify the restore by checksum or by re-reading the line — never by `git diff` alone.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/constants.ts` (modify) | `VACANCY_LISTING_CONTRACTS`, `VACANCY_CLAIM_STATES` |
| `src/models/Vacancy.ts` (modify) | the `listing` sub-document |
| `src/lib/validation/vacancy.ts` (modify) | publish input; `listing` is never user-settable |
| `src/lib/connectors/edufleet-vacancy-map.ts` (create) | **pure**: vacancy → payload for each contract, plus local pre-validation. No I/O, no models. |
| `src/lib/connectors/types.ts` (modify) | optional per-record push methods on `PlatformAdapter` |
| `src/lib/connectors/edufleet.ts` (modify) | implement them; real `sync` |
| `src/services/vacancy-publish.service.ts` (create) | contract selection, city gate, listing persistence, error mapping |
| `src/services/vacancy.service.ts` (modify) | `remove` must close before deleting |
| `src/app/api/settings/vacancies/[id]/publish/route.ts` (create) | the publish endpoint |
| `src/components/profile/sections/vacancies-section.tsx` (modify) | publish control, claimed state, error surfacing |
| `docs/integrations/edufleet-api-map.md` (modify) | fold in the 11 stale findings |

---

### Task 1: The `listing` block

**Files:**
- Modify: `src/lib/constants.ts`
- Modify: `src/models/Vacancy.ts`
- Modify: `src/lib/validation/vacancy.ts`
- Test: `tests/unit/vacancy-validation.test.ts`, `tests/integration/vacancy-service.test.ts`

**Interfaces:**
- Produces: `VacancyListing = { jobId: string; contract: "AGGREGATED" | "SCHOOL_POSTED"; lastPushedAt: Date; claimState?: "unclaimed" | "claim_pending" | "claimed"; blockedReason?: string }` on the vacancy DTO.

- [ ] **Step 1: Add the constants**

```ts
/** Which eduFleet contract created a listing. Contract One (platform key)
 *  produces an `aggregated` job the school may later claim; Contract Two
 *  (school grant) produces a `school_posted` job it already owns. */
export const VACANCY_LISTING_CONTRACTS = ["AGGREGATED", "SCHOOL_POSTED"] as const;
export type VacancyListingContract = (typeof VACANCY_LISTING_CONTRACTS)[number];

/** eduFleet's claim states, as far as IDAP can observe them. `claim_pending`
 *  is NOT terminal — an admin rejecting the claim returns the job to
 *  `unclaimed` (jobs-reverification S4), so IDAP must never treat a 403 as a
 *  permanent retirement. */
export const VACANCY_CLAIM_STATES = ["unclaimed", "claim_pending", "claimed"] as const;
export type VacancyClaimState = (typeof VACANCY_CLAIM_STATES)[number];
```

- [ ] **Step 2: Write the failing model test**

In `tests/integration/vacancy-service.test.ts`:

```ts
it("stores a listing block and returns it on the DTO", async () => {
  const v = await Vacancy.create({
    institutionId: "INS0001", title: "Maths Teacher", subject: "Mathematics",
    description: "Teach maths", status: "OPEN",
    listing: { jobId: "job-1", contract: "AGGREGATED", lastPushedAt: new Date(), claimState: "unclaimed" },
  });
  const found = await Vacancy.findById(v._id).lean();
  expect(found?.listing?.jobId).toBe("job-1");
  expect(found?.listing?.contract).toBe("AGGREGATED");
});

it("MUTATION-DISTINGUISHING: rejects a listing contract outside the enum", async () => {
  await expect(
    Vacancy.create({
      institutionId: "INS0001", title: "T", subject: "Mathematics", description: "d",
      listing: { jobId: "j", contract: "NOT_A_CONTRACT", lastPushedAt: new Date() },
    }),
  ).rejects.toThrow(/contract/);
});
```

- [ ] **Step 3: Run it, confirm it fails** — `npx vitest run tests/integration/vacancy-service.test.ts -t "listing block"`. Expect a failure on the unknown `listing` path.

- [ ] **Step 4: Add the sub-document**

```ts
    listing: {
      type: {
        jobId: { type: String, required: true, trim: true },
        contract: { type: String, required: true, enum: VACANCY_LISTING_CONTRACTS },
        lastPushedAt: { type: Date, required: true },
        claimState: { type: String, enum: VACANCY_CLAIM_STATES, default: "unclaimed" },
        // Why a push is currently refused, when eduFleet answers 403. Free
        // text because two of the four triggers are reversible and IDAP
        // re-checks rather than latching — see the Global Constraints.
        blockedReason: { type: String, trim: true },
      },
      default: undefined,
      _id: false,
    },
```

- [ ] **Step 5: Keep `listing` out of user input.** In `src/lib/validation/vacancy.ts`, confirm the create and patch schemas are `.strict()` (or add it) so a client cannot set `listing`. Add a test posting `{ listing: {...} }` to the create schema and asserting it is rejected — mutation-check by removing `.strict()`.

- [ ] **Step 6: Run the suite, then commit**

```bash
npx vitest run && npx tsc --noEmit && npx eslint src
git add -A && git commit -m "feat(vacancy): record what eduFleet knows about a vacancy"
```

---

### Task 2: The pure mapping module

This is the plan's most testable unit and its quota shield. It has no I/O, touches no model, and every rejection it makes is a write unit not burned.

**Files:**
- Create: `src/lib/connectors/edufleet-vacancy-map.ts`
- Test: `tests/unit/edufleet-vacancy-map.test.ts`

**Interfaces:**
- Produces:
  - `type VacancyPushInput = { vacancyId: string; title: string; subject: string; description: string; salaryMin?: number; salaryMax?: number; experienceRequired?: number; facilities?: string[] }`
  - `type InstitutionPushInput = { institutionName: string; city?: string; district?: string; state?: string }`
  - `buildAggregatedJobBody(v: VacancyPushInput, i: InstitutionPushInput): Rec`
  - `buildSchoolJobBody(v: VacancyPushInput): Rec`
  - `preflight(v: VacancyPushInput, i: InstitutionPushInput, contract: VacancyListingContract): string[]` — returns human-readable reasons the push **would** fail. Empty array means send it.

- [ ] **Step 1: Write the failing tests**

```ts
describe("preflight", () => {
  it("MUTATION-DISTINGUISHING: refuses a Contract One push with no city, before any write is spent", () => {
    const reasons = preflight(vac(), { institutionName: "DPS" }, "AGGREGATED");
    expect(reasons).toContain("eduFleet needs a city on the institution profile before a job can be published");
  });

  it("MUTATION-DISTINGUISHING: refuses a subject outside eduFleet's enum", () => {
    expect(preflight(vac({ subject: "Astrology" }), inst(), "AGGREGATED"))
      .toContainEqual(expect.stringContaining("Astrology"));
  });

  it("refuses a salary range that inverts", () => {
    expect(preflight(vac({ salaryMin: 50000, salaryMax: 10000 }), inst(), "AGGREGATED"))
      .toContainEqual(expect.stringContaining("maximum"));
  });

  it("passes a complete vacancy", () => {
    expect(preflight(vac(), inst(), "AGGREGATED")).toEqual([]);
  });
});

describe("buildSchoolJobBody", () => {
  it("MUTATION-DISTINGUISHING: never sends institutionName, city, district, state or sourceUrl", () => {
    const body = buildSchoolJobBody(vac());
    for (const forbidden of ["institutionName", "city", "district", "state", "sourceUrl"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("uses the vacancy id as externalJobId", () => {
    expect(buildSchoolJobBody(vac({ vacancyId: "vac-42" }))).toMatchObject({ externalJobId: "vac-42" });
  });
});

describe("buildAggregatedJobBody", () => {
  it("sends institutionName and city, which Contract Two must not carry", () => {
    expect(buildAggregatedJobBody(vac(), inst())).toMatchObject({ institutionName: "DPS", city: "Bengaluru" });
  });

  it("MUTATION-DISTINGUISHING: drops a benefit eduFleet does not recognise rather than sending it", () => {
    // eduFleet's sanitizeFacilities() discards unknown labels SILENTLY — no
    // error, no signal — so an unknown benefit must never leave IDAP.
    const body = buildAggregatedJobBody(vac({ facilities: ["Provident Fund", "Free Parking"] }), inst());
    expect(body.facilities).toEqual(["Provident Fund"]);
  });
});
```

- [ ] **Step 2: Run them, confirm they fail** — `npx vitest run tests/unit/edufleet-vacancy-map.test.ts`. Expect "module not found".

- [ ] **Step 3: Implement the module.** `preflight` must check, in this order: `title` non-empty, `description` non-empty, `subject` in `VACANCY_SUBJECTS`, salary ordering when both present, `experienceRequired` non-negative, and — for `AGGREGATED` only — `institutionName` and `city` present. Each returns a sentence a school admin can act on, never an error code. `buildAggregatedJobBody` sends `institutionName`, `city`, optional `district`/`state`; `buildSchoolJobBody` sends none of them. Both filter `facilities` through `VACANCY_BENEFITS`.

- [ ] **Step 4: Run the tests, confirm they pass.**

- [ ] **Step 5: Mutation-check each MUTATION-DISTINGUISHING test.** For the benefits filter, replace the filter with a pass-through and confirm that test alone fails. Restore by checksum.

- [ ] **Step 6: Commit** — `git commit -m "feat(edufleet): map a vacancy to either contract, and refuse locally what eduFleet would reject"`

---

### Task 3: The adapter methods

**Files:**
- Modify: `src/lib/connectors/types.ts`, `src/lib/connectors/edufleet.ts`
- Test: `tests/unit/edufleet-adapter.test.ts`

**Interfaces:**
- Consumes: Task 2's builders.
- Produces, on `PlatformAdapter` (all optional, so PassPercent and FeesBasket are unaffected):
  - `createJob?(ctx, connection, body, contract): Promise<JobPushResult>`
  - `patchJob?(ctx, connection, jobId, body, contract): Promise<JobPushResult>`
  - `closeJob?(ctx, connection, jobId, contract): Promise<JobPushResult>`
  - `type JobPushResult = { kind: "OK"; jobId: string; claimState?: string } | { kind: "BLOCKED"; reason: string; detail: string } | { kind: "CONFLICT"; ownedByContract: string; detail: string }`

- [ ] **Step 1: Write the failing tests.** Cover, each mutation-distinguishing where marked:
  - a 201 returns `kind: "OK"` with the `jobId` from the body;
  - **MUTATION-DISTINGUISHING:** a `403` returns `kind: "BLOCKED"` and **does not throw** — a throw would let the caller latch the vacancy as permanently dead, and two of the four 403 triggers are reversible;
  - **MUTATION-DISTINGUISHING:** a `409` returns `kind: "CONFLICT"` carrying the response's own `contract` field, **not** the contract the caller used — assert with a 409 whose `contract` differs from the caller's, so a mutation that echoes the caller's value fails;
  - a `403 upgrade_required` returns `BLOCKED` with a reason naming the plan cap;
  - a 401 `revoked` throws `ConnectorAuthError` (reuse the existing pattern);
  - **MUTATION-DISTINGUISHING:** `closeJob` on Contract Two sends `status: "closed"` **and nothing else** — assert the body has exactly one key, because eduFleet short-circuits on `status` and silently discards co-sent fields.

- [ ] **Step 2: Run them, confirm they fail.**

- [ ] **Step 3: Implement.** Route Contract One to `/api/partner/jobs` (+ `/{externalJobId}` for PATCH) with `ctx.platformKey`; Contract Two to `/api/partner/school/jobs` (+ `/{id}`) with `connection.grantToken`. Reuse `describeFailure` for every thrown message and `clip` for any interpolated remote value. Never retry inside the adapter.

- [ ] **Step 4: Run the tests, confirm they pass.**

- [ ] **Step 5: Mutation-check all four marked tests, restoring by checksum each time.**

- [ ] **Step 6: Commit.**

---

### Task 4: The publish service

**Files:**
- Create: `src/services/vacancy-publish.service.ts`
- Test: `tests/integration/vacancy-publish-service.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: `VacancyPublishService.publish(institutionId, vacancyId, actor)`, `.repush(...)`, `.pushClose(...)`.

Rules this service owns:

1. **Contract selection.** A `CONNECTED` `PlatformConnection` for `EDUFLEET` with a grant → Contract Two. Otherwise Contract One with the platform key. Recorded on the listing block as `SCHOOL_POSTED` / `AGGREGATED`.
2. **The city gate, at publish.** Refuse with the exact message `"Add a city to the institution profile before publishing to eduFleet Exchange"`. This is *not* the connect-time gate at `connection.service.ts:320` — that one blocks connecting, and a school can publish via Contract One without ever connecting.
3. **Preflight before every push.** Any non-empty `preflight()` result is returned to the caller as a validation error and **no HTTP call is made**. This is the quota shield.
4. **Only `OPEN` vacancies publish.** `DRAFT` refuses; `FILLED`/`CLOSED` push a close instead.
5. **`BLOCKED` is recorded, never latched.** Write `listing.blockedReason` and leave the listing otherwise intact so a later push can succeed.
6. **`CONFLICT` trusts the response's contract.** If eduFleet says the id belongs to the other contract, record it and surface a message naming which; do not retry against the endpoint that just refused.
7. **`ConnectorAuthError` propagates** to the connection service's existing handler.

- [ ] **Step 1: Write the failing tests** — one per rule above, with these mutation-distinguishing: contract selection (a connected institution must use Contract Two — mutate to always-Contract-One and it must fail); the city gate (mutate the gate away, the test must fail while a with-city control stays green); preflight-blocks-the-call (assert the stubbed HTTP was **never called**, so removing the preflight fails it).

- [ ] **Step 2: Run, confirm failure. Step 3: Implement. Step 4: Run, confirm pass. Step 5: Mutation-check. Step 6: Commit.**

---

### Task 5: `remove` must close before it deletes

`VacancyService.remove` is a bare `findOneAndDelete`. Once published, the vacancy `_id` **is** eduFleet's `externalJobId`, so deleting orphans a live, publicly claimable advert with no id left to close it.

**Files:** Modify `src/services/vacancy.service.ts`; test in `tests/integration/vacancy-service.test.ts`.

- [ ] **Step 1: Write the failing test** — a vacancy with a `listing` block, deleted, must have issued a close push first; and **MUTATION-DISTINGUISHING:** a vacancy with **no** listing block must delete without any HTTP call at all.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement.** If `listing` exists, push the close first. **If the close fails, refuse the delete** and surface why — an orphaned public advert is worse than a vacancy that will not delete yet. Offer the school the honest alternative in the message: close the vacancy, then delete.
- [ ] **Step 4-6: Run, mutation-check, commit.**

---

### Task 6: Route and UI

**Files:** Create `src/app/api/settings/vacancies/[id]/publish/route.ts`; modify `src/components/profile/sections/vacancies-section.tsx`. Tests in `tests/integration/vacancy-routes.test.ts`.

- [ ] **Step 1:** Route: `requireInstitution()`-scoped, CSRF-checked, mirroring the existing vacancy routes exactly. Test that another institution's vacancy id 404s — mutation-check the tenant filter.
- [ ] **Step 2:** UI: a **Publish to eduFleet** action on `OPEN` vacancies; a "Published — live on eduFleet" state with the public URL; a claimed vacancy renders **read-only with the reason visible**, never an editable field that meets a 403; `blockedReason` shown verbatim.
- [ ] **Step 3:** Browser-verify with Playwright from the sibling repo — an HTTP-level check passes while the form itself cannot build the payload. Publish one vacancy end to end.
- [ ] **Step 4: Commit.**

---

### Task 7: `sync` becomes a real reconciler

Carries both obligations B1 recorded (plan `2026-08-28-edufleet-connection.md`, Task 4 amendment).

**Files:** Modify `src/lib/connectors/edufleet.ts`, `src/services/connection.service.ts`; tests in both suites.

- [ ] **Step 1:** Replace the `PARTIAL` placeholder. `sync` pushes any published-but-unpushed vacancy, closes any `FILLED`/`CLOSED` one still open on eduFleet, and reports per-vacancy steps. Partial success stays `PARTIAL` with warnings naming each skipped vacancy — never `SUCCESS`.
- [ ] **Step 2: The revocation obligation.** A `401 revoked` during sync must raise `ConnectorAuthError` so the connection flips out of `CONNECTED`. **This is now the only way IDAP discovers a school revoked its grant**, since `refresh` short-circuits for an established connection.
- [ ] **Step 3: The resurrection obligation.** Resolve the `ERROR`-vs-`DISCONNECTED` asymmetry: `syncNow`'s `ConnectorAuthError` path must not leave a known-dead ciphertext that `refresh`'s `completed`-with-grant branch will resurrect to `CONNECTED`. Either drop the ciphertext as `refresh` does, or have the `completed` branch consult the stored status. **Test the full loop**: sync 401 → poll → assert the connection is not `CONNECTED`.
- [ ] **Step 4-6: Run, mutation-check, commit.**

---

### Task 8: Fold the re-verification into the map

**Files:** Modify `docs/integrations/edufleet-api-map.md`.

- [ ] **Step 1:** Apply all 11 STALE findings (S1–S11) from `docs/integrations/edufleet-jobs-reverification.md`, including the corrected citations (S10's +18-line drift, S11's wrong anchors), the 31-district count, the Contract-One-only `state` default, the per-scope `/api/partner/school` response, and the `status`-short-circuit on Contract Two's PATCH.
- [ ] **Step 2:** Correct §7.1 of the **spec** too, or add a dated note there: the claim transition is not a one-way door.
- [ ] **Step 3:** Re-count anything the edit touches from source rather than copying a number from the report.
- [ ] **Step 4: Commit.**

---

## Self-Review

**Spec coverage.** §6 contract split → Tasks 2, 4. §7 lifecycle → Tasks 1, 4, 6. §7.1 claim → Tasks 3, 4, 6 (**overridden**: not a one-way door). §7.2 shared id-space → Task 3's CONFLICT handling. §8 adapter → Task 3, with the spec's "new method, not `SyncSourceData`" honoured. §9 error handling → Task 4. §10 visibility/consent → Task 6. §11 testing → every task.

**Carried obligations.** City gate at publish → Task 4 rule 2. `remove` orphaning → Task 5. `sync` as sole revocation detector → Task 7 step 2. Don't resurrect a dead grant → Task 7 step 3. All four accounted for.

**Type consistency.** `VacancyListingContract` is used identically in Tasks 1, 2, 3 and 4. `JobPushResult`'s three arms are produced only in Task 3 and consumed only in Task 4.

**Known gap, deliberate.** Three claims in the re-verification are UNVERIFIABLE without executing requests. None blocks this plan, but Task 6's browser verification is the first point where real HTTP happens — treat a surprise there as a map defect, not a code defect, and check eduFleet's source before changing IDAP.
