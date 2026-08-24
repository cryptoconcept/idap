import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { ResultService } from "@/services/result.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";
import { MAX_IMAGE_BYTES } from "@/lib/media/image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Multipart photo upload for one topper on one of the caller's own results. */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/settings/results/[resultId]/toppers/[topperId]/photo">,
) {
  try {
    assertSameOrigin(request);
    const { resultId, topperId } = await context.params;
    const { user, institution } = await requireInstitution();

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw validationError("file: choose a file to upload");
    if (file.size <= 0) throw validationError("file: the file is empty");
    if (file.size > MAX_IMAGE_BYTES) throw validationError("file: files must be 5 MB or smaller");

    const result = await ResultService.setTopperPhoto(
      institution.institutionId,
      resultId,
      topperId,
      { contentType: file.type, bytes: Buffer.from(await file.arrayBuffer()) },
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ result });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/results/[resultId]/toppers/[topperId]/photo">,
) {
  try {
    assertSameOrigin(request);
    const { resultId, topperId } = await context.params;
    const { user, institution } = await requireInstitution();

    const result = await ResultService.removeTopperPhoto(
      institution.institutionId,
      resultId,
      topperId,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ result });
  } catch (error) {
    return handleApiError(error);
  }
}
