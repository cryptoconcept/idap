import { InstitutionService } from "@/services/institution.service";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

// CORS for the whole /api/public/:path* prefix is applied globally by
// next.config.ts, so this route only adds the caching header it owns.
const HEADERS = { "Cache-Control": "public, max-age=300" };

/**
 * Public full-profile lookup by slug, for the hosted profile page's pretty
 * URLs. Identical payload to the id route — one lookup key each. Published-
 * and-active only; anything else 404s, never 403.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/public/institutions/[slug]">,
) {
  try {
    const { slug } = await context.params;

    // Credential-free and CORS-open, so the only thing standing between this
    // endpoint and a scraper is the IP bucket. Keyed by IP alone, never by the
    // id or slug: a per-institution bucket would hand an attacker a fresh
    // allowance for every value they invented, which is exactly the
    // cache-busting pattern this limits.
    const limit = await consumeRateLimit(
      `public-profile:${getClientIp(request)}`,
      PUBLIC_READ_RATE_LIMIT.limit,
      PUBLIC_READ_RATE_LIMIT.windowSeconds,
    );
    if (!limit.allowed) {
      return jsonError("RATE_LIMITED", "Too many requests. Please try again in a minute.", {
        headers: {
          ...rateLimitHeaders(limit),
          "Retry-After": String(limit.retryAfterSeconds),
          // Never let a shared cache hold on to one visitor's 429.
          "Cache-Control": "no-store",
        },
      });
    }

    const profile = await InstitutionService.getPublicProfile({ slug: slug.toLowerCase() });
    if (!profile) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: HEADERS });
    }
    return jsonSuccess({ profile }, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, HEADERS);
  }
}

/** Browsers preflight the JSON GET from the institution's own website. */
export async function OPTIONS() {
  return publicCorsPreflight();
}
