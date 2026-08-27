/**
 * PassPercent adapter — protocol choreography.
 *
 * Task 5 (`./passpercent-mapping`) built the pure "what to send" core: given
 * plain records, it produces plain records, with no I/O anywhere. This
 * module is the "when and how": the connection lifecycle (`initiate` /
 * `refresh`, over the platform key) and the sync run (`sync`, over a grant
 * token — schema, then profile patch, then per-year results), plus
 * classifying whatever the remote side sends back, per
 * `docs/integrations/passpercent-api-map.md` §§2-4.
 *
 * The one thing every function below is built around: `ConnectorHttp`
 * (`./http`) does NOT throw on a non-2xx response — it resolves normally as
 * `{status, body}` so the response can be classified. It throws only on a
 * network failure or a timeout. There is deliberately no try/catch around
 * any `ctx.http(...)` call in this file for a protocol-level error; every
 * status/body inspection below IS the error handling.
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
  SyncSourceData,
  SyncStep,
} from "./types";
import { registerAdapter } from "./index";
import { buildProfilePatch, buildResultsPayloads, deriveStreams } from "./passpercent-mapping";

type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Small local guards — mirrors of passpercent-mapping.ts's private helpers.
// That module doesn't export them, so they're duplicated here rather than
// reached into across a module boundary that isn't meant to expose them.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Map §3/§4: "~200KB raw" cap on an inline base64 image (topper photo / recruiter logo). */
const MAX_TOPPER_PHOTO_RAW_BYTES = 200_000;

/** Verbatim per the brief — Task 8 may surface this string directly to an admin. */
const NEEDS_CONSENT_MESSAGE =
  "PassPercent: the school has not consented (or has withdrawn consent) — ask them to approve the connection on their PassPercent dashboard";

/** Verbatim per the brief's redeem-race wording. */
const ALREADY_REDEEMED_DETAIL = "already redeemed — reconnect from PassPercent";

// ---------------------------------------------------------------------------
// initiate — POST /api/partner/connection-requests (platform key)
// ---------------------------------------------------------------------------

function buildConnectionRequestBody(institution: InstitutionSummary): Rec {
  const address = institution.address;
  return {
    externalRef: institution.institutionId,
    name: institution.name,
    city: institution.city,
    phone: institution.phone,
    addressLine: address?.addressLine,
    area: address?.area,
    district: address?.district,
    state: address?.state,
    pincode: address?.pincode,
    website: institution.website,
    contactName: institution.contactName,
    contactEmail: institution.contactEmail,
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
    // An open request for this (partner, externalRef) already exists — OR
    // the route lazily swept an orphan and minted a brand new one instead
    // (map §2's "actor: system" wrinkle, which can return 201 for the same
    // re-submission). Either way, when the 409 body carries a requestId,
    // this is not an error: adopt it and continue with it.
    if (body.requestId !== undefined && body.requestId !== null) {
      return { remoteRequestId: String(body.requestId), remoteStatus: str(body.status) ?? "pending" };
    }
  }

  throw new Error(`PassPercent: submitting the connection request failed (status ${resp.status})`);
}

// ---------------------------------------------------------------------------
// refresh — GET .../connection-requests/:id, then redeem on "approved"
// (both platform key)
// ---------------------------------------------------------------------------

async function pollConnectionRequest(ctx: AdapterContext, remoteRequestId: string): Promise<Rec> {
  const resp = await ctx.http(`/api/partner/connection-requests/${remoteRequestId}`, {
    method: "GET",
    token: ctx.platformKey,
  });
  if (resp.status !== 200) {
    throw new Error(`PassPercent: polling the connection request failed (status ${resp.status})`);
  }
  return rec(resp.body) ?? {};
}

