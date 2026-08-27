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

    // `institution.institutionId` — the tenant — comes from the session
    // (`requireInstitution`), never from `input`. But `institutionId` is NOT
    // why this parse matters: `AchievementService.create` re-assigns it after
    // the object spread (`{ ...input, institutionId, status: "ACTIVE" }`),
    // so a smuggled `institutionId` is neutralised at the service regardless
    // of whether this route parses at all — verified by mutation (fix round
    // 1's report). What this parse actually guards are the fields the
    // service does NOT re-assign: `photos` and `certificates` (real schema
    // paths `create` would otherwise spread straight onto the document,
    // planting storage keys that bypass the upload endpoint's magic-byte
    // checks, size/kind caps and rollback machinery) and `_id` (also a real
    // Mongoose path with no re-assignment — an attacker-chosen id on a fresh
    // document; a deliberate collision surfaces as 409 through
    // `handleApiError`'s `code 11000` branch, not corruption, but keeping an
    // id out of the body at all is still this parse's job). None of the
    // three appear in `achievementCreateSchema`, so `.parse()` strips them
    // before any of this runs.
    const achievement = await AchievementService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ achievement });
  } catch (error) {
    return handleApiError(error);
  }
}
