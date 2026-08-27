import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { mediaItemPatchSchema } from "@/lib/validation/institution";
import { InstitutionService } from "@/services/institution.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** Removes one media image from the institution admin's own profile. */
export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/institution/media/[mediaId]">,
) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const { mediaId } = await context.params;

    const profile = await InstitutionService.removeMediaItem(institution.institutionId, mediaId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ profile });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Edits one media item — title, caption, order, and the ACTIVE/HIDDEN
 * flag the public projection filters on. Hiding is how an image leaves the
 * public profile without leaving the media library.
 */
export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/institution/media/[mediaId]">,
) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const { mediaId } = await context.params;
    const patch = mediaItemPatchSchema.parse(await request.json().catch(() => ({})));

    const profile = await InstitutionService.updateMediaItem(
      institution.institutionId,
      mediaId,
      patch,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ profile });
  } catch (error) {
    return handleApiError(error);
  }
}
