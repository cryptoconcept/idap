/**
 * Scholarship Hub adapter — the connection lifecycle and the scholarship
 * listing wire.
 *
 * Unlike eduFleet/PassPercent, Scholarship Hub has no per-institution grant:
 * `ctx.platformKey` (Contract 1, shared across every institution) is the
 * only credential this adapter ever sends. `initiate` provisions the
 * institution's Hub *provider* record with that key
 * (`POST /api/partner/providers`, confirmed idempotent and synchronous
 * against the Hub's own `partner.service.ts`) and `upsertScholarship`/
 * `withdrawScholarship` push/withdraw one listing, keyed by `externalRef`
 * (`IDAP:{institutionId}:{scholarshipId}`).
 *
 * Like the other adapters, every function here relies on `ConnectorHttp`
 * resolving `{status, body}` on a non-2xx response rather than throwing —
 * see `./http`'s docblock. It throws only on a network failure or a timeout.
 *
 * A revoked platform key (401) is deliberately NOT a `ConnectorAuthError`
 * here — see `classifyScholarshipPush` below.
 */

import { registerAdapter } from "./index";
import {
  type PlatformAdapter,
  type AdapterContext,
  type ConnectionState,
  type InitiateResult,
  type InstitutionSummary,
  type ScholarshipPushResult,
  type SyncOutcome,
  type SyncScholarship,
  type SyncSourceData,
  type SyncStep,
  ConnectorRejectedError,
  ConnectorCapExceededError,
} from "./types";

const safeUrl = (u: unknown): string | undefined =>
  typeof u === "string" && (u.startsWith("https://") || u.startsWith("http://")) ? u : undefined;

/** Bounds a user-entered value spliced into a warning/step detail — mirrors
 *  eduFleet's `clip` (`edufleet.ts`) for the same reason: these strings are
 *  persisted on the sync run and shown to an admin. */
function clip(v: string): string {
  return v.slice(0, 80);
}

// ---------------------------------------------------------------------------
// classify — PUT/DELETE .../scholarships/:externalRef (platform key)
// ---------------------------------------------------------------------------

/**
 * Classifies one response from a scholarship upsert or withdraw call.
 *
 * The Hub's own route (`apps/api/src/modules/partner/partner.routes.ts`)
 * confirms the wire shapes used below:
 *  - 2xx: `{hubId, slug, publicUrl, remoteStatus}` on upsert,
 *    `{hubId, remoteStatus}` on withdraw (no `slug`/`publicUrl` — `slug`
 *    defaults to `""`, `publicUrl` to `undefined`, both harmless since a
 *    withdraw's `OK` is asserted with `toMatchObject`, not `toEqual`).
 *  - 409: `{error: {code: "MODERATION_HOLD", message}}` → `BLOCKED`, never
 *    thrown — a moderation hold can lift, so a caller must be able to retry.
 *  - 422: `{error: {code, details: {missing: string[]}}}` (the shared
 *    errorHandler nests the field list under `details`, NOT `error.missing`
 *    — confirmed against `partner.routes.ts`'s own comment) → a deterministic
 *    refusal, thrown as `ConnectorRejectedError` rather than returned.
 *  - 429: the daily write cap is spent → `ConnectorCapExceededError`.
 *  - Everything else — including 401 (a revoked *platform* key, shared
 *    across every institution, not a per-school grant) and a 404 on upsert
 *    (the provider was never provisioned) — is a hard, platform-config
 *    problem for the super-admin, NOT a per-institution failure. It throws a
 *    plain `Error` so it is never mistaken for `ConnectorAuthError` and never
 *    triggers a per-institution disconnect. (`withdrawScholarship` special-
 *    cases its own 404 to `NOT_FOUND` before this function ever sees it.)
 */
export function classifyScholarshipPush(resp: { status: number; body: unknown }): ScholarshipPushResult {
  const { status, body } = resp;
  if (status >= 200 && status < 300) {
    const b = (body ?? {}) as { hubId?: string; slug?: string; publicUrl?: string; remoteStatus?: string };
    if (!b.hubId) throw new Error("scholarship-hub: OK response without a hubId");
    return {
      kind: "OK",
      hubId: b.hubId,
      slug: String(b.slug ?? ""),
      publicUrl: safeUrl(b.publicUrl),
      remoteStatus: b.remoteStatus === "closed" ? "closed" : "published",
    };
  }

  const err = (body as { error?: { code?: string; message?: string; details?: { missing?: unknown } } })?.error;
  if (status === 409) return { kind: "BLOCKED", reason: err?.code ?? "MODERATION_HOLD", detail: err?.message ?? "" };
  if (status === 422) {
    throw new ConnectorRejectedError(
      "scholarship-hub: listing rejected",
      err?.code ?? "INCOMPLETE",
      JSON.stringify(err?.details?.missing ?? []),
    );
  }
  if (status === 429) throw new ConnectorCapExceededError("scholarship-hub: write cap exceeded");

  throw new Error(`scholarship-hub: request failed (status ${status})`);
}

