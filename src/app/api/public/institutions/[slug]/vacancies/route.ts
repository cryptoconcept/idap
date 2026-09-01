import { VacancyService } from "@/services/vacancy.service";
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

/**
 * Open vacancies for a school's own careers page, by slug.
 *
 * Returns only `OPEN` roles, and carries none of the eduFleet `listing` state
 * — see `lib/vacancies/public-projection.ts`, which is where both rules are
 * actually enforced rather than here.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/public/institutions/[slug]/vacancies">,
) {
  try {
    const { slug } = await context.params;

    const limit = await consumeRateLimit(
      `public-vacancies:${getClientIp(request)}`,
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

    const vacancies = await VacancyService.listPublic({ slug });
    if (vacancies === null) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: NO_STORE });
    }

    return jsonSuccess({ vacancies }, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, NO_STORE);
  }
}

export async function OPTIONS() {
  return publicCorsPreflight();
}
