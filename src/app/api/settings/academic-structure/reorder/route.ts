import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { reorderAcademicUnitsSchema } from "@/lib/validation/academic-structure";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/**
 * Its own endpoint rather than a PATCH per unit: one atomic rewrite across a
 * sibling set. Issued as N patches, the order would be broken between requests.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = reorderAcademicUnitsSchema.parse(await request.json().catch(() => ({})));

    const units = await AcademicStructureService.reorder(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ units });
  } catch (error) {
    return handleApiError(error);
  }
}
