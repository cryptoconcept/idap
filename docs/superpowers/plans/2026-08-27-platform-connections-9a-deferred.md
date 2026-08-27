# Plan 9a — register of consciously deferred items

Every item below was FOUND by a task review, ADJUDICATED by the coordinator, and
deliberately left unfixed with a recorded reason. This file exists so the final
whole-branch reviewer can tell "already decided" from "newly discovered".

**Re-reporting one of these is still useful IF you have evidence the reasoning
was wrong** — a deferral is a judgment call, not a closed door. What is not
useful is re-reporting one with the same reasoning that was already weighed.

| # | Item | Where | Why deferred |
|---|---|---|---|
| D1 | `institutionId` carries both a standalone index and a leading compound index on `PlatformConnection`/`SyncRun` | Task 2 | Copied verbatim from the spec, so plan-mandated rather than an implementer choice. Costs a little write throughput and storage; changes no behaviour. |
| D2 | `SchemaField` is hand-duplicated between `passpercent.ts` and `passpercent-mapping.ts` | Task 6 | Structurally identical today but not tsc-enforced to stay so. Unifying it is a refactor better done when a third consumer appears; nothing in 9a or 9b depends on it. |
| D3 | Credential validation accepts a 1-char key, which a "last 4" mask would fully expose | Task 7 | Not exploitable against real key formats (`pp_pkey_…`, `fbk_live_…` are long with structural prefixes). Worth a min-length bump when that validation is next touched. |
| D4 | `credentialVaultReady()` called twice inside `upsert()` | Task 7 | Cosmetic, no behavioural effect. |
| D5 | DELETE hard-deletes a platform credential rather than soft-deactivating | Task 7 | Matches the brief's signature. Means a removed platform reverts to "never configured" rather than "configured but inactive". **Note: Task 9's fix round F2 now renders the deactivated-credential case correctly**, which was the main UX consequence. |
| D6 | A REJECTED `refresh` leaves stale grant ciphertext in place | Task 8 (M4) | The grant is already dead remotely; the ciphertext is unreadable without the vault key and is overwritten on the next successful redeem. |
| D7 | Plan 9b's FeesBasket fake adapter won't self-heal registration the way PassPercent's does | Task 8 (M6) | Purely a 9b test-ergonomics concern; 9a ships no FeesBasket adapter. |
| D8 | Two coverage-only gaps | Task 8 (M7/M8) | Both behaviours were independently verified correct by the reviewer's own probes; the gap is in committed tests, not in the code. |
| D9 | Array-index `key`s in `RunRow`'s `steps`/`warnings` maps | Task 9 | Lists are rebuilt wholesale and never reordered in place, so the documented React hazard cannot occur here. |
| D10 | `entries` is seeded once from props, so `router.refresh()` is inert for `ConnectionsPanel` | Task 9 | Only manifests when something OTHER than this tab mutates the same connection — a second tab, or a future webhook. Nothing in this plan ships concurrent mutation. The prop-sync fix belongs with whatever first introduces it (9b's webhooks are the likely candidate). |

## NOT deferred — carried as a binding obligation into Plan 9b

**`connectWithKey`'s `updateOne` (connection.service.ts ~line 494) has the same
missing-`upsert:true` bug as Task 8's finding I2.** It is dead code in 9a — no
adapter implements `connectWithKey` — but becomes a live silent-data-loss bug
the moment FeesBasket's adapter ships, which is the first thing Plan 9b does.
This must be fixed as part of 9b's `connectWithKey` wiring. It has already been
deferred once; it does not get deferred again.

## Resolved during the plan, listed so they are not mistaken for open items

- Task 4's untested `adapterFor` unregistered-platform throw → resolved by Task
  8's I3 fix (`resolveAdapter`), tested at all four call sites.
- Task 6's `InstitutionSummary.city` optional-vs-required mismatch → resolved by
  Task 8's city-guard (verified against undefined, null, and whitespace).

---

# Added by the final whole-branch review (2026-08-27)

Eight Minors, all deferred past the merge. None affects correctness of the data
that reaches PassPercent's public listing — that was the bar for entering the
one final fix wave, and all six Importants cleared it while these did not.

| # | Item | Where | Why deferred |
|---|---|---|---|
| D11 | `refresh` has no already-CONNECTED guard | `connection.service.ts:384` | Re-refreshing a connected connection is idempotent in practice; the adapter re-polls and returns the same state. Costs one wasted round-trip, corrupts nothing. |
| D12 | A corrupt grant ciphertext is recorded nowhere | `connection.service.ts:592` | Surfaces as a 502 with the detail in the run, so it is diagnosable — just not persisted on the connection row. Same shape as Task 8's I2 but without the silent-loss consequence. |
| D13 | Vault-key rotation surfaces as a message-scrubbed 500 | `connection.service.ts:310` | Real, but the trigger is an operator rotating `IDAP_CREDENTIAL_KEY` without re-encrypting — a deployment event, not a user path. Deserves a dedicated "credentials unreadable" state, which is more design than a fix wave should absorb. |
| D14 | Two platform validators disagree: 404 vs 400 for an unknown platform | `admin/platform-credentials/[platform]/route.ts:11` | Both refuse correctly; only the status differs between the admin and settings surfaces. Cosmetic inconsistency, no security or data consequence. |
| D15 | A rejection carrying no reason leaves a stale `lastError` | `connection.service.ts:430` | Same class as Task 9's F5, which was fixed for `disconnect`. Worth folding in when this method is next touched. |
| D16 | `ConnectionState.scopes` is never read by the adapter | `types.ts` | Dead-ish today: scopes are stored and displayed in the UI but the adapter does not gate on them. Becomes load-bearing when FeesBasket's scope-gated sections land in 9b — fix it there, with a real consumer. |
| D17 | Duplicated guard helpers across service/route layers | several | Structurally identical, small, and each is individually tested. Converging them is a refactor wanting a third caller to justify its shape. |
| D18 | `ResultService.serialize`'s `?? 0` on `appeared`/`passed` | `result.service.ts:116-117` | **See Ruling 25 — deliberately NOT fixed.** Those two fields are `required: true` at `Result.ts:138-139`, so the coalesce guards a case the schema forbids, and they are the only two `?? 0` sites in `serialize`; every genuinely-nullable nested bound passes through uncoerced. Changing it would widen `ResultDTO.appeared` to `number \| null` across every consumer for an unreachable case. **If a future migration ever relaxes that `required: true`, this silently starts publishing fabricated zeros to a public listing** — whoever touches that schema must revisit this line. |
