import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { createNoteSchema } from "@/lib/validation/note";
import { LeadService } from "@/services/lead.service";
import { NoteService } from "@/services/note.service";
import { ActivityService } from "@/services/activity.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext<"/api/leads/[id]/notes">) {
  try {
    const { user } = await requireApiUser(request);
    const { id } = await context.params;
    const lead = await LeadService.getById(tenantFilter(user), id);
    const notes = await NoteService.list(lead.institutionId, "LEAD", lead.id);
    return jsonSuccess({ notes });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext<"/api/leads/[id]/notes">) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const { note } = createNoteSchema.parse(body);

    // Resolving through the service enforces the tenant clause before writing.
    const lead = await LeadService.getById(tenantFilter(user), id);

    const created = await NoteService.create({
      institutionId: lead.institutionId,
      entityType: "LEAD",
      entityId: lead.id,
      note,
      createdBy: user.id,
      createdByName: user.name,
    });

    await ActivityService.record({
      institutionId: lead.institutionId,
      entityType: "LEAD",
      entityId: lead.id,
      entityRef: lead.leadNumber,
      action: "Note added",
      performedBy: user.id,
      performedByName: user.name,
    });

    return jsonSuccess({ note: created }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
