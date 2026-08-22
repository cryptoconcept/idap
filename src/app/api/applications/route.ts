import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { applicationQuerySchema, createApplicationSchema } from "@/lib/validation/application";
import { ApplicationService } from "@/services/application.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { getClientIp } from "@/lib/security/request";
import { forbidden } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { user } = await requireApiUser(request);
    const query = applicationQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const clause = tenantFilter(user);

    const result = await ApplicationService.list(clause, query);
    return jsonSuccess({ ...result });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Manual application entry from the dashboard. */
export async function POST(request: NextRequest) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    if (!user.institutionId) {
      throw forbidden("Select an institution before adding an application");
    }

    const body = await request.json().catch(() => ({}));
    const data = createApplicationSchema.parse(body);

    const application = await ApplicationService.createApplication({
      institutionId: user.institutionId,
      data,
      source: "MANUAL",
      actor: { id: user.id, name: user.name },
      ipAddress: getClientIp(request),
    });

    return jsonSuccess({ application }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
