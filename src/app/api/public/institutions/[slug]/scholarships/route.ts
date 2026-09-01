import { ScholarshipService } from "@/services/scholarship.service";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

// A short public cache: real CDN/browser protection against scrapers and
// bursts, but an unpublish (or any edit) reflects within a minute instead
// of the five the platform's "publish -> appears everywhere" promise could
// not honour. Consent-bearing results use no-store instead (see that route).
const HEADERS = { "Cache-Control": "public, max-age=60" };
// A 404 or an error must never be cached: a public read taken while an
// institution is still DRAFT would otherwise pin "not found" for the full
// max-age, so a later publish would not appear for up to five minutes. The
// 429 branch already uses this treatment for the same reason.
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(
  request: Request,
  context: RouteContext<"/api/public/institutions/[slug]/scholarships">,
) {
  try {
    const { slug } = await context.params;

    const limit = await consumeRateLimit(
      `public-scholarships-slug:${getClientIp(request)}`,
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

    const scholarships = await ScholarshipService.listPublic({ slug });
    if (scholarships === null) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: NO_STORE });
    }

    return jsonSuccess({ scholarships }, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, NO_STORE);
  }
}

export async function OPTIONS() {
  return publicCorsPreflight();
}
