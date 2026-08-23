import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { mediaUploadSchema } from "@/lib/validation/institution";
import { InstitutionService } from "@/services/institution.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Multipart image upload (logo, cover, or a gallery item) for the institution admin's own profile. */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw validationError("file: choose a file to upload");
    if (file.size <= 0) throw validationError("file: the file is empty");
    if (file.size > MAX_IMAGE_BYTES) throw validationError("file: files must be 5 MB or smaller");

    const parsed = mediaUploadSchema.parse({
      kind: form.get("kind"),
      title: form.get("title") ?? undefined,
      description: form.get("description") ?? undefined,
    });

    const profile = await InstitutionService.addMedia(
      institution.institutionId,
      {
        kind: parsed.kind,
        fileName: file.name,
        contentType: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
        title: parsed.title,
        description: parsed.description,
      },
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ profile });
  } catch (error) {
    return handleApiError(error);
  }
}