const path = (externalRef: string) => `/api/partner/scholarships/${encodeURIComponent(externalRef)}`;

async function upsertScholarship(
  ctx: AdapterContext,
  _connection: ConnectionState,
  externalRef: string,
  body: Record<string, unknown>,
): Promise<ScholarshipPushResult> {
  return classifyScholarshipPush(await ctx.http(path(externalRef), { method: "PUT", token: ctx.platformKey, body }));
}

async function withdrawScholarship(
  ctx: AdapterContext,
  _connection: ConnectionState,
  externalRef: string,
): Promise<ScholarshipPushResult> {
  const resp = await ctx.http(path(externalRef), { method: "DELETE", token: ctx.platformKey });
  if (resp.status === 404) return { kind: "NOT_FOUND" };
  return classifyScholarshipPush(resp);
}

// ---------------------------------------------------------------------------
// initiate — POST /api/partner/providers (platform key)
// ---------------------------------------------------------------------------

/**
 * Provisions this institution's Hub provider record.
 *
 * Confirmed against the Hub's own `partner.service.ts::upsertPartnerProvider`
 * and `partner.validation.ts::partnerProviderSchema`: this is a single,
 * idempotent, always-200 upsert (`findOneAndUpdate(..., {upsert: true})`) —
 * there is no pending/approval state on the Hub side to poll at all.
 * `externalRef` must match `^IDAP:[A-Za-z0-9]+$` (institution id only, no
 * scholarship suffix) and `stateCode` must be an exact 2-letter code if sent
 * — `InstitutionSummary.address.state` is a free-text value with no such
 * guarantee, so it is deliberately omitted rather than risk a 400 on every
 * institution whose state isn't already a bare 2-letter code (`city` has no
 * such constraint and is sent whenever present).
 *
 * IMPORTANT — confirmed gap, not silently worked around: `InitiateResult`
 * (`types.ts`) is `{remoteRequestId: string; remoteStatus: string; kind?:
 * "PENDING" | "AWAITING_APPROVAL"}` — there is no `"CONNECTED"` member of
 * that union. Only `RefreshResult` and `ConnectWithKey`'s unconditional
 * write can produce a `CONNECTED` `PlatformConnection`. So even though the
 * Hub side finishes in one synchronous call, this adapter cannot make
 * `connection.service.ts`'s generic `initiate()` (`status: result.kind ??
 * "PENDING"`) land on `CONNECTED` without either widening `InitiateResult`
 * or this adapter also implementing `refresh`. Neither is in this task's
 * scope (see the task report) — `kind` is left `undefined` here, which
 * resolves to `PENDING` at the call site.
 */
async function initiate(ctx: AdapterContext, institution: InstitutionSummary): Promise<InitiateResult> {
  const body: Record<string, unknown> = {
    externalRef: `IDAP:${institution.institutionId}`,
    name: institution.name,
  };
  if (institution.city) body.city = institution.city;

  const resp = await ctx.http("/api/partner/providers", { method: "POST", token: ctx.platformKey, body });

  if (resp.status >= 200 && resp.status < 300) {
    const b = (resp.body ?? {}) as { providerId?: string };
    if (!b.providerId) {
      throw new Error("scholarship-hub: provider provisioning succeeded but the response carried no providerId");
    }
    return { remoteRequestId: b.providerId, remoteStatus: "provisioned" };
  }

  throw new Error(`scholarship-hub: provisioning the Hub provider failed (status ${resp.status})`);
}

// ---------------------------------------------------------------------------
// sync — reconcile this institution's scholarship listings
// ---------------------------------------------------------------------------

/**
 * What one scholarship needs, mirroring eduFleet's `planFor`/`VacancyPlan`
 * (`edufleet.ts`) over `SyncScholarship` instead of `SyncVacancy`. Simpler
 * than the vacancy plan: Scholarship Hub has no claim/conflict state to
 * account for.
 */
type ScholarshipPlan = "NONE" | "CLOSE" | "REPUSH" | "DRAFT_LIVE";

