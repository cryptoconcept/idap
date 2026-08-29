import { VacancyService } from "@/services/vacancy.service";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "public, max-age=300" };

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
      return jsonError("NOT_FOUND", "Institution not found", { headers: HEADERS });
    }

    return jsonSuccess({ vacancies }, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, HEADERS);
  }
}

export async function OPTIONS() {
  return publicCorsPreflight();
}
