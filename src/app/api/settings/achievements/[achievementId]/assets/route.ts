import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireInstitution } from "@/lib/tenant";
import { AchievementService } from "@/services/achievement.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";
import { SHOWCASE_MAX_PDF_BYTES } from "@/lib/constants";
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

/**
 * The upload form's only non-file field. Wrapped in an object (rather than
 * `assetKindSchema.parse(form.get("kind"))` directly) so a bad or absent
 * `kind` reports a field-scoped `kind: ...` message through
 * `handleApiError`'s `firstZodMessage`, the same as every other parse in
 * this codebase — a bare value's ZodError has no path to report and would
 * read as `(root): ...` instead.
 */
const uploadKindSchema = z.object({ kind: assetKindSchema });

const removeAssetSchema = z.object({
  kind: assetKindSchema,
  key: z.string().trim().min(1, "key is required"),
});

/**
 * Multipart upload of one photo or certificate onto one of the caller's own
 * achievements, selected by the form's `kind` field. Deciding whether the
 * bytes are what they claim to be is `AchievementService`'s alone to make
 * (`validateImage` for PHOTO, `addCertificate`'s `%PDF-` header check for
 * CERTIFICATE) — this route never sniffs content.
 *
 * The `file.size` bound below shares its numbers with those two, and is still
 * not a duplicate of them. `request.formData()` has already materialised the
 * body by this point and `arrayBuffer()` copies it a second time, so a check
 * that runs inside the service — after the bytes exist — can refuse an
 * oversize upload but cannot stop the memory from being spent. Only a check
 * placed here, before `arrayBuffer()`, bounds what this handler allocates: a
 * 300 MB post would otherwise hold ~600 MB and OOM the function rather than
 * 400. Same ordering both pre-existing upload routes use
 * (`institution/media/route.ts`, the toppers photo route), and the reason the
 * constants are imported rather than re-declared: one number, two jobs.
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
    const { kind } = uploadKindSchema.parse({ kind: form.get("kind") });
    const file = form.get("file");
    if (!(file instanceof File)) throw validationError("file: choose a file to upload");
    // Redundant for PHOTO — `validateImage` inside `addPhoto` throws this
    // exact message for a zero-byte file on its own — but load-bearing for
    // CERTIFICATE: an empty file there never reaches an emptiness check at
    // all, only the `%PDF-` magic comparison, which reports "that file is
    // not a PDF" — true, but the wrong diagnosis for an admin whose real
    // problem is a zero-byte export. This guard is the only thing on that
    // path that reports the accurate cause; do not delete it as dead code
    // just because the PHOTO branch never needs it.
    if (file.size <= 0) throw validationError("file: the file is empty");
    // Before `arrayBuffer()`, deliberately — see this route's header comment.
    // Per kind, because the two kinds' caps are genuinely different numbers.
    const maxBytes = kind === "PHOTO" ? MAX_IMAGE_BYTES : SHOWCASE_MAX_PDF_BYTES;
    if (file.size > maxBytes) {
      throw validationError(
        `file: files must be ${Math.floor(maxBytes / (1024 * 1024))} MB or smaller`,
      );
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
