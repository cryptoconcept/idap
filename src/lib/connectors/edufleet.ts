/**
 * eduFleet Exchange adapter — the connection lifecycle, the job wire, and the
 * reconciler that keeps the two honest.
 *
 * Task 1 registers the platform and implements `initiate`, the first step of
 * the four-step consent chain documented in
 * `docs/integrations/edufleet-api-map.md` §1.2. Task 2 extends this module
 * with `refresh` (steps 2-4, mirroring the poll-then-redeem shape
 * `passpercent.ts` already implements for the same `REQUEST_APPROVE_REDEEM`
 * mode).
 *
 * Plan B2's Task 7 replaces what used to be a placeholder `sync` with a real
 * reconciler, and gives this module its second job: bringing eduFleet back
 * into step with IDAP for vacancies the school ALREADY published, and — the
 * obligation B1 recorded in writing — being the one place a revoked grant is
 * ever discovered.
 *
 * `SyncStatus` still has exactly three legal values (`constants.ts`), and the
 * honesty rule that governed the placeholder governs the reconciler too:
 * `SUCCESS` may never be reported over a push that did not happen, so a run
 * that skipped anything is `PARTIAL` with a warning naming each vacancy it
 * skipped.
 *
 * Like `passpercent.ts`, every function here relies on `ConnectorHttp`
 * resolving `{status, body}` on a non-2xx response rather than throwing — see
 * `./http`'s docblock. It throws only on a network failure or a timeout.
 */

import { ConnectorAuthError, ConnectorRejectedError } from "./types";
import type {
  AdapterContext,
  ConnectionState,
  InitiateResult,
  InstitutionSummary,
  JobPushResult,
  PlatformAdapter,
  RefreshResult,
  SyncOutcome,
  SyncSourceData,
  SyncStep,
  SyncVacancy,
  VacancyActionResult,
} from "./types";
import type { VacancyListingContract } from "@/lib/constants";
import { registerAdapter } from "./index";

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function stringArray(v: unknown): string[] {
  return (arr(v) ?? []).filter((x): x is string => typeof x === "string");
}

/**
 * The operator-facing tail of an adapter error. eduFleet's error bodies carry
 * a machine `reason` and a `details[]` of `{field, message}` (api-map §5); a
 * bare status code cost the live verification an hour of guessing why a 400
 * was a 400, and it reaches the user as `lastError` on the connection card.
 *
 * Reads only those two named fields and never stringifies the whole body.
 * That is deliberate, not stylistic: this string is persisted and displayed,
 * and a response body is remote-controlled — naming the fields bounds what can
 * escape into it. The length cap bounds the rest (an HTML error page has no
 * `reason`, but a hostile JSON one could carry a very long string).
 */
function describeFailure(resp: { status: number; body: unknown }): string {
  const body = rec(resp.body);
  const parts = [`status ${resp.status}`];
  const reason = str(body?.reason);
  if (reason) parts.push(reason);
  const firstDetail = str(rec((arr(body?.details) ?? [])[0])?.message);
  if (firstDetail) parts.push(firstDetail);
  return parts.join(" — ").slice(0, 200);
}

/**
 * Bounds one remote-derived value spliced into an error message, applying the
 * same policy `describeFailure` above states, at the sites that interpolate a
 * remote value directly instead of going through it. Same reason: these
 * messages become `lastError`, which is persisted with no `maxlength`
 * (`PlatformConnection.ts:26`) and returned to the browser.
 *
 * Be honest about what this buys: against a well-behaved eduFleet every value
 * it wraps is schema-constrained (`externalRef` and `remoteRequestId` are ids,
 * `status` is an enum), so this is defence-in-depth consistency rather than a
 * live hole. It exists because the file states a rule and two throw sites
 * broke it, and the next person will copy whichever neighbour they land on.
 */
function clip(v: string): string {
  return v.slice(0, 80);
}

/**
 * Shared "the state moved under us" detail (api-map §5: 409
 * `already_redeemed`, 409 `not_approved`, and reaching `"completed"` via
 * polling are all the same class). eduFleet's grant is returned exactly
 * once at redeem time — if IDAP didn't win that exchange, no token is
 * recoverable here, only a fresh connection request.
 */
const REDEEM_STATE_MOVED_DETAIL = "already redeemed (or no longer approved) — reconnect from eduFleet if needed";

// ---------------------------------------------------------------------------
// initiate — POST /api/partner/connection-requests (platform key)
// ---------------------------------------------------------------------------

/**
 * The capabilities IDAP asks each school to consent to. `jobs:write` is the
 * scope eduFleet's Contract Two job endpoints require, and it is what Plan B2
 * pushes vacancies with; `listings:write` belongs to eduFleet's vehicle API,
 * which IDAP has no surface for. eduFleet enforces this twice — the array must
 * be non-empty, and every entry must appear in the partner's `allowedScopes`,
 * which an eduFleet admin sets at partner registration (default `["jobs:write"]`).
 * A partner registered without it is refused even with a well-formed body.
 */
const REQUESTED_SCOPES = ["jobs:write"] as const;