function planFor(scholarship: SyncScholarship): ScholarshipPlan {
  const listing = scholarship.listing;
  if (!listing || listing.remoteStatus === "closed") return "NONE";

  switch (scholarship.status) {
    case "ARCHIVED":
      return "CLOSE";
    case "PUBLISHED":
      return listing.blockedReason ? "REPUSH" : "NONE";
    default:
      // DRAFT with a live listing: real drift, deliberately left for the
      // institution — a sync must not take a public listing down over a
      // status toggle alone.
      return "DRAFT_LIVE";
  }
}

function nameOf(scholarship: SyncScholarship): string {
  return `"${clip(scholarship.name)}" (${clip(scholarship.scholarshipId)})`;
}

/**
 * Brings Scholarship Hub back into step with IDAP for scholarships this
 * institution has already published. Mirrors eduFleet's `sync` vacancy loop
 * (`edufleet.ts`) over `data.scholarships`, minus the grant probe: Scholarship
 * Hub has no per-institution credential to probe — its platform key is
 * either good for every institution or (Ruling: see `classifyScholarshipPush`)
 * surfaced as a hard upstream error, never a per-institution
 * `ConnectorAuthError`. Every push goes through the closures on
 * `SyncScholarship`, which are `scholarship-publish.service.ts`'s own
 * `repush`/`pushClose` — this function only decides WHICH scholarships need
 * WHAT.
 *
 * Honesty rule, verbatim from eduFleet: `SUCCESS` only when nothing was
 * skipped; anything skipped or failed makes the run `PARTIAL` with a warning
 * naming that scholarship.
 */
async function sync(
  _ctx: AdapterContext,
  _connection: ConnectionState,
  data: SyncSourceData,
): Promise<SyncOutcome> {
  const steps: SyncStep[] = [];
  const warnings: string[] = [];

  const scholarships = data.scholarships;
  if (scholarships === undefined) {
    steps.push({ step: "scholarships", ok: false, detail: "no scholarship worklist was supplied to this sync" });
    warnings.push(
      "scholarship-hub: scholarships were not reconciled — this sync ran without a scholarship worklist, so nothing was pushed.",
    );
    return { status: "PARTIAL", steps, warnings };
  }

  let skipped = false;
  let acted = 0;

  if (data.scholarshipsTruncated) {
    skipped = true;
    warnings.push(
      `scholarship-hub: only the first ${scholarships.length} scholarships were reconciled — this institution has more than that, and the rest were not looked at. Remove scholarships you no longer need, or close their listings individually.`,
    );
  }

  for (const scholarship of scholarships) {
    const plan = planFor(scholarship);
    if (plan === "NONE") continue;

    if (plan === "DRAFT_LIVE") {
      skipped = true;
      warnings.push(
        `scholarship-hub: ${nameOf(scholarship)} is back in draft, but its listing is still live on Scholarship Hub. A sync will not take down a listing over a draft toggle — close it explicitly, or publish it again to keep the listing.`,
      );
      continue;
    }

    const step = `${plan === "CLOSE" ? "close" : "repush"}:${clip(scholarship.scholarshipId)}`;
    const result = plan === "CLOSE" ? await scholarship.close() : await scholarship.repush();

    if (result.ok) {
      acted += 1;
      steps.push({ step, ok: true, detail: clip(scholarship.name) });
      continue;
    }

    steps.push({ step, ok: false, detail: result.detail });

    if (result.scope === "RUN") {
      warnings.push(
        `scholarship-hub: the sync stopped at ${nameOf(scholarship)} — ${result.detail} Any scholarships after it were left untouched.`,
      );
      return { status: "FAILED", steps, warnings, error: result.detail };
    }

    skipped = true;
    warnings.push(`scholarship-hub: ${nameOf(scholarship)} was not reconciled — ${result.detail}`);
  }

  if (acted === 0 && !skipped) {
    steps.push({
      step: "scholarships",
      ok: true,
      detail: "every published scholarship is already in step with Scholarship Hub",
    });
  }

  return { status: skipped ? "PARTIAL" : "SUCCESS", steps, warnings };
}

// ---------------------------------------------------------------------------

export const scholarshipHubAdapter: PlatformAdapter = {
  platform: "SCHOLARSHIP_HUB",
  connectMode: "REQUEST_APPROVE_REDEEM",
  initiate,
  sync,
  upsertScholarship,
  withdrawScholarship,
};
registerAdapter(scholarshipHubAdapter);
