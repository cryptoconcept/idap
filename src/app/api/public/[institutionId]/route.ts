import { InstitutionService } from "@/services/institution.service";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

/** Public branding lookup used by the hosted apply pages and the widget. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/public/[institutionId]">,
) {
  try {
    const { institutionId } = await context.params;
    const institution = await InstitutionService.getPublicBranding(institutionId);
    if (!institution) return jsonError("NOT_FOUND", "Institution not found");
    return jsonSuccess({ institution });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Browsers preflight the JSON POST from the institution's own website. */
export async function OPTIONS() {
  return publicCorsPreflight();
}
