import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { assertSameOrigin } from "@/lib/api/csrf";
import { updateScholarshipApplicationReviewStatusSchema } from "@/lib/validation/scholarship-application";
import { ScholarshipApplicationService } from "@/services/scholarship-application.service";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/scholarship-applications/[id]">,
) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    requirePermission(user, "SCHOLARSHIP_APPLICATIONS_DECIDE");
    const { id } = await context.params;

    const body = await request.json().catch(() => ({}));
    const { reviewStatus } = updateScholarshipApplicationReviewStatusSchema.parse(body);

    const scholarshipApplication = await ScholarshipApplicationService.updateReviewStatus({
      tenantClause: tenantFilter(user),
      id,
      reviewStatus,
      actor: { id: user.id, name: user.name },
    });

    return jsonSuccess({ scholarshipApplication });
  } catch (error) {
    return handleApiError(error);
  }
}
