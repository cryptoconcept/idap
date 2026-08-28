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
    // this route parses at all. `status` is likewise safe without this parse
    // — it is absent from `vacancyCreateSchema` and the service never
    // re-assigns it either; a fresh vacancy simply gets the model's own
    // `"DRAFT"` default. What this parse actually guards is `_id`: a real
    // Mongoose path with no re-assignment anywhere in `create` — without
    // `.parse()` a caller-chosen `_id` in the body would flow straight into
    // `Vacancy.create` and become the document's actual id.
    const vacancy = await VacancyService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ vacancy });
  } catch (error) {
    return handleApiError(error);
  }
}
