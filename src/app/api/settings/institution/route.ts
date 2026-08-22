import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateInstitutionProfileSchema } from "@/lib/validation/institution";
import { InstitutionService } from "@/services/institution.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** Branding self-service for institution admins. */
export async function PATCH(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const body = await request.json().catch(() => ({}));
    const patch = updateInstitutionProfileSchema.parse(body);

    const updated = await InstitutionService.update(institution.institutionId, patch, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ institution: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
