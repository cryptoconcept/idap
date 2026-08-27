import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { AlumniService } from "@/services/alumni.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Multipart photo upload for one of the caller's own alumni. There is no
 * DELETE here: an alumnus has exactly one photo and no standalone "clear the
 * photo" method — `AlumniService.setPhoto` already owns cleaning up whatever
 * it replaces, and the only way a photo goes away on its own is the whole
 * record going away through `DELETE /api/settings/alumni/[alumnusId]`, which
 * `AlumniService.remove` already handles.
 *
 * Every real check on the upload itself — magic-byte sniffing, the
 * non-empty check, and the 5 MB cap — is `setPhoto`'s alone to make, via
 * `validateImage`. This route does not duplicate any of them: unlike the
 * achievements sibling, an alumnus has no certificate/PDF path, so there is
 * no branch here where a route-level pre-check would catch something
 * `validateImage` doesn't already catch identically — it would be dead code,
 * and a test written for it would be confounded by construction. The one
 * thing this route checks before spending an `arrayBuffer()` read is that a
 * file was actually chosen.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/settings/alumni/[alumnusId]/photo">,
) {
  try {
    assertSameOrigin(request);
    const { alumnusId } = await context.params;
    const { user, institution } = await requireInstitution();

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw validationError("file: choose a file to upload");

    const alumnus = await AlumniService.setPhoto(
      institution.institutionId,
      alumnusId,
      { contentType: file.type, bytes: Buffer.from(await file.arrayBuffer()) },
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ alumnus });
  } catch (error) {
    return handleApiError(error);
  }
}
