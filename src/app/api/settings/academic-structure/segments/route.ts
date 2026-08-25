import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateSegmentsSchema } from "@/lib/validation/academic-structure";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const { segments } = updateSegmentsSchema.parse(await request.json().catch(() => ({})));

    const saved = await AcademicStructureService.setSegments(
      institution.institutionId,
      segments,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ segments: saved });
  } catch (error) {
    return handleApiError(error);
  }
}
