import type { Platform, SyncStatus, VacancyListingContract } from "@/lib/constants";
import type { ConnectorHttp } from "./http";

export type ConnectMode = "REQUEST_APPROVE_REDEEM" | "PASTE_KEY";

export type SyncStep = { step: string; ok: boolean; detail?: string };

export type SyncOutcome = {
  status: SyncStatus;
  steps: SyncStep[];
  warnings: string[];
  error?: string;
};

/**
 * `kind` is optional and defaults to `PENDING` at the call site. It exists for
 * platforms whose freshly-opened request can already be past `pending` —
 * eduFleet's auto-remap returns `awaiting_school` on a re-connect for a school
 * it has matched before. An adapter that never has that case (PassPercent)
 * simply omits it.
 */
export type InitiateResult = {
  remoteRequestId: string;
  remoteStatus: string;
  kind?: "PENDING" | "AWAITING_APPROVAL";
};

export type RefreshResult =
  | { kind: "PENDING" | "AWAITING_APPROVAL" | "REJECTED"; remoteStatus: string; detail?: string }
  | {
      kind: "CONNECTED";
      remoteStatus: string;
      grantToken: string;
      scopes: string[];
      remoteInstitution?: { name?: string; city?: string; slug?: string };
    };

export type ConnectResult = {
  scopes: string[];
  remoteInstitution?: { name?: string; city?: string; slug?: string };
};

export type InstitutionSummary = {
  institutionId: string;
  name: string;
  city?: string;
  address?: {
    addressLine?: string;
    area?: string;
    district?: string;
    state?: string;
    pincode?: string;
  };
  phone?: string;
  website?: string;
  contactName?: string;
  contactEmail?: string;
};

export type ConnectionState = {
  institutionId: string;
  externalRef: string;
  remoteRequestId?: string;
  grantToken?: string;
  scopes?: string[];
};

export type AdapterContext = { baseUrl: string; platformKey: string; http: ConnectorHttp };

/**
 * The outcome of one push to an eduFleet job route (create, patch, or
 * close). `preflight` (Task 2) already refused locally anything eduFleet
 * would reject with a `400`, so this type has no "validation failed" case —
 * only what can still happen after a locally-clean body reaches the wire:
 *
 * - `OK`: a 200/201. `claimState` is eduFleet's `claimStatus`, present only
 *   on Contract One responses — Contract Two jobs are never claimable.
 * - `BLOCKED`: a `403`. Deliberately not thrown: two of eduFleet's four
 *   triggers on the Contract-One PATCH route (`claim_pending`,
 *   `hiddenPendingReview`) are reversible, and `upgrade_required` on a
 *   Contract-Two create just means the school's plan is full today — none of
 *   these are a permanent "this vacancy is dead", so a caller must be able to
 *   retry later rather than have the vacancy latched as failed forever.
 * - `CONFLICT`: a `409 duplicate_external_job`. `ownedByContract` is always
 *   the response's own `contract` field, never the contract the caller used
 *   — `externalJobId` uniqueness is shared across both contracts, so a
 *   same-id collision raised by the *other* contract must be told apart from
 *   one raised by this one (a retry against the wrong contract's PATCH
 *   endpoint 404s).
 *
 * Every other non-2xx (400, 404, 429, 500, or a 401 that isn't `revoked`)
 * throws instead — there is no route back to a usable result from those, and
 * `spendWrite` running before validation means a `400`/`409` already cost a
 * write unit, which is exactly why the adapter methods that produce this
 * type never retry on their own.
 */
export type JobPushResult =
  | { kind: "OK"; jobId: string; claimState?: string }
  | { kind: "BLOCKED"; reason: string; detail: string }
  | { kind: "CONFLICT"; ownedByContract: string; detail: string };

export interface PlatformAdapter {
  platform: Platform;
  connectMode: ConnectMode;
  initiate?(ctx: AdapterContext, institution: InstitutionSummary): Promise<InitiateResult>;
  refresh?(ctx: AdapterContext, connection: ConnectionState): Promise<RefreshResult>;
  connectWithKey?(ctx: AdapterContext, institutionId: string, key: string): Promise<ConnectResult>;
  sync(ctx: AdapterContext, connection: ConnectionState, data: SyncSourceData): Promise<SyncOutcome>;
  /**
   * Push a new vacancy. `body` is already built (Task 2's
   * `buildAggregatedJobBody`/`buildSchoolJobBody`) and already preflighted —
   * this method sends it and classifies the answer, nothing more. Optional
   * so PassPercent and FeesBasket, which have no job contract at all, are
   * unaffected.
   */
  createJob?(
    ctx: AdapterContext,
    connection: ConnectionState,
    body: Record<string, unknown>,
    contract: VacancyListingContract,
  ): Promise<JobPushResult>;
  /** Partial update of an existing vacancy. `jobId` is contract-shaped: the
   *  `externalJobId` for `AGGREGATED`, eduFleet's own Mongo `_id` for
   *  `SCHOOL_POSTED` — the two PATCH routes address jobs differently. */
  patchJob?(
    ctx: AdapterContext,
    connection: ConnectionState,
    jobId: string,
    body: Record<string, unknown>,
    contract: VacancyListingContract,
  ): Promise<JobPushResult>;
  /** Closes a vacancy by sending `{status: "closed"}` and nothing else —
   *  never combined with a field edit in the same call (see `JobPushResult`
   *  and the eduFleet adapter's `closeJob` docblock for why). */
  closeJob?(
    ctx: AdapterContext,
    connection: ConnectionState,
    jobId: string,
    contract: VacancyListingContract,
  ): Promise<JobPushResult>;
}

/** Everything an adapter may push, loaded by the service so adapters never touch models. */
export type SyncSourceData = {
  institution: Record<string, unknown>;
  results: Record<string, unknown>[]; // PUBLISHED only, full internal DTO shape
  readPublicMedia: (key: string) => Promise<{ body: Buffer; contentType: string } | null>;
};

/**
 * Thrown by a platform adapter when a per-institution grant token the remote
 * platform previously issued is rejected (HTTP 401) — i.e. the credential
 * IDAP is holding is no longer honoured by the remote side, as distinct from
 * any other request-shaped failure. The PassPercent adapter throws this from
 * `sync` only (all three throw sites are inside it); the eduFleet adapter also
 * throws it from `refresh`. The connection service discriminates it in both
 * `syncNow` and `refresh`, flipping the connection to a state that means
 * "needs reconnection" rather than treating it as an ordinary failure.
 *
 * `steps`/`warnings` (fix round 2, F3) carry whatever `sync` had already
 * accumulated before the 401 — results are pushed one year at a time, so a
 * mid-run auth failure must not discard the record of which years already
 * reached the (public) listing. Both default to `[]` so existing call sites
 * that construct this with just a message keep working unchanged.
 */
export class ConnectorAuthError extends Error {
  constructor(
    message: string,
    public readonly steps: SyncStep[] = [],
    public readonly warnings: string[] = [],
  ) {
    super(message);
  }
}
