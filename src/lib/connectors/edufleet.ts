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

import type { AdapterContext, InitiateResult, InstitutionSummary, PlatformAdapter, SyncOutcome } from "./types";
import { registerAdapter } from "./index";

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// initiate — POST /api/partner/connection-requests (platform key)
// ---------------------------------------------------------------------------

function buildConnectionRequestBody(institution: InstitutionSummary): Rec {
  // api-map §1.2 step 1: required fields only — `externalRef` (IDAP's own
  // institutionId) and `payload.institutionName`. Nothing else is documented
  // for this endpoint, unlike PassPercent's equivalent, so nothing else is
  // sent. The platform key never belongs here — it is `ctx.platformKey`,
  // carried solely in the Authorization header by `createConnectorHttp`.
  return {
    externalRef: institution.institutionId,
    payload: {
      institutionName: institution.name,
    },
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

  throw new Error(`eduFleet: submitting the connection request failed (status ${resp.status})`);
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
  sync,
};

registerAdapter(edufleetAdapter);
