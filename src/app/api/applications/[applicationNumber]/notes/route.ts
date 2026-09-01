import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { createNoteSchema } from "@/lib/validation/note";
import { ApplicationService } from "@/services/application.service";
import { NoteService } from "@/services/note.service";
import { ActivityService } from "@/services/activity.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/applications/[applicationNumber]/notes">,
) {
  try {
    const { user } = await requireApiUser(request);
    requirePermission(user, "APPLICATIONS_VIEW");
    const { applicationNumber } = await context.params;
    const application = await ApplicationService.getApplication(
      tenantFilter(user),
      applicationNumber,
    );
    const notes = await NoteService.list(application.institutionId, "APPLICATION", application.id);
    return jsonSuccess({ notes });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/applications/[applicationNumber]/notes">,
) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    requirePermission(user, "APPLICATIONS_CREATE");
    const { applicationNumber } = await context.params;
    const body = await request.json().catch(() => ({}));
    const { note } = createNoteSchema.parse(body);

    const application = await ApplicationService.getApplication(
      tenantFilter(user),
      applicationNumber,
    );

    const created = await NoteService.create({
      institutionId: application.institutionId,
      entityType: "APPLICATION",
      entityId: application.id,
      note,
      createdBy: user.id,
      createdByName: user.name,
    });

    await ActivityService.record({
      institutionId: application.institutionId,
      entityType: "APPLICATION",
      entityId: application.id,
      entityRef: application.applicationNumber,
      action: "Note added",
      performedBy: user.id,
      performedByName: user.name,
    });

    return jsonSuccess({ note: created }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
