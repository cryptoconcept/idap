import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateAcademicUnitSchema } from "@/lib/validation/academic-structure";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/academic-structure/units/[unitId]">,
) {
  try {
    assertSameOrigin(request);
    const { unitId } = await context.params;
    const { user, institution } = await requireInstitution();
    const patch = updateAcademicUnitSchema.parse(await request.json().catch(() => ({})));

    const unit = await AcademicStructureService.update(
      institution.institutionId,
      unitId,
      patch,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ unit });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/academic-structure/units/[unitId]">,
) {
  try {
    assertSameOrigin(request);
    const { unitId } = await context.params;
    const { user, institution } = await requireInstitution();

    const { deleted } = await AcademicStructureService.remove(
      institution.institutionId,
      unitId,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ deleted });
  } catch (error) {
    return handleApiError(error);
  }
}
