import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { createStaffSchema } from "@/lib/validation/staff";
import { StaffService } from "@/services/staff.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { user, institution } = await requireInstitution();
    requirePermission(user, "STAFF_MANAGE");
    const staff = await StaffService.list(institution.institutionId);
    return jsonSuccess({ staff });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    requirePermission(user, "STAFF_MANAGE");
    const input = createStaffSchema.parse(await request.json().catch(() => ({})));

    const staff = await StaffService.create(institution.institutionId, input);
    return jsonSuccess({ staff }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
