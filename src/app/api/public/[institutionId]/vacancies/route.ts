import { VacancyService } from "@/services/vacancy.service";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "public, max-age=300" };

/**
 * Open vacancies by institution id — the id twin of the slug route, kept for
 * parity with every other public resource, since an institution has a slug
 * only once it claims one.
 *
 * Credential-free. A draft vacancy, a filled one, an unpublished institution
 * and a nonexistent institution are indistinguishable here: there is no 403
 * branch to write, because none exists.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/public/[institutionId]/vacancies">,
) {
  try {
    const { institutionId } = await context.params;

    // Keyed on IP only — never on institutionId, so one institution's traffic
    // cannot exhaust another's allowance.
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

    const vacancies = await VacancyService.listPublic({ institutionId });
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
