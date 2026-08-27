import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { videoLinkSchema } from "@/lib/validation/institution";
import { InstitutionService } from "@/services/institution.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** Adds a YouTube or Vimeo link to the institution admin's own media library. No bytes are ever stored. */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const parsed = videoLinkSchema.parse(await request.json().catch(() => ({})));

    const profile = await InstitutionService.addMediaVideo(
      institution.institutionId,
      { url: parsed.url, title: parsed.title, caption: parsed.caption },
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ profile });
  } catch (error) {
    return handleApiError(error);
  }
}
