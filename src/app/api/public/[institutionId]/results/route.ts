import { ResultService } from "@/services/result.service";
import { resultQuerySchema } from "@/lib/validation/result";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

// Results are never cached — not the 200, the 404, or an error. The public
// projection's contract (results/public-projection.ts) is that withdrawing a
// topper's consent takes them "off the API on the very next read"; a topper is
// often a minor. A shared 5-minute cache broke that promise, keeping the
// name+score+photo live in browsers/CDNs after withdrawal. no-store is the only
// header that honours "next read" literally. (It also fixes the DRAFT-404
// caching the other routes fix with a 60s TTL.)
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Credential-free. A draft result, an archived result, a suspended institution
 * and a nonexistent institution are indistinguishable here: there is no 403
 * branch to write, because none exists.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/public/[institutionId]/results">,
) {
  try {
    const { institutionId } = await context.params;

    // Keyed on IP only — never on institutionId, so one institution's traffic
    // cannot exhaust another's allowance.
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

    const results = await ResultService.listPublic({ institutionId, ...query });
    if (results === null) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: NO_STORE });
    }

    return jsonSuccess({ results }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error, NO_STORE);
  }
}

export async function OPTIONS() {
  return publicCorsPreflight();
}
