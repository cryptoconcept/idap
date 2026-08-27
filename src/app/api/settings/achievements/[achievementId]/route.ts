import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { achievementPatchSchema } from "@/lib/validation/showcase";
import { AchievementService } from "@/services/achievement.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/achievements/[achievementId]">,
) {
  try {
    assertSameOrigin(request);
    const { achievementId } = await context.params;
    const { user, institution } = await requireInstitution();
    const patch = achievementPatchSchema.parse(await request.json().catch(() => ({})));

    // `patch` is forwarded exactly as parsed — an explicit `null` on
    // `description`/`eventDate` must survive to `AchievementService.update`
    // intact, since that is the documented way to clear either field. Do not
    // filter, spread-and-rebuild, or otherwise touch this object between the
    // parse and the call: any of those risks dropping `null` and silently
    // turning "clear this field" into "leave it alone".
    const achievement = await AchievementService.update(
      institution.institutionId,
      achievementId,
      patch,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ achievement });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/achievements/[achievementId]">,
) {
  try {
    assertSameOrigin(request);
    const { achievementId } = await context.params;
    const { user, institution } = await requireInstitution();

    await AchievementService.remove(institution.institutionId, achievementId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
