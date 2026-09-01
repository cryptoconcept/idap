import { InstitutionService } from "@/services/institution.service";
import { directoryQuerySchema } from "@/lib/validation/institution";
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
 * The public institution directory — the one endpoint here that is not about a
 * single named institution.
 *
 * That makes it the only public route where the rate limit is doing real work
 * rather than defence in depth. Every other public route needs the caller to
 * already know an id or slug; this one hands out the ids. Keyed on IP alone,
 * for the same reason as its siblings: keying on any request value would give
 * a scraper a fresh allowance per value it invented.
 *
 * Never 403s and never distinguishes. An unpublished, suspended or nonexistent
 * institution is simply absent from the page, exactly as it 404s on the
 * profile route — the two gate on the identical `active` + `profileStatus`
 * pair, and a school listed here whose profile 404s would be a broken link on
 * somebody's website.
 */
export async function GET(request: Request) {
  try {
    const limit = await consumeRateLimit(
      `public-directory:${getClientIp(request)}`,
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
    const query = directoryQuerySchema.parse({
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
      city: url.searchParams.get("city") ?? undefined,
      board: url.searchParams.get("board") ?? undefined,
      type: url.searchParams.get("type") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    });

    const page = await InstitutionService.listPublicDirectory(query);
    return jsonSuccess(page, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, NO_STORE);
  }
}

export async function OPTIONS() {
  return publicCorsPreflight();
}
