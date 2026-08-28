import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { AlumniService } from "@/services/alumni.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";
import { MAX_IMAGE_BYTES } from "@/lib/media/image";

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
 * Deciding whether the bytes are a real image is `setPhoto`'s alone to make,
 * via `validateImage` — this route never sniffs content.
 *
 * The `file.size` bound below is not a duplicate of that decision even though
 * it shares `validateImage`'s number. `request.formData()` has already
 * materialised the body by this point, and `arrayBuffer()` copies it a second
 * time; `validateImage` only runs once that second copy exists, so it can
 * refuse an oversize upload but it cannot stop the memory from being spent.
 * Only a check placed here, before `arrayBuffer()`, bounds what this handler
 * allocates — a 300 MB post would otherwise hold ~600 MB and OOM the function
 * rather than 400. Same ordering both pre-existing upload routes use
 * (`institution/media/route.ts`, the toppers photo route), and the reason the
 * constant is imported rather than re-declared: one number, two jobs.
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
    // Before `arrayBuffer()`, deliberately — see this route's header comment.
    if (file.size > MAX_IMAGE_BYTES) throw validationError("file: files must be 5 MB or smaller");

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
