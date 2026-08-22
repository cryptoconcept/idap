import type { NextRequest } from "next/server";
import { requireSuperAdmin, requireUser } from "@/lib/tenant";
import { updateInstitutionSchema } from "@/lib/validation/institution";
import { InstitutionService } from "@/services/institution.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { forbidden } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/institutions/[institutionId]">,
) {
  try {
    const user = await requireUser();
    const { institutionId } = await context.params;

    // Institution admins may only read their own record.
    if (user.role !== "SUPER_ADMIN" && user.institutionId !== institutionId) {
      throw forbidden();
    }

    const institution = await InstitutionService.getById(institutionId);
    return jsonSuccess({ institution });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/institutions/[institutionId]">,
) {
  try {
    assertSameOrigin(request);
    const user = await requireSuperAdmin();
    const { institutionId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const patch = updateInstitutionSchema.parse(body);

    const institution = await InstitutionService.update(institutionId, patch, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ institution });
  } catch (error) {
    return handleApiError(error);
  }
}
