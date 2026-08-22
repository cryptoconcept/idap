import type { NextRequest } from "next/server";
import { requireUser, tenantFilter } from "@/lib/tenant";
import { updateApplicationStatusSchema } from "@/lib/validation/application";
import { ApplicationService } from "@/services/application.service";
import { NoteService } from "@/services/note.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/applications/[applicationNumber]">,
) {
  try {
    const user = await requireUser();
    const { applicationNumber } = await context.params;
    const application = await ApplicationService.getApplication(
      tenantFilter(user),
      applicationNumber,
    );
    return jsonSuccess({ application });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/applications/[applicationNumber]">,
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { applicationNumber } = await context.params;
    const body = await request.json().catch(() => ({}));
    const { status, note } = updateApplicationStatusSchema.parse(body);

    const application = await ApplicationService.updateStatus({
      tenantClause: tenantFilter(user),
      identifier: applicationNumber,
      status,
      actor: { id: user.id, name: user.name },
    });

    if (note) {
      await NoteService.create({
        institutionId: application.institutionId,
        entityType: "APPLICATION",
        entityId: application.id,
        note,
        createdBy: user.id,
        createdByName: user.name,
      });
    }

    return jsonSuccess({ application });
  } catch (error) {
    return handleApiError(error);
  }
}
