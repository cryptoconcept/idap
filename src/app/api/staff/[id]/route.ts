import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireInstitution } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { StaffService } from "@/services/staff.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

const patchStaffSchema = z.object({ active: z.boolean() });

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/staff/[id]">,
) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    requirePermission(user, "STAFF_MANAGE");
    const { id } = await context.params;
    const { active } = patchStaffSchema.parse(await request.json().catch(() => ({})));

    const staff = await StaffService.setActive(institution.institutionId, id, active);
    return jsonSuccess({ staff });
  } catch (error) {
    return handleApiError(error);
  }
}
