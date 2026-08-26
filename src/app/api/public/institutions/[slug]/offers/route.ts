import { OfferService } from "@/services/offer.service";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "public, max-age=300" };

export async function GET(
  request: Request,
  context: RouteContext<"/api/public/institutions/[slug]/offers">,
) {
  try {
    const { slug } = await context.params;

    const limit = await consumeRateLimit(
      `public-offers-slug:${getClientIp(request)}`,
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

    const offers = await OfferService.listPublic({ slug });
    if (offers === null) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: HEADERS });
    }

    return jsonSuccess({ offers }, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, HEADERS);
  }
}

export async function OPTIONS() {
  return publicCorsPreflight();
}
