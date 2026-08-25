import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { feeHeadsSchema } from "@/lib/validation/fee-structure";
import { FeeStructureService } from "@/services/fee-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const feeHeads = await FeeStructureService.getFeeHeads(institution.institutionId);
    return jsonSuccess({ feeHeads });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const { feeHeads } = feeHeadsSchema.parse(await request.json().catch(() => ({})));

    const saved = await FeeStructureService.setFeeHeads(institution.institutionId, feeHeads, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ feeHeads: saved });
  } catch (error) {
    return handleApiError(error);
  }
}
