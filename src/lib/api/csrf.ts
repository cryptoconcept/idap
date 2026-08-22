import "server-only";
import type { NextRequest } from "next/server";
import { forbidden } from "@/lib/api/errors";

/**
 * Defence in depth for cookie-authenticated mutations. SameSite=Lax already
 * stops cross-site form posts from carrying the session; this rejects anything
 * whose Origin does not match the host it was sent to.
 */
export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (!origin) return; // Same-origin fetches from some clients omit Origin entirely.

  const host = request.headers.get("host");
  try {
    const originHost = new URL(origin).host;
    if (host && originHost === host) return;
  } catch {
    // Fall through to the rejection below.
  }

  throw forbidden("Cross-origin request rejected");
}
