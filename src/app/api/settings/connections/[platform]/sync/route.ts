import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { assertPlatform, ConnectionService } from "@/services/connection.service";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/settings/connections/[platform]/sync">,
) {
  try {
    assertSameOrigin(request);
    const { platform } = await context.params;
    const { user, institution } = await requireInstitution();

    const { connection, run } = await ConnectionService.syncNow(
      institution.institutionId,
      assertPlatform(platform),
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ connection, run });
  } catch (error) {
    return handleApiError(error);
  }
}
