import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { assertSameOrigin } from "@/lib/api/csrf";
import { assignScholarshipApplicationSchema } from "@/lib/validation/scholarship-application";
import { ScholarshipApplicationService } from "@/services/scholarship-application.service";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/scholarship-applications/[id]/assign">,
) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    requirePermission(user, "SCHOLARSHIP_APPLICATIONS_ASSIGN");
    const { id } = await context.params;

    const body = await request.json().catch(() => ({}));
    const { assignedTo } = assignScholarshipApplicationSchema.parse(body);

    const scholarshipApplication = await ScholarshipApplicationService.assign({
      tenantClause: tenantFilter(user),
      id,
      assignedTo,
      actor: { id: user.id, name: user.name },
    });

    return jsonSuccess({ scholarshipApplication });
  } catch (error) {
    return handleApiError(error);
  }
}
