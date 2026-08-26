import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateScholarshipSchema } from "@/lib/validation/scholarship";
import { ScholarshipService } from "@/services/scholarship.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/settings/scholarships/[scholarshipId]">,
) {
  try {
    const { scholarshipId } = await context.params;
    const { institution } = await requireInstitution();
    const scholarship = await ScholarshipService.get(institution.institutionId, scholarshipId);
    return jsonSuccess({ scholarship });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/scholarships/[scholarshipId]">,
) {
  try {
    assertSameOrigin(request);
    const { scholarshipId } = await context.params;
    const { user, institution } = await requireInstitution();
    const input = updateScholarshipSchema.parse(await request.json().catch(() => ({})));

    const scholarship = await ScholarshipService.update(
      institution.institutionId,
      scholarshipId,
      input,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ scholarship });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/scholarships/[scholarshipId]">,
) {
  try {
    assertSameOrigin(request);
    const { scholarshipId } = await context.params;
    const { user, institution } = await requireInstitution();

    await ScholarshipService.remove(institution.institutionId, scholarshipId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
