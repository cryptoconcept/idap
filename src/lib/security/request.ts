import type { NextRequest } from "next/server";

/**
 * Best-effort client IP. Values come from proxy headers, so this is only used
 * for rate-limit bucketing and audit logs, never for authorization.
 */
export function getClientIp(request: NextRequest | Request): string {
  const headers = request.headers;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? headers.get("cf-connecting-ip") ?? "unknown";
}
