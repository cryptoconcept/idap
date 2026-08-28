import type {
  Platform,
  SyncStatus,
  VacancyClaimState,
  VacancyListingContract,
  VacancyListingRemoteStatus,
  VacancyStatus,
} from "@/lib/constants";
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
 *   endpoint 404s). `jobId` is the EXISTING job's id, which eduFleet also
 *   puts on the 409 (`PartnerJobError` carries `existing.id`/`clash.id`/
 *   `raced.id`, and both create routes spread it into the body). Keeping it
 *   is what makes an orphan recoverable: if a create succeeded remotely but
 *   the local record never landed, this 409 is the only place the live
 *   advert's id is ever offered again, and a caller that discards it is left
 *   with a public listing it can no longer address or close. Optional
 *   because a hostile or future body might omit it.
 *
 * Every other non-2xx (404, 429, 500, or a 401 that isn't `revoked`) throws
 * instead — there is no route back to a usable result from those. A `400`
 * throws too, but as a `ConnectorRejectedError` rather than a plain `Error`,
 * because it is a deterministic refusal rather than an outage and must not
 * be reported to a human as something to retry. `spendWrite` running before
 * validation means a `400`/`409` already cost a write unit, which is exactly
 * why the adapter methods that produce this type never retry on their own.
 */
export type JobPushResult =
  /**
   * `publicUrl` is the advert's own page on the remote platform, and it is
   * only ever offered on a CREATE — eduFleet's two PATCH routes answer with
   * neither the URL nor the slug it is built from, so a caller that does not
   * keep the one it was handed can never reconstruct it. It cannot be derived
   * either: the path is `/jobs/{slug}/{id}`, the slug is minted remotely and
   * never sent again, and the credential's `baseUrl` is the API host, which is
   * not necessarily the public site origin. Optional because a PATCH, a
   * conflict-adopted listing, and any future platform all legitimately have
   * none. Adapters must only ever put an absolute `http(s)` URL here — this
   * value is rendered as a link, so a `javascript:`/`data:` scheme reaching it
   * would be stored XSS.
   */
  | { kind: "OK"; jobId: string; claimState?: string; publicUrl?: string }
  /**
   * `claimState` is the answer to a question the `403` itself cannot settle.
   * eduFleet raises ONE reason — `claimed` — for `claimed`, `claim_pending`
   * AND `withdrawn`, and those have two different futures: a rejected claim
   * returns the job to `unclaimed`, while a claim or a takedown that stands
   * is permanent. An adapter that can find out which (eduFleet's is a free,
   * `spendWrite`-less list read) reports it here so the caller can record the
   * real state rather than guessing from the reason. Optional: absent means
   * the adapter could not establish one, which must read as "still unknown",
   * never as "not claimed".
   */
  | { kind: "BLOCKED"; reason: string; detail: string; claimState?: string }
  | { kind: "CONFLICT"; ownedByContract: string; jobId?: string; detail: string };

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

/**
 * What one service-owned vacancy action did, as a reconciling `sync` sees it.
 *
 * `scope` is the only thing an adapter needs from a failure and the only
 * thing it cannot work out for itself, because the service has already
 * flattened four different causes into one message:
 *
 * - `"VACANCY"` — this vacancy alone could not be pushed. A local refusal
 *   (a failing preflight, a listing whose grant is gone), a `400`, a `403`
 *   or a `409`. Every other vacancy in the run is unaffected, so the
 *   reconciler records it and carries on.
 * - `"RUN"` — the platform itself could not serve the call: unreachable,
 *   misconfigured, an uncataloged 5xx, or the daily write cap spent (a `429`
 *   is not classified and arrives here). Continuing would spend the rest of
 *   the run discovering the same thing once per vacancy, so the reconciler
 *   stops. This is what bounds a sweep's cost when eduFleet is down or the
 *   school's 100 daily write units run out mid-run.
 *
 * A `ConnectorAuthError` is deliberately NOT representable here. It is not a
 * failure of one push, it is proof the credential is dead, and it must reach
 * the connection service's own handler — so the action throws it rather than
 * returning it.
 */
export type VacancyActionResult =
  | { ok: true; detail?: string }
  | { ok: false; scope: "VACANCY" | "RUN"; detail: string };

/**
 * One vacancy a reconciling `sync` may act on: what IDAP knows about it, plus
 * the two actions that can act on it.
 *
 * The actions are closures the SERVICE supplies, and that is the whole point
 * of this shape. Pushing a vacancy means reading the institution row, picking
 * a contract, preflighting, sending, and then writing the listing block back —
 * all of it already implemented once, in `vacancy-publish.service.ts`, and all
 * of it model work an adapter is forbidden to do. Handing the adapter data
 * alone would force it to reimplement that; handing it the service would make
 * an adapter import a service (and close an import cycle through the connector
 * registry). Handing it two closures leaves the adapter with exactly the job
 * it is for — deciding WHICH vacancies need WHAT — and leaves every push, every
 * local refusal and every write where they already live.
 *
 * The fields below are what that decision needs and nothing more; they are a
 * snapshot for planning, not an authority. Each action re-reads the vacancy
 * itself, so a row that changed between the load and the call is acted on as
 * it now is, or refused — the plan can be stale, the push cannot.
 */
export type SyncVacancy = {
  vacancyId: string;
  /** For naming this vacancy in a warning; never sent anywhere. */
  title: string;
  status: VacancyStatus;
  /** Absent when the school has never published this vacancy to the platform. */
  listing?: {
    contract: VacancyListingContract;
    remoteStatus: VacancyListingRemoteStatus;
    claimState?: VacancyClaimState;
    /** Set when the last push did not land — the marker that a published
     *  vacancy's current values have NOT reached the platform. */
    blockedReason?: string;
  };
  /** Push this vacancy's current values to the listing it ALREADY has. Never
   *  creates one: putting a vacancy on a public jobs board is an explicit
   *  school action, never a side effect of a sync. */
  repush(): Promise<VacancyActionResult>;
  /** Close this vacancy's listing on the platform. */
  close(): Promise<VacancyActionResult>;
};

/** Everything an adapter may push, loaded by the service so adapters never touch models. */
export type SyncSourceData = {
  institution: Record<string, unknown>;
  results: Record<string, unknown>[]; // PUBLISHED only, full internal DTO shape
  readPublicMedia: (key: string) => Promise<{ body: Buffer; contentType: string } | null>;
  /**
   * The institution's vacancies, for an adapter whose `sync` reconciles them.
   *
   * **Optional on purpose.** PassPercent and FeesBasket have no job contract
   * at all, so the service leaves this absent for them and neither adapter
   * changes. It is populated only for a platform that implements the
   * per-record job methods (`createJob`/`patchJob`/`closeJob`), which is the
   * same capability check `vacancy-publish.service.ts` makes before pushing.
   *
   * This is not the "force vacancies through `SyncSourceData`" the spec (§8)
   * warned against: that objection is about METHOD SHAPE — a single
   * `sync(data)` cannot express a per-record create/patch/close with its own
   * per-record result — and it is already honoured by the three per-record
   * methods above, which are how every actual push is made. What travels here
   * is the reconciler's worklist, not the push interface.
   */
  vacancies?: SyncVacancy[];
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
/**
 * Thrown by a platform adapter when the remote platform refuses a request on
 * its merits (HTTP 400) rather than failing to serve it. The distinction is
 * not pedantry: a transport failure or a 5xx is worth retrying and is
 * honestly described to a human as "try again shortly", whereas a 400 is
 * 100% reproducible — the identical request will be refused identically, and
 * on eduFleet's job routes each attempt burns another of the school's daily
 * write units before validation even runs. Copy that invites a retry is
 * therefore actively expensive, and the caller needs to be able to tell the
 * two apart to avoid writing it.
 *
 * `reason` and `detail` carry the remote's own machine reason and first field
 * message where it supplied them, so a caller can surface what the platform
 * actually objected to instead of a generic refusal.
 */
export class ConnectorRejectedError extends Error {
  constructor(
    message: string,
    public readonly reason?: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

export class ConnectorAuthError extends Error {
  constructor(
    message: string,
    public readonly steps: SyncStep[] = [],
    public readonly warnings: string[] = [],
  ) {
    super(message);
  }
}
