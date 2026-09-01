import { InstitutionService } from "@/services/institution.service";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

/** Public branding lookup used by the hosted apply pages and the widget. */
export async function GET(
  request: Request,
  context: RouteContext<"/api/public/[institutionId]">,
) {
  try {
    // Audit SEC-L1: this was the only public route with no throttle — a
    // credential-free, CORS-* lookup that 404s for unknown ids, i.e. an
    // institution-id enumeration oracle and an unbounded scrape surface. Keyed
    // on IP alone, like every sibling public route.
    const limit = await consumeRateLimit(
      `public-branding:${getClientIp(request)}`,
      PUBLIC_READ_RATE_LIMIT.limit,
      PUBLIC_READ_RATE_LIMIT.windowSeconds,
    );
    if (!limit.allowed) {
      return jsonError("RATE_LIMITED", "Too many requests. Please try again in a minute.", {
        headers: {
          ...rateLimitHeaders(limit),
          "Retry-After": String(limit.retryAfterSeconds),
          "Cache-Control": "no-store",
        },
      });
    }

    const { institutionId } = await context.params;
    const institution = await InstitutionService.getPublicBranding(institutionId);
    if (!institution) return jsonError("NOT_FOUND", "Institution not found");
    return jsonSuccess({ institution });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Browsers preflight the JSON POST from the institution's own website. */
export async function OPTIONS() {
  return publicCorsPreflight();
}