function buildConnectionRequestBody(institution: InstitutionSummary): Rec {
  // api-map §1.2 step 1, contract 1.1.0: `externalRef` (IDAP's own
  // institutionId), `payload.institutionName`, and a non-empty `scopes`.
  // The platform key never belongs here — it is `ctx.platformKey`, carried
  // solely in the Authorization header by `createConnectorHttp`.
  // `scopes` is a fresh copy per call: the returned object is handed to the
  // HTTP layer, and a shared array constant could be mutated by a caller.
  //
  // Everything after `institutionName` is optional to eduFleet
  // (`ConnectionPayload`, `partner-connections.ts:20-31`) and load-bearing to
  // a human: step 2 of the chain is an eduFleet **admin** hand-matching this
  // request to a real school, and a request carrying nothing but a name is
  // what produces a wrong match — which is in turn the precondition for the
  // auto-remap clash `initiate` refuses below, and for handing a school's
  // grant to an institution that school never consented to. The service
  // already refuses to initiate without a city; sending it is the whole point
  // of collecting it.
  //
  // `board` and `type` are also accepted by eduFleet but have no source on
  // `InstitutionSummary`, so they are omitted rather than invented.
  const optional: Record<string, string | undefined> = {
    city: institution.city,
    district: institution.address?.district,
    state: institution.address?.state,
    phone: institution.phone,
    email: institution.contactEmail,
    website: institution.website,
    contactName: institution.contactName,
  };

  // Absent keys are dropped rather than sent as an explicit `undefined`: the
  // payload is persisted on eduFleet's request document and shown to the
  // matching admin, and an empty field is noise there.
  const payload: Rec = { institutionName: institution.name };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) payload[key] = value;
  }

  return {
    externalRef: institution.institutionId,
    payload,
    scopes: [...REQUESTED_SCOPES],
  };
}

/** eduFleet's opening states, mapped to IDAP's. Anything else defaults to PENDING. */
function initiateKind(remoteStatus: string): "PENDING" | "AWAITING_APPROVAL" {
  return remoteStatus === "awaiting_school" ? "AWAITING_APPROVAL" : "PENDING";
}

async function initiate(ctx: AdapterContext, institution: InstitutionSummary): Promise<InitiateResult> {
  const resp = await ctx.http("/api/partner/connection-requests", {
    method: "POST",
    token: ctx.platformKey,
    body: buildConnectionRequestBody(institution),
  });

  if (resp.status === 201) {
    const body = rec(resp.body) ?? {};
    // The same presence check the 409 branch below makes, on the primary
    // path, for the same reason: `String(undefined)` persists the literal
    // "undefined" as `remoteRequestId`, and every later poll then requests
    // `/api/partner/connection-requests/undefined` → 404 → a generic 502 with
    // the real cause invisible.
    if (body.requestId === undefined || body.requestId === null) {
      throw new Error("eduFleet: the connection request was created but the 201 response carried no requestId");
    }
    const remoteStatus = str(body.status) ?? "pending";
    return { remoteRequestId: String(body.requestId), remoteStatus, kind: initiateKind(remoteStatus) };
  }

  if (resp.status === 409) {
    const body = rec(resp.body) ?? {};
    // Two different collisions share the reason `duplicate_open_request`
    // (api-map §1.2), and only one of them is safe to adopt:
    //
    //   Path A — the same-`externalRef` race. Message: `A request for
    //   externalRef "X" is already open`. The `requestId` that comes back is
    //   this institution's own earlier request, so adopting it is right: the
    //   request IDAP wanted is already in flight.
    //
    //   Path B — the auto-remap clash. Message: the fixed literal "Another
    //   open request already targets this school". eduFleet looked up
    //   `{partnerId, schoolId, open: true}`, so the request it hands back is
    //   scoped to the *school* and may have been opened under a different
    //   `externalRef` entirely — i.e. it can belong to another institution.
    //
    // Path B is refused below. The 409 body carries no `externalRef`
    // (`ConnectionError`, eduFleet `partner-connections.ts:13-18`), so the
    // only authoritative check is the `externalRef` comparison in `refresh`,
    // at the first poll that can see one — that is where the security
    // boundary lives, not here.
    //
    // The body also carries no `status`: it is exactly
    // `{error, reason, requestId?}` (`route.ts:30` + `jsonError`,
    // `partner-auth.ts:26-28`). An adopted request's real state is therefore
    // unknowable from the 409 and only a poll can supply it, so the adopt
    // below falls through to `"pending"` every time.
    //
    // The `requestId` presence check is not decoration: a malformed 409 with
    // no `requestId` must throw rather than let `undefined` become a
    // connection pointing at nothing.

    // eduFleet's auto-remap clash (api-map §1.2): the request it points at is
    // scoped to the *school*, not to this externalRef, so adopting it would
    // attach this institution to another institution's request. Refuse at the
    // door with something an operator can act on, rather than adopting and
    // stranding the row at PENDING — `showRequest` excludes PENDING, so a
    // stranded row's only move is Cancel-then-Request, straight back into the
    // same clash.
    //
    // This match is best-effort early detection, NOT the security boundary:
    // it reads a human-readable string eduFleet may reword at any time. The
    // authoritative check is the `externalRef` comparison in `refresh`, which
    // runs against a machine-readable field and catches this even if the
    // wording changes.
    if (str(body.error)?.includes("already targets this school")) {
      throw new Error(
        "eduFleet: another institution already has an open connection request for this school — an eduFleet admin must resolve the duplicate before this school can be connected",
      );
    }

    if (body.requestId !== undefined && body.requestId !== null) {
      const remoteStatus = str(body.status) ?? "pending";
      return { remoteRequestId: String(body.requestId), remoteStatus, kind: initiateKind(remoteStatus) };
    }
  }

  throw new Error(`eduFleet: submitting the connection request failed (${describeFailure(resp)})`);
}

// ---------------------------------------------------------------------------
// refresh — GET .../connection-requests/:id, then redeem on "approved"
// (both platform key); the redeem response's follow-up school lookup uses
// the freshly minted grant.
// ---------------------------------------------------------------------------

async function pollConnectionRequest(ctx: AdapterContext, remoteRequestId: string): Promise<Rec> {
  // `remoteRequestId` originated in a remote response. `joinUrl`
  // (`http.ts:55-59`) only concatenates onto the configured base, so a hostile
  // value cannot leave eduFleet's origin — but it could still steer the
  // platform key at a different eduFleet path. Encode it.
  const resp = await ctx.http(`/api/partner/connection-requests/${encodeURIComponent(remoteRequestId)}`, {
    method: "GET",
    token: ctx.platformKey,
  });
  if (resp.status !== 200) {
    throw new Error(`eduFleet: polling the connection request failed (${describeFailure(resp)})`);
  }
  return rec(resp.body) ?? {};
}

