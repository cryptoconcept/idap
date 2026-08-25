import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { bulkDeleteFeeSchema } from "@/lib/validation/fee-structure";
import { FeeStructureService } from "@/services/fee-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = bulkDeleteFeeSchema.parse(await request.json().catch(() => ({})));

    const result = await FeeStructureService.removeMany(
      institution.institutionId,
      input.feeStructureIds,
      { id: user.id, name: user.name },
    );

    return jsonSuccess(result);
  } catch (error) {
    return handleApiError(error);
  }
}
