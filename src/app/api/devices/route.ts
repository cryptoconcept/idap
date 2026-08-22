import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { registerDeviceSchema } from "@/lib/validation/device";
import { DeviceService } from "@/services/device.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });

    // Derives the tenant from the session, and refuses a platform admin.
    const clause = tenantFilter(user);

    const body = await request.json().catch(() => ({}));
    const data = registerDeviceSchema.parse(body);

    const device = await DeviceService.register({
      userId: user.id,
      institutionId: clause.institutionId,
      pushToken: data.pushToken,
      platform: data.platform,
    });

    return jsonSuccess({ device }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
