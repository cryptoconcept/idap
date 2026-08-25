import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { createAcademicUnitSchema } from "@/lib/validation/academic-structure";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = createAcademicUnitSchema.parse(await request.json().catch(() => ({})));

    const unit = await AcademicStructureService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ unit }, { status: 201 });
  } catch (error) {
    // A duplicate sibling name arrives here as a Mongo 11000, which
    // handleApiError already maps to CONFLICT.
    return handleApiError(error);
  }
}
