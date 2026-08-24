import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { assignLeadSchema } from "@/lib/validation/lead";
import { LeadService } from "@/services/lead.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/leads/[id]/assign">,
) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    requirePermission(user, "LEADS_ASSIGN");
    const { id } = await context.params;

    const body = await request.json().catch(() => ({}));
    const { assignedTo } = assignLeadSchema.parse(body);

    const lead = await LeadService.assign({
      tenantClause: tenantFilter(user),
      id,
      assignedTo,
      actor: { id: user.id, name: user.name },
    });

    return jsonSuccess({ lead });
  } catch (error) {
    return handleApiError(error);
  }
}
