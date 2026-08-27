import { requireInstitution } from "@/lib/tenant";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { assertPlatform, ConnectionService } from "@/services/connection.service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/settings/connections/[platform]/runs">,
) {
  try {
    const { platform } = await context.params;
    const { institution } = await requireInstitution();

    const runs = await ConnectionService.listRuns(institution.institutionId, assertPlatform(platform));

    return jsonSuccess({ runs });
  } catch (error) {
    return handleApiError(error);
  }
}
