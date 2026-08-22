import type { NextRequest } from "next/server";
import { requireUser, tenantFilter } from "@/lib/tenant";
import { updateLeadSchema } from "@/lib/validation/lead";
import { LeadService } from "@/services/lead.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: RouteContext<"/api/leads/[id]">) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const lead = await LeadService.getById(tenantFilter(user), id);
    return jsonSuccess({ lead });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext<"/api/leads/[id]">) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const patch = updateLeadSchema.parse(body);

    if (!patch.status) throw validationError("status: only status changes are supported");

    const lead = await LeadService.updateStatus({
      tenantClause: tenantFilter(user),
      id,
      status: patch.status,
      actor: { id: user.id, name: user.name },
    });

    return jsonSuccess({ lead });
  } catch (error) {
    return handleApiError(error);
  }
}