/**
 * The one grant-authenticated READ IDAP makes of eduFleet, and the single
 * place the "is this grant still alive?" policy lives. Two callers with two
 * different jobs share it (`fetchRemoteInstitution` for display,
 * `probeGrant` for the reconciler), which is why the policy is here and the
 * interpretation is theirs.
 *
 * `GET /api/partner/school` is deliberate rather than incidental: it is
 * authenticated by `requireGrant` (eduFleet `partner-auth.ts:113`) and it
 * calls **no** `spendWrite` — the only twelve call sites are the four job
 * routes, the four listings routes and the connection-request POST, all
 * verified in eduFleet's source. So this costs nothing from the school's
 * 100/day write budget however often a sync runs.
 *
 * Never throws for a transport failure: a network error or a timeout yields
 * `undefined`, which every caller must treat as "could not ask", never as
 * "the grant is dead".
 *
 * The ONE authoritative signal is a 401 whose body reason is exactly
 * `revoked` (api-map §1.3) — the school withdrew consent — and that raises
 * `ConnectorAuthError` from here so no caller can accidentally swallow it.
 * `revoked` is matched exactly, not by substring: `partner_revoked` is a
 * different fact (the partner registration was pulled, nothing a school can
 * act on) that happens to contain the word.
 *
 * **That split is not exhaustive, and the remainder is a known gap.** This
 * call can be answered 401 with five distinct bodies — `requireGrant`
 * (eduFleet `partner-auth.ts:116-123`) plus `partnerState` (`:88-89`) — and
 * only three carry a `reason` at all: `revoked`, `partner_revoked` and
 * `partner_inactive`. The other two carry none, and between them cover four
 * of the seven throw sites: a bad prefix, a hash miss and an orphaned partner
 * all answer the same bare `{"error":"Invalid grant token"}`, and a missing
 * token answers `{"error":"Missing grant token", hint}`.
 *
 * Widening the check is still not the fix: treating "401 for an unstated
 * reason" as proof the school withdrew consent is a stronger claim than this
 * call can support, and it would let a transient eduFleet fault tear down a
 * good connection. What has changed is that the unstated 401s are no longer
 * invisible — `probeGrant` reports the status it got as a failed step and the
 * run comes back `PARTIAL`, so a connection holding a token eduFleet will not
 * honour now says so on every sync instead of reading as healthy.
 */
async function readSchool(
  ctx: AdapterContext,
  grantToken: string,
): Promise<{ status: number; body: unknown } | undefined> {
  let resp: { status: number; body: unknown };
  try {
    resp = await ctx.http("/api/partner/school", { method: "GET", token: grantToken });
  } catch {
    return undefined;
  }

  if (resp.status === 401 && str(rec(resp.body)?.reason) === "revoked") {
    throw new ConnectorAuthError("eduFleet: this connection's grant has been revoked by the school");
  }

  return resp;
}

/**
 * The redeem response (api-map §1.2 step 4) carries no school name, city,
 * or slug — just ids. This is a second call, using the grant token that was
 * just minted, purely to populate `RefreshResult.remoteInstitution` for
 * display.
 *
 * This call must never be able to cost the grant: a network throw, a
 * timeout, or any ordinary non-2xx status is swallowed and simply yields no
 * `remoteInstitution` — a `CONNECTED` result with an unnamed school is still
 * a working connection. The one deliberate exception is the `401 revoked`
 * `readSchool` raises, which means the credential IDAP just received is
 * already dead and is worth surfacing rather than quietly handing back a
 * token that will never work.
 */
async function fetchRemoteInstitution(
  ctx: AdapterContext,
  grantToken: string,
): Promise<{ name?: string; city?: string; slug?: string } | undefined> {
  const resp = await readSchool(ctx, grantToken);
  if (resp?.status !== 200) return undefined;

  const school = rec(resp.body);
  if (!school) return undefined;
  // eduFleet's School model has no slug field at all — `slug` stays
  // undefined always; never derive one from the name.
  return { name: str(school.schoolName), city: str(school.city) };
}

async function redeem(ctx: AdapterContext, remoteRequestId: string): Promise<RefreshResult> {
  // Encoded for the same reason as the poll above.
  const resp = await ctx.http(`/api/partner/connection-requests/${encodeURIComponent(remoteRequestId)}/redeem`, {
    method: "POST",
    token: ctx.platformKey,
  });

  if (resp.status === 200) {
    const body = rec(resp.body) ?? {};
    const grantToken = str(body.token);
    if (!grantToken) {
      throw new Error("eduFleet: redeem succeeded but the response carried no grant token");
    }
    // Never log `grantToken`, never fold it into an error message, never
    // return it anywhere but this `RefreshResult` — it is returned exactly
    // once and is gone for good if lost.
    const remoteInstitution = await fetchRemoteInstitution(ctx, grantToken);
    return {
      kind: "CONNECTED",
      remoteStatus: "completed",
      grantToken,
      scopes: stringArray(body.scopes),
      remoteInstitution,
    };
  }

  if (resp.status === 409) {
    // api-map §5: 409 `already_redeemed` (someone else won the race) and
    // 409 `not_approved` (the request slipped out of "approved" before this
    // redeem landed) are both "the state moved under us" — same defensive
    // shape as the "completed" branch in `refresh` below, and PassPercent's
    // identical redeem race.
    return { kind: "REJECTED", remoteStatus: "rejected", detail: REDEEM_STATE_MOVED_DETAIL };
  }

  throw new Error(`eduFleet: redeeming the connection request failed (${describeFailure(resp)})`);
}

