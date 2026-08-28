import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { vacancyPatchSchema } from "@/lib/validation/vacancy";
import { VacancyService } from "@/services/vacancy.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/vacancies/[vacancyId]">,
) {
  try {
    assertSameOrigin(request);
    const { vacancyId } = await context.params;
    const { user, institution } = await requireInstitution();
    const patch = vacancyPatchSchema.parse(await request.json().catch(() => ({})));

    // `patch` is forwarded exactly as parsed — an explicit `null` on
    // `salaryMin`/`salaryMax`/`experienceRequired` must survive to
    // `VacancyService.update` intact, since that is the documented way to
    // clear any of the three. Do not filter, spread-and-rebuild, or
    // otherwise touch this object between the parse and the call: any of
    // that risks dropping `null` and silently turning "clear this field"
    // into "leave it alone".
    const vacancy = await VacancyService.update(
      institution.institutionId,
      vacancyId,
      patch,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ vacancy });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/vacancies/[vacancyId]">,
) {
  try {
    assertSameOrigin(request);
    const { vacancyId } = await context.params;
    const { user, institution } = await requireInstitution();

    await VacancyService.remove(institution.institutionId, vacancyId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
