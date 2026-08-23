import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { InstitutionService } from "@/services/institution.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** Removes one gallery image from the institution admin's own profile. */
export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/institution/media/[mediaId]">,
) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const { mediaId } = await context.params;

    const profile = await InstitutionService.removeGalleryItem(institution.institutionId, mediaId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ profile });
  } catch (error) {
    return handleApiError(error);
  }
}
