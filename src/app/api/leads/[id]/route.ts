import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { leadVisibilityFilter, requirePermission } from "@/lib/tenant/permissions";
import { updateLeadSchema } from "@/lib/validation/lead";
import { LeadService } from "@/services/lead.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext<"/api/leads/[id]">) {
  try {
    const { user } = await requireApiUser(request);
    const { id } = await context.params;
    const lead = await LeadService.getById(
      { ...tenantFilter(user), ...leadVisibilityFilter(user) },
      id,
    );
    return jsonSuccess({ lead });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext<"/api/leads/[id]">) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const patch = updateLeadSchema.parse(body);

    if (patch.followUpAt !== undefined && patch.status !== undefined) {
      throw validationError("Cannot update status and followUpAt in the same request");
    }

    if (patch.followUpAt !== undefined) {
      requirePermission(user, "LEADS_SET_FOLLOWUP");
      const lead = await LeadService.setFollowUp({
        tenantClause: tenantFilter(user),
        id,
        followUpAt: patch.followUpAt,
        user,
      });
      return jsonSuccess({ lead });
    }

    if (!patch.status) throw validationError("status: only status or followUpAt changes are supported");
    requirePermission(user, "LEADS_UPDATE");

    const lead = await LeadService.updateStatus({
      tenantClause: tenantFilter(user),
      id,
      status: patch.status,
      user,
    });

    return jsonSuccess({ lead });
  } catch (error) {
    return handleApiError(error);
  }
}
