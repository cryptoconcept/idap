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

/**
 * Multipart upload for the institution admin's own profile: an image (logo,
 * cover, or a MEDIA gallery image) by default, or — when `target=MEDIA` and
 * `kind` is `BROCHURE`/`PROSPECTUS` — a PDF document.
 *
 * `kind` is parsed against `mediaUploadSchema`'s three-value enum (the fourth,
 * out-of-enum case is a plain 400 from that parse), then the branch below
 * only forwards to `addMediaDocument` once `kind` has been narrowed to
 * exactly `"BROCHURE" | "PROSPECTUS"` — `IMAGE` and the `undefined` default
 * both fall through to the image path, never a cast into the document one.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw validationError("file: choose a file to upload");
    if (file.size <= 0) throw validationError("file: the file is empty");

    const parsed = mediaUploadSchema.parse({
      target: form.get("target"),
      kind: form.get("kind") ?? undefined,
      title: form.get("title") ?? undefined,
      caption: form.get("caption") ?? undefined,
    });

    if (parsed.target === "MEDIA" && parsed.kind && parsed.kind !== "IMAGE") {
      const profile = await InstitutionService.addMediaDocument(
        institution.institutionId,
        {
          kind: parsed.kind,
          fileName: file.name,
          contentType: file.type,
          bytes: Buffer.from(await file.arrayBuffer()),
          title: parsed.title,
          caption: parsed.caption,
        },
        { id: user.id, name: user.name },
      );

      return jsonSuccess({ profile });
    }

    if (file.size > MAX_IMAGE_BYTES) throw validationError("file: files must be 5 MB or smaller");

    const profile = await InstitutionService.addMediaImage(
      institution.institutionId,
      {
        target: parsed.target,
        fileName: file.name,
        contentType: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
        title: parsed.title,
        caption: parsed.caption,
      },
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ profile });
  } catch (error) {
    return handleApiError(error);
  }
}
