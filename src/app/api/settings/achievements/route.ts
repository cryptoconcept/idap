import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { achievementCreateSchema } from "@/lib/validation/showcase";
import { AchievementService } from "@/services/achievement.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const achievements = await AchievementService.list(institution.institutionId);
    return jsonSuccess({ achievements });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = achievementCreateSchema.parse(await request.json().catch(() => ({})));

    // `institution.institutionId` comes from the session (`requireInstitution`),
    // never from `input` — `achievementCreateSchema` has no `institutionId`
    // field to begin with, so a body carrying one is already stripped before
    // it gets here.
    const achievement = await AchievementService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ achievement });
  } catch (error) {
    return handleApiError(error);
  }
}
