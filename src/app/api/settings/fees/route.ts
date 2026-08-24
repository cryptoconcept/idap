import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { createFeeStructureSchema } from "@/lib/validation/fee-structure";
import { FeeStructureService } from "@/services/fee-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const feeStructures = await FeeStructureService.list(institution.institutionId);
    return jsonSuccess({ feeStructures });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = createFeeStructureSchema.parse(await request.json().catch(() => ({})));

    const feeStructure = await FeeStructureService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ feeStructure }, { status: 201 });
  } catch (error) {
    // A duplicate (classOrCourse, academicYear) arrives here as a Mongo
    // 11000, which handleApiError already maps to CONFLICT.
    return handleApiError(error);
  }
}
