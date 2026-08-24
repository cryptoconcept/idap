import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateResultSchema } from "@/lib/validation/result";
import { ResultService } from "@/services/result.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/settings/results/[resultId]">,
) {
  try {
    const { resultId } = await context.params;
    const { institution } = await requireInstitution();
    const result = await ResultService.get(institution.institutionId, resultId);
    return jsonSuccess({ result });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/results/[resultId]">,
) {
  try {
    assertSameOrigin(request);
    const { resultId } = await context.params;
    const { user, institution } = await requireInstitution();
    const patch = updateResultSchema.parse(await request.json().catch(() => ({})));

    const result = await ResultService.update(institution.institutionId, resultId, patch, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ result });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/results/[resultId]">,
) {
  try {
    assertSameOrigin(request);
    const { resultId } = await context.params;
    const { user, institution } = await requireInstitution();

    await ResultService.remove(institution.institutionId, resultId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