async function refresh(ctx: AdapterContext, connection: ConnectionState): Promise<RefreshResult> {
  if (!connection.remoteRequestId) {
    throw new Error("eduFleet: refresh requires a remoteRequestId, but the connection has none");
  }

  const body = await pollConnectionRequest(ctx, connection.remoteRequestId);
  const remoteStatus = str(body.status) ?? "";

  // A 409 `duplicate_open_request` can hand back the id of a request opened
  // under a *different* `externalRef` — eduFleet's auto-remap clash branch
  // returns whichever open request already targets the same school, not
  // necessarily this institution's own. `initiate` cannot tell the two 409
  // shapes apart (the body carries no `externalRef`), so the check lands here,
  // at the first poll that can see one. Acting on someone else's request would
  // redeem a grant for a school that never consented to *this* institution —
  // the exact boundary the four-step chain exists to hold. Absent field: skip,
  // rather than break a working connection over a field eduFleet stopped
  // sending.
  const polledRef = str(body.externalRef);
  if (polledRef !== undefined && polledRef !== connection.externalRef) {
    throw new Error(
      `eduFleet: connection request ${clip(connection.remoteRequestId)} belongs to externalRef "${clip(polledRef)}", not "${connection.externalRef}" — refusing to act on it`,
    );
  }

  switch (remoteStatus) {
    case "pending":
      return { kind: "PENDING", remoteStatus };
    case "awaiting_school":
      return { kind: "AWAITING_APPROVAL", remoteStatus };
    case "rejected":
      return { kind: "REJECTED", remoteStatus, detail: str(body.rejectReason) };
    case "approved":
      return redeem(ctx, connection.remoteRequestId);
    case "completed":
      // Two very different situations reach "completed", and the grant IDAP
      // already holds separates them. If there is one, this connection is the
      // one that redeemed this request — eduFleet keeps the row queryable
      // forever afterwards, so an ordinary poll of a healthy connection lands
      // here, and reporting REJECTED would destroy a working connection.
      // If there is none, the original meaning stands: something else redeemed
      // it between polls, and eduFleet returns a grant exactly once, so there
      // is nothing to recover.
      if (connection.grantToken) {
        return {
          kind: "CONNECTED",
          remoteStatus,
          grantToken: connection.grantToken,
          scopes: connection.scopes ?? [],
          // No `remoteInstitution`: re-fetching it would spend a live grant
          // call on a poll, and the service leaves the stored value alone
          // when the field is absent.
          //
          // The cost of that short-circuit is large enough to write down.
          // Returning here means **`refresh` never makes a grant-authenticated
          // call for an established connection**: it stops short of
          // `fetchRemoteInstitution`, so its own `ConnectorAuthError` branch
          // only ever fires in the narrow mid-redeem window. On its own that
          // left a school able to revoke its grant while IDAP kept showing
          // Connected indefinitely.
          //
          // `sync` below is what closes that, and it is now the ONLY thing
          // that does: `probeGrant` exercises the stored grant on every run,
          // which makes `sync` the sole revocation detector. See the Task 4
          // amendment in
          // `docs/superpowers/plans/2026-08-28-edufleet-connection.md`.
        };
      }
      return { kind: "REJECTED", remoteStatus, detail: REDEEM_STATE_MOVED_DETAIL };
    default:
      throw new Error(`eduFleet: connection request has an unrecognized status "${clip(remoteStatus)}"`);
  }
}

// ---------------------------------------------------------------------------
// sync — the reconciler
// ---------------------------------------------------------------------------

/**
 * Step 1 of every run, and the reason `sync` exists at all beyond the push.
 *
 * **This is the only way IDAP ever discovers a school revoked its grant.**
 * `refresh` short-circuits the moment a connection is established (see its
 * `"completed"` branch), and nothing else in IDAP makes a grant-authenticated
 * call for one — so without this a school can withdraw consent on eduFleet and
 * the connection card keeps saying "Connected", against a credential that will
 * refuse every request, forever. Recorded as a binding obligation in the Task 4
 * amendment of `docs/superpowers/plans/2026-08-28-edufleet-connection.md`.
 *
 * It runs FIRST, before any vacancy is touched, and it is a READ. Both matter:
 *
 * - A read costs no write unit (`GET /api/partner/school` calls no
 *   `spendWrite`; see `readSchool`), so revocation detection is free however
 *   often a school syncs.
 * - Running before the sweep means a dead grant stops the run before a single
 *   Contract Two push spends anything on a foregone 401 — and `spendWrite`
 *   runs BEFORE eduFleet validates, so those would have cost real units.
 *
 * It cannot cover the whole surface, and the boundary is worth stating: it
 * proves the SCHOOL'S GRANT is alive. A vacancy pinned to Contract One is
 * pushed under the platform key, which this never exercises. A connection is
 * still the right place to detect this, because the grant is the credential a
 * school controls and can withdraw; the platform key is IDAP's own and its
 * failure is an operator problem, not a per-school one.
 *
 * Returns whether the grant was PROVEN live. `false` is not an accusation —
 * it covers "no grant on the row at all" and "eduFleet did not answer 200 for
 * a reason it did not state" — but it does mean this run could not verify the
 * connection, which is a `PARTIAL`, never a `SUCCESS`.
 */
