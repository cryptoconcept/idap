import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireInstitution } from "@/lib/tenant";
import { AchievementService } from "@/services/achievement.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";
import { MAX_IMAGE_BYTES } from "@/lib/media/image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The two asset kinds `AchievementService` accepts, matching
 * `AchievementAssetKind` exactly. A form field, not a route segment — one
 * multipart route serves both, same shape `mediaUploadSchema`'s `kind` uses
 * to route between `addMediaImage`/`addMediaDocument`.
 */
const assetKindSchema = z.enum(["PHOTO", "CERTIFICATE"]);

const removeAssetSchema = z.object({
  kind: assetKindSchema,
  key: z.string().trim().min(1, "key is required"),
});

/**
 * Multipart upload of one photo or certificate onto one of the caller's own
 * achievements, selected by the form's `kind` field. `AchievementService`
 * does the real proof that the bytes are what they claim to be (magic-byte
 * sniffing for both kinds) — the size pre-check here for PHOTO only avoids
 * reading an oversized file into memory before rejecting it, mirroring
 * `settings/institution/media/route.ts`'s image branch. CERTIFICATE has no
 * such pre-check, same as that route's document branch: the PDF size cap is
 * `addCertificate`'s alone to enforce.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/settings/achievements/[achievementId]/assets">,
) {
  try {
    assertSameOrigin(request);
    const { achievementId } = await context.params;
    const { user, institution } = await requireInstitution();

    const form = await request.formData();
    const kind = assetKindSchema.parse(form.get("kind"));
    const file = form.get("file");
    if (!(file instanceof File)) throw validationError("file: choose a file to upload");
    if (file.size <= 0) throw validationError("file: the file is empty");
    if (kind === "PHOTO" && file.size > MAX_IMAGE_BYTES) {
      throw validationError("file: files must be 5 MB or smaller");
    }

    const actor = { id: user.id, name: user.name };
    const asset = { contentType: file.type, bytes: Buffer.from(await file.arrayBuffer()) };

    const achievement =
      kind === "PHOTO"
        ? await AchievementService.addPhoto(institution.institutionId, achievementId, asset, actor)
        : await AchievementService.addCertificate(
            institution.institutionId,
            achievementId,
            asset,
            actor,
          );

    return jsonSuccess({ achievement });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Drops one photo or certificate from one of the caller's own achievements. */
export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/achievements/[achievementId]/assets">,
) {
  try {
    assertSameOrigin(request);
    const { achievementId } = await context.params;
    const { user, institution } = await requireInstitution();
    const input = removeAssetSchema.parse(await request.json().catch(() => ({})));

    const achievement = await AchievementService.removeAsset(
      institution.institutionId,
      achievementId,
      input,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ achievement });
  } catch (error) {
    return handleApiError(error);
  }
}
