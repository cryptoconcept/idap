/**
 * Shared HTTP client for outbound platform connectors (PassPercent,
 * FeesBasket, ...). One deliberate design choice governs it: a non-2xx
 * response is NOT an exception. It resolves normally as `{status, body}` so
 * each adapter can classify it itself — a 403 with `reason:
 * "needs_school_consent"` means something completely different from a 401,
 * and both differ from a 429. This client throws `ConnectorHttpError` ONLY
 * when the request itself could not be completed at all: a network failure
 * or a timeout.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;

/**
 * Upper bound on how long a remote-supplied `Retry-After` is honoured before
 * retrying. Kept well under `SYNC_LOCK_STALE_MINUTES` (10 minutes,
 * `src/lib/constants.ts`) — an obedient wait here must never by itself be
 * long enough to outlive the sync lock's staleness window and let a second
 * `syncNow` believe this one is abandoned. 60s leaves a wide margin even
 * stacked with this client's own per-call timeout and one retry.
 */
const MAX_RETRY_AFTER_MS = 60_000;

export class ConnectorHttpError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message?: string,
  ) {
    super(message ?? `Connector request failed (status ${status})`);
    this.name = "ConnectorHttpError";
  }
}

export type ConnectorHttp = (
  path: string,
  init: {
    method: "GET" | "POST" | "PUT" | "PATCH";
    token: string; // sent as Authorization: Bearer <token>
    body?: unknown;
    headers?: Record<string, string>;
  },
) => Promise<{ status: number; body: unknown }>;

type ConnectorRequestInit = {
  method: "GET" | "POST" | "PUT" | "PATCH";
  token: string;
  body?: unknown;
  headers?: Record<string, string>;
};

type RawResponse = { status: number; body: unknown; retryAfterSeconds: number | null };

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseRetryAfterSeconds(header: string | null): number | null {
  if (header == null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Runs a single attempt. Only a network failure or a timeout throws —
 * anything that reaches the server and comes back, 2xx or not, resolves
 * normally and is returned as-is for the caller to classify.
 *
 * The thrown message is built only from static, known-safe parts (the method
 * and the request path). The token lives solely in the Authorization header
 * and is never interpolated here, on timeout or on any other failure — do
 * not "improve" this by folding in the underlying error's own message.
 */
async function attempt(url: string, path: string, init: ConnectorRequestInit): Promise<RawResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${init.token}`,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const isTimeout = cause instanceof DOMException && cause.name === "TimeoutError";
    throw new ConnectorHttpError(
      0,
      null,
      isTimeout
        ? `Connector ${init.method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`
        : `Connector ${init.method} ${path} failed: network error`,
    );
  }

  return {
    status: response.status,
    body: await parseBody(response),
    retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
  };
}

/**
 * Builds a `ConnectorHttp` bound to one platform's base URL. Exactly one
 * retry on a 429: after `Retry-After` seconds when the header is present,
 * else after a flat 2 seconds. Not a retry loop — if the retry also comes
 * back 429, that second response is returned as-is.
 *
 * **The worst-case wall time of one call is ~90 s, not the 15 s timeout.**
 * L1: worth stating here, at the constants, because every caller that
 * `await`s a connector call inherits it and more than one has quoted 15 s.
 * The arithmetic: the first attempt takes up to `REQUEST_TIMEOUT_MS` (15 s) —
 * a timeout THROWS, so a 429 that reaches the retry arrived inside that
 * window — plus an honoured `Retry-After` of up to `MAX_RETRY_AFTER_MS`
 * (60 s; anything longer returns the 429 immediately rather than waiting),
 * plus a second attempt of up to another 15 s.
 *
 * Check that against the serverless function timeout before adding a retry or
 * raising either constant. No route in this app sets `maxDuration` except the
 * cron (60 s), so the interactive routes run at the platform default — which
 * on Vercel is 60 s unless raised, i.e. LESS than this bound. A request cut
 * off there is not data loss for the vacancy PATCH path (the local edit is
 * committed before the push runs), but the school loses the report of whether
 * the push landed, which is the one failure that design exists to avoid.
 */
export function createConnectorHttp(baseUrl: string): ConnectorHttp {
  return async function connectorHttp(path, init) {
    const url = joinUrl(baseUrl, path);
    const first = await attempt(url, path, init);
    if (first.status !== 429) {
      return { status: first.status, body: first.body };
    }

    const requestedDelayMs = first.retryAfterSeconds != null ? first.retryAfterSeconds * 1000 : RETRY_DELAY_MS;
    if (requestedDelayMs > MAX_RETRY_AFTER_MS) {
      // A wait this long risks outliving the sync lock's staleness window
      // long before the retry ever fires. Rather than silently waiting a
      // shorter, arbitrary amount and probably being rate-limited again
      // anyway (a blind retry against a wait the server explicitly asked to
      // be much longer), surface the original 429 immediately and let the
      // caller treat it as an ordinary failed call.
      return { status: first.status, body: first.body };
    }

    await new Promise((resolve) => setTimeout(resolve, requestedDelayMs));

    const second = await attempt(url, path, init);
    return { status: second.status, body: second.body };
  };
}
