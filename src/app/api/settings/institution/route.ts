import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateProfileSchema } from "@/lib/validation/institution";
import { InstitutionService } from "@/services/institution.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** Full profile self-service for institution admins: read, and section-scoped writes. */
export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const { profile, completion } = await InstitutionService.getProfile(institution.institutionId);
    return jsonSuccess({ profile, completion });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const patch = updateProfileSchema.parse(await request.json().catch(() => ({})));

    await InstitutionService.updateProfile(institution.institutionId, patch, {
      id: user.id,
      name: user.name,
    });

    // Re-fetched so the response's completion reflects the write just made.
    const { profile, completion } = await InstitutionService.getProfile(institution.institutionId);
    return jsonSuccess({ profile, completion });
  } catch (error) {
    return handleApiError(error);
  }
}