async function probeGrant(
  ctx: AdapterContext,
  connection: ConnectionState,
  steps: SyncStep[],
  warnings: string[],
): Promise<boolean> {
  const grantToken = connection.grantToken;
  if (!grantToken) {
    // A CONNECTED eduFleet row always carries one, so this is an anomaly
    // rather than a normal state — and an anomaly that silently disables the
    // only revocation detector there is, which is exactly the kind of thing
    // that must not read as a clean run.
    steps.push({ step: "grant", ok: false, detail: "this connection holds no grant token to verify" });
    warnings.push(
      "eduFleet: this connection is marked connected but holds no grant token, so IDAP could not verify it is still live — reconnect to eduFleet.",
    );
    return false;
  }

  // `readSchool` raises `ConnectorAuthError` on the one authoritative signal
  // (401 `revoked`) and it is deliberately NOT caught here: the connection
  // service's own `ConnectorAuthError` branch is what flips the row out of
  // CONNECTED and drops the dead ciphertext, and swallowing it would leave
  // IDAP holding a credential it already knows is dead. `steps`/`warnings`
  // are empty at this point, so nothing is lost by letting it fly as-is.
  const resp = await readSchool(ctx, grantToken);

  if (resp === undefined) {
    steps.push({ step: "grant", ok: false, detail: "eduFleet could not be reached to verify the grant" });
    warnings.push("eduFleet: could not be reached to check whether this connection is still live.");
    return false;
  }

  if (resp.status !== 200) {
    // Includes the four 401s that carry no `reason` (see `readSchool`). Not
    // treated as revocation — that claim needs eduFleet to make it — but no
    // longer invisible either.
    steps.push({ step: "grant", ok: false, detail: describeFailure(resp) });
    warnings.push(
      `eduFleet: IDAP could not confirm this connection is still live (${describeFailure(resp)}) — if pushes keep failing, reconnect to eduFleet.`,
    );
    return false;
  }

  steps.push({ step: "grant", ok: true });
  return true;
}

/**
 * What one vacancy needs from a reconciliation, decided locally and before
 * anything is sent. Every branch that answers `"NONE"` is a write unit not
 * spent — and on a sweep, that is the whole ball game: `spendWrite` runs
 * BEFORE eduFleet validates, so a reconciler that pushes speculatively burns
 * the school's 100/day budget discovering things IDAP already knew.
 *
 * - **No listing → `NONE`.** The school never published this vacancy, and a
 *   sync must never be what first puts one on a public jobs board. Spec §7
 *   ("Publish is explicit — a school action on an `OPEN` vacancy, never
 *   automatic on save") and §10 ("a vacancy is only ever pushed by an
 *   explicit school action") both say so, and the publish dialog is IDAP's
 *   consent surface for it. This is not work being skipped; there is no work.
 * - **Listing already closed → `NONE`.** Nothing is live over there to
 *   reconcile, and eduFleet cannot reopen an advert on either contract
 *   (Contract Two's PATCH accepts only `"closed"`), so the only route back is
 *   a NEW listing — a create, i.e. the explicit action above.
 * - **`FILLED`/`CLOSED` with a live listing → `CLOSE`.** The vacancy is no
 *   longer hiring and the public advert should come down. This is the half of
 *   reconciliation that nothing else in IDAP performs on its own.
 * - **`OPEN` with a live listing → `REPUSH` only if `blockedReason` is set.**
 *   That field is precisely "why this listing is currently out of step with
 *   IDAP" (`vacancy-publish.service.ts`), written by a `403`, a `409` or a
 *   failed edit-push, and cleared by the next push that lands. It is the only
 *   local evidence that a published vacancy's current values have NOT reached
 *   eduFleet. Without it, "reconcile every live listing" would PATCH every
 *   advert on every sync — one write unit each, for no change — which is the
 *   single most expensive mistake available here. And two of eduFleet's four
 *   `403` triggers (`claim_pending`, `hiddenPendingReview`) reverse on their
 *   own, which is exactly why `JobPushResult` refuses to latch a vacancy as
 *   dead: something has to retry later, and this is that something.
 * - **`DRAFT` with a live listing → `DRAFT_LIVE`.** Real drift, deliberately
 *   left for the school: the spec never pushes a `DRAFT` (§4), and closing an
 *   advert that cannot be reopened, over nothing more than a status toggle, is
 *   not a decision a background sweep should make. Named in a warning instead,
 *   which points at the per-vacancy Close control — a control that, since fix
 *   round 1, actually works for a draft holding a live advert.
 */
type VacancyPlan = "NONE" | "CLOSE" | "REPUSH" | "DRAFT_LIVE";

function planFor(vacancy: SyncVacancy): VacancyPlan {
  const listing = vacancy.listing;
  if (!listing || listing.remoteStatus === "closed") return "NONE";

  switch (vacancy.status) {
    case "FILLED":
    case "CLOSED":
      return "CLOSE";
    case "OPEN":
      return listing.blockedReason ? "REPUSH" : "NONE";
    default:
      return "DRAFT_LIVE";
  }
}

/** How a vacancy is named in a warning: what the school called it, and the id
 *  that identifies it. `clip` because a title is user-entered and the string
 *  is persisted on the run. */
function nameOf(vacancy: SyncVacancy): string {
  return `"${clip(vacancy.title)}" (${clip(vacancy.vacancyId)})`;
}

/**
 * Bring eduFleet back into step with IDAP for the vacancies this school has
 * already published, and — before anything else — prove the grant is still
 * alive.
 *
 * What this does NOT do is as deliberate as what it does. It builds no body,
 * makes no job call, and writes no listing state: every push goes through the
 * closures on `SyncVacancy`, which are `vacancy-publish.service.ts`'s own
 * `repush`/`pushClose`. That service already owns contract selection,
 * preflight, the wire call and the write-back, and it is the only thing
 * allowed to touch models. This function's entire job is deciding WHICH
 * vacancies need WHAT — and, on a sweep, deciding that as cheaply as possible.
 *
 * Ordering is not incidental: the grant probe first (a free read that stops a
 * dead-credential run before it spends anything), then closes and repushes in
 * the order the service handed them over. A `RUN`-scoped failure — eduFleet
 * unreachable, or the daily write cap spent, which arrives as an unclassified
 * `429` — abandons the rest of the sweep rather than rediscovering the same
 * fact once per vacancy.
 *
 * The status is the honesty rule, verbatim: anything skipped or failed makes
 * the run `PARTIAL` with a warning naming that vacancy; `SUCCESS` is reserved
 * for a run where the grant verified and every vacancy that needed work got
 * it. A push that did not happen is never reported as one.
 */
