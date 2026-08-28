import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { vacancyCreateSchema } from "@/lib/validation/vacancy";
import { VacancyService } from "@/services/vacancy.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const vacancies = await VacancyService.list(institution.institutionId);
    return jsonSuccess({ vacancies });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = vacancyCreateSchema.parse(await request.json().catch(() => ({})));

    // `institution.institutionId` — the tenant — comes from the session
    // (`requireInstitution`), never from `input`. But `institutionId` is NOT
    // why this parse matters: `VacancyService.create` re-assigns it after
    // the object spread (`{ ...input, institutionId }`), so a smuggled
    // `institutionId` is neutralised at the service regardless of whether
    // this route parses at all. What this parse is the SOLE stop for is
    // every real Mongoose path `create` does NOT re-assign and
    // `vacancyCreateSchema` does NOT declare: `_id` (a caller-chosen
    // document id), `createdAt` (which `list` sorts by, `{ createdAt: -1 }`
    // — a smuggled value could pin a vacancy to the top of every listing),
    // and `status` — a Mongoose `default` only fills in when the path is
    // ABSENT, and `create` never re-assigns `status` the way
    // `AchievementService.create` re-assigns it (`{ ...input, institutionId,
    // status: "ACTIVE" }`), so without this parse a smuggled `status:
    // "OPEN"` would persist exactly as sent, skipping the DRAFT review step
    // that exists to stop a half-written advert going live.
    const vacancy = await VacancyService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ vacancy });
  } catch (error) {
    return handleApiError(error);
  }
}