async function redeem(ctx: AdapterContext, remoteRequestId: string): Promise<RefreshResult> {
  const resp = await ctx.http(`/api/partner/connection-requests/${remoteRequestId}/redeem`, {
    method: "POST",
    token: ctx.platformKey,
  });

  if (resp.status === 200) {
    const body = rec(resp.body) ?? {};
    const institution = rec(body.institution);
    return {
      kind: "CONNECTED",
      remoteStatus: "completed",
      grantToken: String(body.token),
      scopes: stringArray(body.scopes),
      remoteInstitution: institution
        ? { name: str(institution.name), city: str(institution.city), slug: str(institution.slug) }
        : undefined,
    };
  }

  if (resp.status === 409 || resp.status === 404) {
    // Someone else redeemed first (or the row aged out from under us). The
    // token from the winning redeem is gone — only a fresh connection
    // request can recover from here, so this is a REJECTED-kind result, not
    // a thrown error.
    return { kind: "REJECTED", remoteStatus: "rejected", detail: ALREADY_REDEEMED_DETAIL };
  }

  throw new Error(`PassPercent: redeeming the connection request failed (status ${resp.status})`);
}

async function refresh(ctx: AdapterContext, connection: ConnectionState): Promise<RefreshResult> {
  if (!connection.remoteRequestId) {
    throw new Error("PassPercent: refresh requires a remoteRequestId, but the connection has none");
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
      // Defensive: reaching "completed" here means it was redeemed by
      // someone/something else between polls, without IDAP's own redeem
      // call ever succeeding — functionally identical to the redeem race
      // above from IDAP's point of view: no token to recover here.
      return { kind: "REJECTED", remoteStatus, detail: ALREADY_REDEEMED_DETAIL };
    default:
      throw new Error(`PassPercent: connection request has an unrecognized status "${remoteStatus}"`);
  }
}

// ---------------------------------------------------------------------------
// sync — schema, then profile PATCH, then per-year results PUT (grant token)
// ---------------------------------------------------------------------------

type GrantCallOutcome =
  | { kind: "ok" }
  | { kind: "authError"; message: string }
  | { kind: "consent"; message: string }
  | { kind: "quota"; message: string }
  | { kind: "otherFailure"; message: string };

/**
 * Shared classification for every grant-token call in `sync`. Order matters:
 * 401 and the `needs_school_consent` 403 are checked before falling back to
 * a generic non-2xx failure, because both mean something structurally
 * different from an ordinary rejected request (map §1/§7 migration notes:
 * every grant-tier route can return the consent 403; a 401 means the grant
 * itself is no longer honoured).
 */
function classifyGrantResponse(resp: { status: number; body: unknown }, label: string): GrantCallOutcome {
  if (resp.status >= 200 && resp.status < 300) return { kind: "ok" };

  const body = rec(resp.body);

  if (resp.status === 401) {
    return { kind: "authError", message: `PassPercent rejected the grant token (401) while calling ${label}` };
  }
  if (resp.status === 403 && body?.reason === "needs_school_consent") {
    return { kind: "consent", message: NEEDS_CONSENT_MESSAGE };
  }
  if (resp.status === 429) {
    // Two distinct quota-exhaustion body shapes (map §4); either one carries
    // a human-readable `error` string worth surfacing verbatim.
    const quotaMessage = str(body?.error) ?? "PassPercent: daily write quota reached";
    return { kind: "quota", message: quotaMessage };
  }

  const detail = str(body?.error);
  return {
    kind: "otherFailure",
    message: `PassPercent: ${label} failed (status ${resp.status})${detail ? `: ${detail}` : ""}`,
  };
}

type SchemaField = { name: string; enum?: string[] };

function extractSchemaFields(schemaBody: Rec): SchemaField[] {
  const fields = arr(schemaBody.fields);
  if (!fields) return [];
  const out: SchemaField[] = [];
  for (const raw of fields) {
    const field = rec(raw);
    const name = field ? str(field.name) : undefined;
    if (!name) continue;
    const enumValues = field ? arr(field.enum)?.filter((v): v is string => typeof v === "string") : undefined;
    out.push(enumValues && enumValues.length > 0 ? { name, enum: enumValues } : { name });
  }
  return out;
}

type PhotoEncoding = "dataUri";