async function sync(
  ctx: AdapterContext,
  connection: ConnectionState,
  data: SyncSourceData,
): Promise<SyncOutcome> {
  const steps: SyncStep[] = [];
  const warnings: string[] = [];

  const grantOk = await probeGrant(ctx, connection, steps, warnings);

  const vacancies = data.vacancies;
  if (vacancies === undefined) {
    // The service did not supply a worklist. Nothing was pushed, so this can
    // never be SUCCESS — the same reasoning the placeholder this replaced was
    // written under.
    steps.push({ step: "vacancies", ok: false, detail: "no vacancy worklist was supplied to this sync" });
    warnings.push(
      "eduFleet: vacancies were not reconciled — this sync ran without a vacancy worklist, so nothing was pushed.",
    );
    return { status: "PARTIAL", steps, warnings };
  }

  let skipped = false;
  let acted = 0;

  for (const vacancy of vacancies) {
    const plan = planFor(vacancy);
    if (plan === "NONE") continue;

    if (plan === "DRAFT_LIVE") {
      skipped = true;
      warnings.push(
        `eduFleet: ${nameOf(vacancy)} is back in draft, but its advert is still live on eduFleet. A sync will not take down an advert over a draft toggle — use Close on eduFleet on the vacancy itself, or set it back to Open to keep the advert.`,
      );
      continue;
    }

    // A claimed listing has moved onto the school's OWN eduFleet account:
    // IDAP's platform key is refused on it with `403 claimed`, one of the two
    // TERMINAL triggers, so this is not a state that heals. Pushing anyway
    // would spend a write unit per vacancy per sync to be told something
    // already known. `vacancy.service.ts`'s `remove` makes the same call for
    // the same reason.
    if (vacancy.listing?.claimState === "claimed") {
      skipped = true;
      warnings.push(
        `eduFleet: ${nameOf(vacancy)} has been claimed on eduFleet, so IDAP can no longer change or close its advert — manage it from your eduFleet account.`,
      );
      continue;
    }

    const step = `${plan === "CLOSE" ? "close" : "repush"}:${clip(vacancy.vacancyId)}`;

    let result: VacancyActionResult;
    try {
      result = plan === "CLOSE" ? await vacancy.close() : await vacancy.repush();
    } catch (error) {
      if (error instanceof ConnectorAuthError) {
        // The grant died partway through the sweep (the probe passed, the
        // school revoked while the run was in flight). Same rule as
        // PassPercent's mid-run 401: the error carries everything already
        // accumulated, so the record of which adverts had already gone up or
        // come down before the credential died is not thrown away.
        steps.push({ step, ok: false, detail: error.message });
        throw new ConnectorAuthError(error.message, steps, warnings);
      }
      throw error;
    }

    if (result.ok) {
      acted += 1;
      steps.push({ step, ok: true, detail: clip(vacancy.title) });
      continue;
    }

    steps.push({ step, ok: false, detail: result.detail });

    if (result.scope === "RUN") {
      warnings.push(
        `eduFleet: the sync stopped at ${nameOf(vacancy)} — ${result.detail} Any vacancies after it were left untouched.`,
      );
      return { status: "FAILED", steps, warnings, error: result.detail };
    }

    skipped = true;
    warnings.push(`eduFleet: ${nameOf(vacancy)} was not reconciled — ${result.detail}`);
  }

  if (acted === 0 && !skipped) {
    // Said explicitly rather than left as an empty step list: "eduFleet is
    // already in step with IDAP" and "the sync did nothing" look identical on
    // a run with no steps, and only one of them is good news.
    steps.push({ step: "vacancies", ok: true, detail: "every published vacancy is already in step with eduFleet" });
  }

  return { status: grantOk && !skipped ? "SUCCESS" : "PARTIAL", steps, warnings };
}

// ---------------------------------------------------------------------------
// createJob / patchJob / closeJob — the wire layer for Task 2's builders
// (`edufleet-vacancy-map.ts`). This plan's B2 vacancy push: these methods
// send an already-built, already-preflighted body and classify the answer —
// they never build or validate a body themselves, and they never retry.
// `spendWrite` (api-map §1.4) runs BEFORE eduFleet validates anything, so a
// `400` or a `409` has already burned one of the day's write units by the
// time it reaches `classifyJobPush` below; retrying either from inside this
// module would be how a school's whole daily budget disappears in one bad
// push. There is exactly one `ctx.http` call per method for that reason.
// ---------------------------------------------------------------------------

/** Contract One (platform key) uses `externalJobId` to address a job on the
 *  PATCH route; Contract Two (grant) uses eduFleet's own Mongo `_id`. Both
 *  are opaque strings from this module's point of view — the caller is
 *  responsible for passing the shape the contract expects. */
function jobsPath(contract: VacancyListingContract): string {
  return contract === "SCHOOL_POSTED" ? "/api/partner/school/jobs" : "/api/partner/jobs";
}

/**
 * Which of the two credentials a push uses, and — inseparably — which one it
 * therefore just proved something about.
 *
 * Contract One is authenticated with the platform key (`ctx.platformKey`);
 * Contract Two is authenticated with the school's own grant
 * (`connection.grantToken`) — there is no fallback between the two, because
 * a platform key cannot post as a specific school and a grant is scoped to
 * exactly one. A `SCHOOL_POSTED` call with no grant on the connection is a
 * caller bug (this plan's orchestration never reaches here without one), so
 * it throws immediately rather than sending a request with no credential.
 *
 * **`kind` travels with the token on purpose, rather than being re-derived
 * from the contract at the point of classification.** eduFleet answers a
 * revoked platform key and a revoked school grant with the byte-identical
 * body `{"error": …, "reason": "revoked"}` (`partner-auth.ts:100` for
 * `PartnerKey.revokedAt`, `:121` for `PartnerGrant.revokedAt`), so the
 * response cannot tell the two apart and the ONLY thing that can is which
 * credential IDAP chose to send. Deciding that here, once, and handing the
 * answer to `classifyJobPush` is what stops the two from ever drifting apart:
 * a future contract, or a change to which token a contract uses, updates both
 * halves in one place or not at all.
 */
