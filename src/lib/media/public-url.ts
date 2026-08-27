import { env } from "@/lib/env";
import { AppError } from "@/lib/api/errors";

/**
 * Resolves a stored media value to an absolute URL.
 *
 * `storage.putPublic` returns `/api/media/{key}` on the local-disk backend and
 * an absolute `https://…` on Vercel Blob, so callers cannot assume either
 * shape. This is the single place that reconciles them.
 */
export function toPublicUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = env.APP_URL.replace(/\/+$/, "");
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${base}${path}`;
}

const PRIVATE_V4 =
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Refuses a URL that cannot be resolved from outside this machine.
 *
 * Used ONLY on the outbound partner path, never on IDAP's own public API
 * (where a localhost URL in development is harmless). FeesBasket links to the
 * URL IDAP supplies and never fetches a copy of the bytes
 * (`feesbasket-api-map.md` §4), so a localhost URL there is a permanently dead
 * link on a public listing that IDAP has no way to observe. Failing the sync
 * loudly beats publishing a broken one quietly.
 *
 * `env.APP_URL` defaults to `http://localhost:3000` (`src/lib/env.ts:16-17`)
 * rather than being unset, which is exactly why this checks the resolved host
 * rather than whether the variable was configured.
 */
export function assertExternallyReachable(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      `Media URL "${url}" is not an absolute URL, so it is not reachable from outside this server. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback =
    hostname === "localhost" || hostname === "::1" || hostname === "[::1]";

  if (isLoopback || PRIVATE_V4.test(hostname)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Media URL host "${hostname}" is not reachable from outside this server, so partners would receive a dead link. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
    );
  }
}