/**
 * RESOLVED against a live `GET /api/partner/schema` response (Task 10,
 * 2026-08-27) — see `docs/integrations/passpercent-api-map.md`'s dated
 * addendum for the full captured payload. There is no `results.photoEncoding`
 * field anywhere on the real response; that field name was an unverifiable
 * placeholder guessed before any live schema could be read, and it does not
 * exist.
 *
 * The actual wire format is documented in prose, not a structured field:
 * `results.topperShape` says a topper's `photo` is "a data:image/* URL or an
 * https URL", and `results.inlineImages` confirms a `data:image/*;base64,...`
 * string is accepted and gets swapped for a CDN URL on save (with the same
 * ~200KB raw cap this adapter already enforces before ever calling out).
 * IDAP always reads raw bytes from its own storage, never an externally
 * hosted URL, so `dataUri` is the only branch this adapter can ever use —
 * there is no partner-negotiated "base64 vs dataUri" choice, and the old
 * `"base64"` variant was never a real option.
 *
 * The one thing worth checking at runtime is that the endpoint still
 * documents inline-image support at all (`results.inlineImages` present) —
 * if a future PassPercent release drops that capability, this degrades to
 * "no encoding" (send no photo, warn once) rather than assuming a contract
 * that may no longer hold.
 */
function extractPhotoEncoding(schemaBody: Rec): PhotoEncoding | null {
  const results = rec(schemaBody.results);
  return typeof results?.inlineImages === "string" && results.inlineImages.length > 0 ? "dataUri" : null;
}

/** Recursively finds every object anywhere in a results payload that carries
 * a `photoKey` — board toppers, combination toppers, and selection toppers
 * all use the exact same shape, so one generic walk covers all three rather
 * than three call sites hand-enumerating the tree. */
function collectPhotoBearingRecords(node: unknown, out: Rec[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectPhotoBearingRecords(item, out);
    return;
  }
  const record = rec(node);
  if (!record) return;
  if (typeof record.photoKey === "string") out.push(record);
  for (const value of Object.values(record)) collectPhotoBearingRecords(value, out);
}

async function resolveTopperPhoto(
  topper: Rec,
  readPublicMedia: SyncSourceData["readPublicMedia"],
  warnings: string[],
): Promise<void> {
  const key = topper.photoKey as string;
  // Always strip before sending, whatever the outcome below — PassPercent's
  // TopperSchema has no `photoKey` field, only `photo`.
  delete topper.photoKey;

  const media = await readPublicMedia(key);
  if (!media) {
    warnings.push(`Topper photo "${key}" could not be read from storage — sent without a photo`);
    return;
  }
  if (media.body.length > MAX_TOPPER_PHOTO_RAW_BYTES) {
    warnings.push(
      `Topper photo "${key}" is ${media.body.length} bytes, over PassPercent's ~200KB raw cap — sent without a photo`,
    );
    return;
  }

  const base64 = media.body.toString("base64");
  topper.photo = `data:${media.contentType};base64,${base64}`;
}

async function resolveYearPhotos(
  payload: Rec,
  readPublicMedia: SyncSourceData["readPublicMedia"],
  encoding: PhotoEncoding | null,
  warnings: string[],
  state: { missingEncodingWarned: boolean },
): Promise<void> {
  const toppers: Rec[] = [];
  collectPhotoBearingRecords(payload, toppers);
  if (toppers.length === 0) return;

  if (encoding == null) {
    // Never guess a wire format: strip every photoKey, and warn exactly
    // once for the whole run (not once per topper/year).
    if (!state.missingEncodingWarned) {
      warnings.push("topper photos skipped: PassPercent schema does not document an inline encoding");
      state.missingEncodingWarned = true;
    }
    for (const topper of toppers) delete topper.photoKey;
    return;
  }

  for (const topper of toppers) {
    await resolveTopperPhoto(topper, readPublicMedia, warnings);
  }
}