type PushCredential = { token: string; kind: "GRANT" | "PLATFORM_KEY" };

function credentialFor(
  ctx: AdapterContext,
  connection: ConnectionState,
  contract: VacancyListingContract,
): PushCredential {
  if (contract === "SCHOOL_POSTED") {
    if (!connection.grantToken) {
      throw new Error("eduFleet: pushing to Contract Two requires a grant token, but this connection has none");
    }
    return { token: connection.grantToken, kind: "GRANT" };
  }
  return { token: ctx.platformKey, kind: "PLATFORM_KEY" };
}

/**
 * Shared classification for all three job-push methods below. Every branch
 * here mirrors api-map §5's error catalog for the four job routes.
 *
 * `403` never throws: `claim_pending` and `hiddenPendingReview` (Contract
 * One's PATCH, api-map §2.2) both revert on their own — a rejected claim or
 * a restored takedown — and `upgrade_required` (Contract Two's create,
 * §2.3) just means today's plan cap is full. Throwing on any of these would
 * let a caller latch the vacancy as permanently dead over a state that can
 * still heal, so it comes back as `BLOCKED` for the caller to act on or
 * retry later.
 *
 * `409 duplicate_external_job` always echoes the response's own `contract`
 * field, never the contract this call used — `externalJobId` uniqueness is
 * shared across both contracts (api-map §4), so a collision can be owned by
 * the *other* contract, and a caller that assumed its own contract would
 * retry against a PATCH endpoint that 404s on it.
 *
 * `401 revoked` is the one case worth distinguishing from an ordinary
 * failure — but ONLY on a grant-authenticated call, and the distinction is
 * the whole of fix round 1.
 *
 * eduFleet returns the identical `{reason: "revoked"}` for two completely
 * unrelated facts:
 *
 * - `partner-auth.ts:121` — `PartnerGrant.revokedAt` — **this school**
 *   withdrew its consent. IDAP must stop treating the connection as live and
 *   ask that school to reconnect. That is `ConnectorAuthError`.
 * - `partner-auth.ts:100` — `PartnerKey.revokedAt` — **IDAP's own platform
 *   key** was revoked by eduFleet. Nothing about any school changed, no
 *   school can fix it, and no school can even see it.
 *
 * The strings are byte-identical, so — unlike the `partner_revoked` substring
 * hazard, where exact matching was enough — no amount of reading the response
 * can separate them. The credential IDAP sent is the only discriminator, and
 * `credentialFor` above is what carries it here.
 *
 * Getting this wrong is not a cosmetic misreport. `ConnectorAuthError` is
 * wired to flip a connection out of CONNECTED and drop its grant ciphertext,
 * and Task 7's reconciler is the first thing that runs pushes for many
 * schools in sequence — so a revoked platform key would have disconnected
 * school after school, each one prompted to re-consent for a fault none of
 * them caused and none of them could clear.
 *
 * A platform-key `revoked` therefore takes the plain-`Error` path, which is
 * this module's "the platform itself is at fault" lane: it never touches a
 * school's connection status. The message names the real cause for whoever
 * reads a log or a failed run, because the operator fix — re-issue IDAP's
 * eduFleet key — is not something the wording anywhere downstream can guess.
 *
 * Every other 401 (a bad/missing token, `partner_revoked`, `partner_inactive`)
 * throws a plain `Error` too, for the same reason it always did: those are not
 * "reconnect this school" signals in the way a revoked grant is.
 */
/**
 * The advert's public page, as eduFleet reports it on a create
 * (`publicUrl: `${SITE_ORIGIN}/jobs/{slug}/{id}``, both create routes). It is
 * stored and later rendered as a clickable link in the school's dashboard, so
 * it is scheme-guarded HERE — at the boundary where the remote body is first
 * read — rather than at the point of render. A `javascript:` or `data:` URL
 * from a compromised or misconfigured partner host would otherwise be
 * persisted and become stored XSS the first time someone clicks it; the same
 * hazard eduFleet's own `safeHttpUrl` exists for on the values IDAP sends it.
 *
 * Anything that is not an absolute `http`/`https` URL is dropped rather than
 * repaired. `publicUrl` is a convenience — a link the school can open — and a
 * push that succeeded must never fail over one, so a missing or unusable URL
 * simply means the listing shows no link.
 */
function safePublicUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
}

function classifyJobPush(
  resp: { status: number; body: unknown },
  credential: PushCredential["kind"],
): JobPushResult {
  if (resp.status === 200 || resp.status === 201) {
    const body = rec(resp.body) ?? {};
    const jobId = str(body.jobId);
    if (!jobId) {
      throw new Error(`eduFleet: job push succeeded (status ${resp.status}) but the response carried no jobId`);
    }
    const claimState = str(body.claimStatus);
    const publicUrl = safePublicUrl(str(body.publicUrl));
    return {
      kind: "OK",
      jobId,
      ...(claimState !== undefined ? { claimState } : {}),
      ...(publicUrl !== undefined ? { publicUrl } : {}),
    };
  }

  if (resp.status === 401) {
    const body = rec(resp.body);
    if (str(body?.reason) === "revoked") {
      if (credential === "GRANT") {
        throw new ConnectorAuthError("eduFleet: this school's grant has been revoked");
      }
      throw new Error(
        "eduFleet: IDAP's eduFleet platform key has been revoked — every push under it will fail until the key is re-issued in eduFleet and updated in the platform credential. No school connection is affected.",
      );
    }
    throw new Error(`eduFleet: job push failed (${describeFailure(resp)})`);
  }

  if (resp.status === 403) {
    const body = rec(resp.body) ?? {};
    const reason = str(body.reason) ?? "blocked";
    return { kind: "BLOCKED", reason, detail: describeFailure(resp) };
  }

  if (resp.status === 409) {
    const body = rec(resp.body) ?? {};
    const ownedByContract = str(body.contract);
    if (!ownedByContract) {
      throw new Error(
        `eduFleet: duplicate externalJobId, but the response carried no contract field to trust (${describeFailure(resp)})`,
      );
    }
    // The existing job's id, forwarded rather than dropped. It is the only
    // handle IDAP is ever offered on a job it pushed but failed to record —
    // without it a create that succeeded remotely and lost its local write
    // leaves a live, public, permanently unaddressable advert.
    return { kind: "CONFLICT", ownedByContract, jobId: str(body.jobId), detail: describeFailure(resp) };
  }

  // A 400 is deterministic: the same body will be refused the same way, and
  // `spendWrite` has already taken a unit for the privilege. It throws its own
  // error type so a caller cannot mistake it for the transient failure below
  // and tell a school to try again — which would cost a unit per attempt.
  if (resp.status === 400) {
    const body = rec(resp.body);
    throw new ConnectorRejectedError(
      `eduFleet: job push rejected (${describeFailure(resp)})`,
      str(body?.reason),
      str(rec((arr(body?.details) ?? [])[0])?.message),
    );
  }

  throw new Error(`eduFleet: job push failed (${describeFailure(resp)})`);
}

