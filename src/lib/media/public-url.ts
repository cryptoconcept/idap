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
  if (/^(https?:)?\/\//i.test(url)) return url;
  const base = env.APP_URL.replace(/\/+$/, "");
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${base}${path}`;
}

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

  let hostname = parsed.hostname.toLowerCase();

  // Remove brackets if present (IPv6 literals)
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }

  // Determine what kind of host we have and apply matching rules
  // IPv4 literal: numeric dotted-quad
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const parts = hostname.split(".").map(Number);
    const [a, b] = parts;

    // Loopback 127.0.0.0/8
    if (a === 127) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Media URL host "${hostname}" is not reachable from outside this server, so partners would receive a dead link. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
      );
    }

    // 0.0.0.0/8
    if (a === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Media URL host "${hostname}" is not reachable from outside this server, so partners would receive a dead link. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
      );
    }

    // Private 10.0.0.0/8
    if (a === 10) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Media URL host "${hostname}" is not reachable from outside this server, so partners would receive a dead link. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
      );
    }

    // Link-local 169.254.0.0/16
    if (a === 169 && b === 254) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Media URL host "${hostname}" is not reachable from outside this server, so partners would receive a dead link. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
      );
    }

    // Private 172.16.0.0/12 (172.16.0.0 to 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Media URL host "${hostname}" is not reachable from outside this server, so partners would receive a dead link. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
      );
    }

    // Private 192.168.0.0/16
    if (a === 192 && b === 168) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Media URL host "${hostname}" is not reachable from outside this server, so partners would receive a dead link. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
      );
    }

    return;
  }

  // IPv6 literal: contains colon
  if (hostname.includes(":")) {
    // Extract IPv4-mapped IPv6 in hex format (::ffff:xxyy:zzww)
    // This is what URL parser returns for ::ffff:a.b.c.d format
    const ipv4MappedHex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (ipv4MappedHex) {
      const hex1 = parseInt(ipv4MappedHex[1], 16);
      const hex2 = parseInt(ipv4MappedHex[2], 16);
      const a = (hex1 >> 8) & 0xff;
      const b = hex1 & 0xff;
      const c = (hex2 >> 8) & 0xff;
      const d = hex2 & 0xff;
      const ipv4 = `${a}.${b}.${c}.${d}`;
      // Recursively check the embedded IPv4
      assertExternallyReachable(`http://${ipv4}/`);
      return;
    }

    // Loopback ::1
    if (hostname === "::1") {
      throw new AppError(
        "VALIDATION_ERROR",
        `Media URL host "${hostname}" is not reachable from outside this server, so partners would receive a dead link. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
      );
    }

    // Unspecified ::
    if (hostname === "::") {
      throw new AppError(
        "VALIDATION_ERROR",
        `Media URL host "${hostname}" is not reachable from outside this server, so partners would receive a dead link. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
      );
    }

    // Link-local fe80::/10
    if (hostname.startsWith("fe80:")) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Media URL host "${hostname}" is not reachable from outside this server, so partners would receive a dead link. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
      );
    }

    // Unique-local fc00::/7 and fd00::/7
    if (hostname.startsWith("fc00:") || hostname.startsWith("fd00:")) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Media URL host "${hostname}" is not reachable from outside this server, so partners would receive a dead link. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
      );
    }

    return;
  }

  // DNS name: only refuse exact "localhost" match (case-insensitive)
  if (hostname === "localhost") {
    throw new AppError(
      "VALIDATION_ERROR",
      `Media URL host "${hostname}" is not reachable from outside this server, so partners would receive a dead link. Set NEXT_PUBLIC_APP_URL to this deployment's public address.`,
    );
  }

  // All other DNS names are accepted
}
