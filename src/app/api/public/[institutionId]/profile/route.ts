import { InstitutionService } from "@/services/institution.service";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

// CORS for the whole /api/public/:path* prefix is applied globally by
// next.config.ts, so this route only adds the caching header it owns.
const HEADERS = { "Cache-Control": "public, max-age=300" };

/**
 * Public full-profile lookup by institution id, for the hosted profile page.
 * Published-and-active only — anything else 404s, never 403, so a draft
 * profile is indistinguishable from a nonexistent one.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/public/[institutionId]/profile">,
) {
  try {
    const { institutionId } = await context.params;
    const profile = await InstitutionService.getPublicProfile({ institutionId });
    if (!profile) {
      return jsonError("NOT_FOUND", "Institution not found", { headers: HEADERS });
    }
    return jsonSuccess({ profile }, { headers: HEADERS });
  } catch (error) {
    return handleApiError(error, HEADERS);
  }
}

/** Browsers preflight the JSON GET from the institution's own website. */
export async function OPTIONS() {
  return publicCorsPreflight();
}
