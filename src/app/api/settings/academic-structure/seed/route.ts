import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();

    const result = await AcademicStructureService.seedFromProfile(institution.institutionId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess(result);
  } catch (error) {
    return handleApiError(error);
  }
}
