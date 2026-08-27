import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { alumnusPatchSchema } from "@/lib/validation/showcase";
import { AlumniService } from "@/services/alumni.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/alumni/[alumnusId]">,
) {
  try {
    assertSameOrigin(request);
    const { alumnusId } = await context.params;
    const { user, institution } = await requireInstitution();
    const patch = alumnusPatchSchema.parse(await request.json().catch(() => ({})));

    // `patch` is forwarded exactly as parsed — an explicit `null` on
    // `batch`/`currentRole`/`org`/`note` must survive to
    // `AlumniService.update` intact, since that is the documented way to
    // clear any of the four. Do not filter, spread-and-rebuild, or otherwise
    // touch this object between the parse and the call: any of those risks
    // dropping `null` and silently turning "clear this field" into "leave it
    // alone".
    const alumnus = await AlumniService.update(
      institution.institutionId,
      alumnusId,
      patch,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ alumnus });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/alumni/[alumnusId]">,
) {
  try {
    assertSameOrigin(request);
    const { alumnusId } = await context.params;
    const { user, institution } = await requireInstitution();

    await AlumniService.remove(institution.institutionId, alumnusId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