async function createJob(
  ctx: AdapterContext,
  connection: ConnectionState,
  body: Record<string, unknown>,
  contract: VacancyListingContract,
): Promise<JobPushResult> {
  const credential = credentialFor(ctx, connection, contract);
  const resp = await ctx.http(jobsPath(contract), {
    method: "POST",
    token: credential.token,
    body,
  });
  return classifyJobPush(resp, credential.kind);
}

/**
 * Fix round 1: `body` is forwarded to eduFleet otherwise unfiltered, and a
 * `status` key is exactly the field `closeJob` below exists to isolate.
 * Contract Two's `updateSchoolJob` short-circuits the instant `status` is
 * present — it returns immediately and never looks at any other field in the
 * same body, then reports a 200 carrying the PRE-patch values. A caller that
 * put `status` in a `patchJob` body alongside, say, a salary edit would see
 * that 200 as success and the salary would never have changed. Refusing
 * before the request is sent — rather than silently stripping the key — is
 * deliberate: a caller that sent `status` believed it was closing the
 * listing, and dropping the key quietly would leave it believing a close
 * happened when none did. `closeJob` is the only sanctioned way to change
 * `status`, and this throw never spends a write unit (it runs before
 * `ctx.http` is called at all).
 *
 * The guard is deliberately universal even though the hazard is not.
 * Contract One's `updatePartnerJob` has no short-circuit — it applies every
 * field AND `status` before a single `save()`, and it even accepts
 * `status: "active"`, so it could reopen a listing. Narrowing this guard to
 * Contract Two would therefore be defensible, and is still the wrong trade:
 *
 *   - The spec already settled that reopening a filled vacancy creates a NEW
 *     listing rather than reviving the old one, precisely because Contract
 *     Two cannot reopen. So IDAP never needs `status: "active"` on either
 *     contract, and the capability Contract One offers here is one the
 *     product has declined.
 *   - One rule ("`closeJob` changes status, `patchJob` never does") beats a
 *     per-contract exception a caller must remember, on the path where
 *     forgetting is silent rather than loud.
 *   - The cost is a second write unit for a combined edit-and-close on
 *     Contract One. IDAP has no such flow: editing fields and changing status
 *     are separate user actions, so the cost is unrealised today.
 *
 * If a future caller genuinely needs a Contract One reopen, add an explicit
 * method for it rather than relaxing this guard — that keeps the loud path
 * loud.
 */
async function patchJob(
  ctx: AdapterContext,
  connection: ConnectionState,
  jobId: string,
  body: Record<string, unknown>,
  contract: VacancyListingContract,
): Promise<JobPushResult> {
  if ("status" in body) {
    throw new Error(
      "eduFleet: patchJob cannot carry a status key — Contract Two silently discards every other field once status is present; call closeJob to close a listing",
    );
  }
  const credential = credentialFor(ctx, connection, contract);
  const resp = await ctx.http(`${jobsPath(contract)}/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    token: credential.token,
    body,
  });
  return classifyJobPush(resp, credential.kind);
}

/**
 * Closes a vacancy by sending `{status: "closed"}` and NOTHING else, on
 * either contract. Contract Two's `updateSchoolJob` short-circuits the
 * instant `status` is present in the body: it returns immediately with
 * `closeJob(...)` and never looks at any other field in the same request
 * (`partner-school-jobs.ts` — the `patch.status !== undefined` branch
 * returns before the title/description/salary/facilities assignments below
 * it even run). A close call carrying field edits in the same body would
 * report success on the 200 while silently discarding the edits — the 200
 * itself echoes the PRE-patch values, not the ones sent. Hardcoding this
 * method's body rather than accepting one from the caller makes that
 * combination structurally impossible rather than a caller discipline that
 * could lapse.
 */
async function closeJob(
  ctx: AdapterContext,
  connection: ConnectionState,
  jobId: string,
  contract: VacancyListingContract,
): Promise<JobPushResult> {
  const credential = credentialFor(ctx, connection, contract);
  const resp = await ctx.http(`${jobsPath(contract)}/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    token: credential.token,
    body: { status: "closed" },
  });
  return classifyJobPush(resp, credential.kind);
}

// ---------------------------------------------------------------------------
// Adapter export + registration
// ---------------------------------------------------------------------------

export const edufleetAdapter: PlatformAdapter = {
  platform: "EDUFLEET",
  connectMode: "REQUEST_APPROVE_REDEEM",
  initiate,
  refresh,
  sync,
  createJob,
  patchJob,
  closeJob,
};

registerAdapter(edufleetAdapter);
