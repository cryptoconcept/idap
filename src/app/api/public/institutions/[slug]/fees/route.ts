import { FeeStructureService } from "@/services/fee-structure.service";
import { feeStructureQuerySchema } from "@/lib/validation/fee-structure";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "public, max-age=300" };
// A 404 or an error must never be cached: a public read taken while an
// institution is still DRAFT would otherwise pin "not found" for the full
// max-age, so a later publish would not appear for up to five minutes. The
// 429 branch already uses this treatment for the same reason.
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(
  request: Request,
  context: RouteContext<"/api/public/institutions/[slug]/fees">,
) {
  try {
    const { slug } = await context.params;

    const limit = await consumeRateLimit(
      `public-fees:${getClientIp(request)}`,
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
    const query = feeStructureQuerySchema.parse({
      academicYear: url.searchParams.get("academicYear") ?? undefined,
    });

    const feeStructures = await FeeStructureService.listPublic({ slug, ...query });
    if (feeStructures === null) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: NO_STORE });
    }

    return jsonSuccess({ feeStructures }, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, NO_STORE);
  }
}

export async function OPTIONS() {
  return publicCorsPreflight();
}