async function sync(ctx: AdapterContext, connection: ConnectionState, data: SyncSourceData): Promise<SyncOutcome> {
  const steps: SyncStep[] = [];
  const warnings: string[] = [];

  const grantToken = connection.grantToken;
  if (!grantToken) {
    throw new Error("PassPercent: sync requires a grant token, but the connection has none");
  }

  // 1. GET /partner/schema — dual-auth route, but sync always already holds
  //    a grant by the time it runs, so it's used here for consistency.
  const schemaResp = await ctx.http("/api/partner/schema", { method: "GET", token: grantToken });
  const schemaOutcome = classifyGrantResponse(schemaResp, "GET /partner/schema");
  if (schemaOutcome.kind === "authError") throw new ConnectorAuthError(schemaOutcome.message);
  if (schemaOutcome.kind !== "ok") {
    steps.push({ step: "schema", ok: false, detail: schemaOutcome.message });
    return { status: "FAILED", steps, warnings, error: schemaOutcome.message };
  }
  steps.push({ step: "schema", ok: true });

  const schemaBody = rec(schemaResp.body) ?? {};
  const schemaFields = extractSchemaFields(schemaBody);
  const photoEncoding = extractPhotoEncoding(schemaBody);

  // 2. Build the results payloads and the streams union BEFORE the profile
  //    patch (both pure, no network) so the patch can declare every stream
  //    the results push is about to use. No HTTP call happens in between,
  //    so this doesn't disturb the required schema -> PATCH -> PUT order.
  const institution = data.institution;
  const academic = rec(institution.academic);
  const institutionType = str(institution.institutionType) ?? "";
  const segments = stringArray(academic?.segments);

  const { byYear, warnings: resultsWarnings } = buildResultsPayloads({
    results: data.results,
    institutionType,
  });
  warnings.push(...resultsWarnings);

  const mappedResultStreams = new Set<string>();
  for (const { streams: yearStreams } of byYear.values()) {
    for (const key of Object.keys(yearStreams)) mappedResultStreams.add(key);
  }

  const streams = deriveStreams({
    segments,
    institutionType,
    mappedResultStreams: [...mappedResultStreams],
  });

  const { patch, warnings: patchWarnings } = buildProfilePatch({ institution, streams, schemaFields });
  warnings.push(...patchWarnings);

  // 3. PATCH /partner/institution — declares the streams. Any non-2xx here
  //    aborts the whole run: a results push would be rejected against
  //    streams the institution hasn't declared, so there's no point trying.
  const profileResp = await ctx.http("/api/partner/institution", {
    method: "PATCH",
    token: grantToken,
    body: patch,
  });
  const profileOutcome = classifyGrantResponse(profileResp, "PATCH /partner/institution");
  if (profileOutcome.kind === "authError") throw new ConnectorAuthError(profileOutcome.message);
  if (profileOutcome.kind !== "ok") {
    steps.push({ step: "profile", ok: false, detail: profileOutcome.message });
    return { status: "FAILED", steps, warnings, error: profileOutcome.message };
  }
  steps.push({ step: "profile", ok: true });

  // 4. PUT /partner/institution/results/:year, ascending by year. A generic
  //    per-year failure is recorded and the run continues (final PARTIAL).
  //    A 401, a consent withdrawal, or a quota exhaustion apply just as much
  //    to every remaining year, so those abort the rest of the loop instead
  //    of burning further calls on a foregone conclusion.
  const years = [...byYear.keys()].sort();
  const photoState = { missingEncodingWarned: false };
  let anyResultFailure = false;

  for (const year of years) {
    const payload = byYear.get(year)!;
    await resolveYearPhotos(payload, data.readPublicMedia, photoEncoding, warnings, photoState);

    const resultResp = await ctx.http(`/api/partner/institution/results/${year}`, {
      method: "PUT",
      token: grantToken,
      body: payload,
    });
    const resultOutcome = classifyGrantResponse(resultResp, `PUT /partner/institution/results/${year}`);

    if (resultOutcome.kind === "authError") throw new ConnectorAuthError(resultOutcome.message);

    if (resultOutcome.kind === "consent" || resultOutcome.kind === "quota") {
      steps.push({ step: `results:${year}`, ok: false, detail: resultOutcome.message });
      return { status: "FAILED", steps, warnings, error: resultOutcome.message };
    }

    if (resultOutcome.kind === "ok") {
      steps.push({ step: `results:${year}`, ok: true });
    } else {
      steps.push({ step: `results:${year}`, ok: false, detail: resultOutcome.message });
      anyResultFailure = true;
    }
  }

  return { status: anyResultFailure ? "PARTIAL" : "SUCCESS", steps, warnings };
}

// ---------------------------------------------------------------------------
// Adapter export + registration
// ---------------------------------------------------------------------------

export const passpercentAdapter: PlatformAdapter = {
  platform: "PASSPERCENT",
  connectMode: "REQUEST_APPROVE_REDEEM",
  initiate,
  refresh,
  sync,
};

registerAdapter(passpercentAdapter);
