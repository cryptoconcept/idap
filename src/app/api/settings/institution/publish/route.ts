import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { InstitutionService } from "@/services/institution.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/**
 * One explicit endpoint for both directions of publication — mirrors the
 * codebase's preference for a small number of explicit routes over a
 * generic status PATCH.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const body = await request.json().catch(() => ({}));
    const action = (body as { action?: unknown }).action;
    if (action !== "publish" && action !== "unpublish") {
      throw validationError("action: choose publish or unpublish");
    }

    const profile = await InstitutionService.setProfileStatus(
      institution.institutionId,
      action === "publish" ? "PUBLISHED" : "DRAFT",
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ profile });
  } catch (error) {
    return handleApiError(error);
  }
}
