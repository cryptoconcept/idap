/**
 * eduFleet Exchange adapter — connection lifecycle only.
 *
 * Task 1 registers the platform and implements `initiate`, the first step of
 * the four-step consent chain documented in
 * `docs/integrations/edufleet-api-map.md` §1.2. Task 2 extends this module
 * with `refresh` (steps 2-4, mirroring the poll-then-redeem shape
 * `passpercent.ts` already implements for the same `REQUEST_APPROVE_REDEEM`
 * mode).
 *
 * `sync` below is a deliberate placeholder, not a stub left unfinished by
 * accident: this plan (2026-08-28-edufleet-connection, "Plan B1 of 2") covers
 * the connection lifecycle only. The vacancy push itself — the `listing`
 * block, the publish action, claim handling — is Plan B2 and does not exist
 * yet. `SyncStatus` has exactly three legal values (`constants.ts`); `SUCCESS`
 * would fabricate a push that never happened, and `FAILED` would paint a
 * normal, unimplemented state red. `PARTIAL` is the only honest one: nothing
 * broke, nothing was pushed either, and the warning says why.
 *
 * Like `passpercent.ts`, every function here relies on `ConnectorHttp`
 * resolving `{status, body}` on a non-2xx response rather than throwing — see
 * `./http`'s docblock. It throws only on a network failure or a timeout.
 */

import { ConnectorAuthError } from "./types";
import type {
  AdapterContext,
  ConnectionState,
  InitiateResult,
  InstitutionSummary,
  PlatformAdapter,
  RefreshResult,
  SyncOutcome,
} from "./types";
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
const REQUESTED_SCOPES = ["jobs:write"];

function buildConnectionRequestBody(institution: InstitutionSummary): Rec {
  // api-map §1.2 step 1, contract 1.1.0: `externalRef` (IDAP's own
  // institutionId), `payload.institutionName`, and a non-empty `scopes`.
  // The platform key never belongs here — it is `ctx.platformKey`, carried
  // solely in the Authorization header by `createConnectorHttp`.
  // `scopes` is a fresh copy per call: the returned object is handed to the
  // HTTP layer, and a shared array constant could be mutated by a caller.
  return {
    externalRef: institution.institutionId,
    payload: {
      institutionName: institution.name,
    },
    scopes: [...REQUESTED_SCOPES],
  };
}

async function initiate(ctx: AdapterContext, institution: InstitutionSummary): Promise<InitiateResult> {
  const resp = await ctx.http("/api/partner/connection-requests", {
    method: "POST",
    token: ctx.platformKey,
    body: buildConnectionRequestBody(institution),
  });

  if (resp.status === 201) {
    const body = rec(resp.body) ?? {};
    return { remoteRequestId: String(body.requestId), remoteStatus: str(body.status) ?? "pending" };
  }

  if (resp.status === 409) {
    const body = rec(resp.body) ?? {};
    // 409 `duplicate_open_request` (api-map §5): at most one open request per
    // (partner, externalRef) already exists. That is not a failure — it means
    // a request for this school is already in flight, so IDAP adopts its id
    // and carries on, exactly like PassPercent's `initiate` for the same
    // collision shape. But only when the id is actually present: a malformed
    // 409 with no `requestId` must throw rather than let `undefined` become a
    // connection pointing at nothing.
    if (body.requestId !== undefined && body.requestId !== null) {
      return { remoteRequestId: String(body.requestId), remoteStatus: str(body.status) ?? "pending" };
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
  const resp = await ctx.http(`/api/partner/connection-requests/${remoteRequestId}`, {
    method: "GET",
    token: ctx.platformKey,
  });
  if (resp.status !== 200) {
    throw new Error(`eduFleet: polling the connection request failed (${describeFailure(resp)})`);
  }
  return rec(resp.body) ?? {};
}

/**
 * The redeem response (api-map §1.2 step 4) carries no school name, city,
 * or slug — just ids. This is a second call, using the grant token that was
 * just minted, purely to populate `RefreshResult.remoteInstitution` for
 * display.
 *
 * This call must never be able to cost the grant: a network throw, a
 * timeout, or any ordinary non-2xx status here is swallowed and simply
 * yields no `remoteInstitution` — a `CONNECTED` result with an unnamed
 * school is still a working connection. The one deliberate exception is a
 * 401 with body reason `revoked` (api-map §1.3): that is not a cosmetic
 * failure, it means the credential IDAP just received is already dead, which
 * is worth surfacing distinctly via `ConnectorAuthError` rather than quietly
 * handing back a token that will never work. Any other 401 reason (e.g. a
 * partner-wide pause) is not that signal and is swallowed like everything
 * else.
 */
async function fetchRemoteInstitution(
  ctx: AdapterContext,
  grantToken: string,
): Promise<{ name?: string; city?: string; slug?: string } | undefined> {
  let resp: { status: number; body: unknown };
  try {
    resp = await ctx.http("/api/partner/school", { method: "GET", token: grantToken });
  } catch {
    return undefined;
  }

  if (resp.status === 200) {
    const school = rec(resp.body);
    if (!school) return undefined;
    // eduFleet's School model has no slug field at all — `slug` stays
    // undefined always; never derive one from the name.
    return { name: str(school.schoolName), city: str(school.city) };
  }

  if (resp.status === 401 && str(rec(resp.body)?.reason) === "revoked") {
    throw new ConnectorAuthError("eduFleet: the grant this connection just redeemed is already revoked");
  }

  return undefined;
}

async function redeem(ctx: AdapterContext, remoteRequestId: string): Promise<RefreshResult> {
  const resp = await ctx.http(`/api/partner/connection-requests/${remoteRequestId}/redeem`, {
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
        };
      }
      return { kind: "REJECTED", remoteStatus, detail: REDEEM_STATE_MOVED_DETAIL };
    default:
      throw new Error(`eduFleet: connection request has an unrecognized status "${remoteStatus}"`);
  }
}

// ---------------------------------------------------------------------------
// sync — placeholder (see module docblock); Plan B2 implements the real push
// ---------------------------------------------------------------------------

// No parameters: a function with fewer params than `PlatformAdapter["sync"]`
// declares is still assignable to it (same variance TS allows any callback
// that ignores its trailing arguments), and it's the cleanest way to leave
// ctx/connection/data genuinely unused without tripping no-unused-vars.
async function sync(): Promise<SyncOutcome> {
  return {
    status: "PARTIAL",
    steps: [{ step: "vacancies", ok: false, detail: "eduFleet vacancy push is not implemented yet" }],
    warnings: ["eduFleet: vacancy sync is not implemented yet — this plan covers the connection lifecycle only"],
  };
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
};

registerAdapter(edufleetAdapter);
