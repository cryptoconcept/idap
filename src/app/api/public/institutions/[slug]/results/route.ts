import { ResultService } from "@/services/result.service";
import { resultQuerySchema } from "@/lib/validation/result";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "public, max-age=300" };

export async function GET(
  request: Request,
  context: RouteContext<"/api/public/institutions/[slug]/results">,
) {
  try {
    const { slug } = await context.params;

    const limit = await consumeRateLimit(
      `public-results:${getClientIp(request)}`,
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

    const url = new URL(request.url);
    const query = resultQuerySchema.parse({
      academicYear: url.searchParams.get("academicYear") ?? undefined,
      level: url.searchParams.get("level") ?? undefined,
      board: url.searchParams.get("board") ?? undefined,
    });

    const results = await ResultService.listPublic({ slug, ...query });
    if (results === null) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: HEADERS });
    }

    return jsonSuccess({ results }, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, HEADERS);
  }
}

export async function OPTIONS() {
  return publicCorsPreflight();
}
