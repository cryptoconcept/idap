import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateFeeStructureSchema } from "@/lib/validation/fee-structure";
import { FeeStructureService } from "@/services/fee-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/settings/fees/[feeId]">,
) {
  try {
    const { feeId } = await context.params;
    const { institution } = await requireInstitution();
    const feeStructure = await FeeStructureService.get(institution.institutionId, feeId);
    return jsonSuccess({ feeStructure });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/fees/[feeId]">,
) {
  try {
    assertSameOrigin(request);
    const { feeId } = await context.params;
    const { user, institution } = await requireInstitution();
    const patch = updateFeeStructureSchema.parse(await request.json().catch(() => ({})));

    const feeStructure = await FeeStructureService.update(
      institution.institutionId,
      feeId,
      patch,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ feeStructure });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/fees/[feeId]">,
) {
  try {
    assertSameOrigin(request);
    const { feeId } = await context.params;
    const { user, institution } = await requireInstitution();

    await FeeStructureService.remove(institution.institutionId, feeId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
