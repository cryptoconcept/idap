import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { bulkCreateFeeSchema } from "@/lib/validation/fee-structure";
import { FeeStructureService } from "@/services/fee-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = bulkCreateFeeSchema.parse(await request.json().catch(() => ({})));

    const result = await FeeStructureService.createMany(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    // Default 200, not 201: this creates zero or more structures, not one
    // resource, and `created` can legitimately be 0 when every unit is
    // already priced.
    return jsonSuccess(result);
  } catch (error) {
    return handleApiError(error);
  }
}
