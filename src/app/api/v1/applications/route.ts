import type { NextRequest } from "next/server";
import { withApiClient, corsPreflight } from "@/lib/api/v1-handler";
import { createApplicationSchema } from "@/lib/validation/application";
import { ApplicationService } from "@/services/application.service";
import { jsonSuccess } from "@/lib/api/response";
import { getClientIp } from "@/lib/security/request";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/applications
 * Creates an admission application for the institution that owns the API key.
 */
export async function POST(request: NextRequest) {
  return withApiClient(request, "CREATE_APPLICATION", async (auth) => {
    const body = await request.json().catch(() => ({}));
    const data = createApplicationSchema.parse(body);

    const application = await ApplicationService.createApplication({
      institutionId: auth.institutionId,
      data,
      source: "API",
      actor: { name: `API: ${auth.clientName}` },
      ipAddress: getClientIp(request),
    });

    return jsonSuccess(
      {
        applicationNumber: application.applicationNumber,
        status: application.status,
      },
      { status: 201 },
    );
  });
}

export async function OPTIONS() {
  return corsPreflight();
}
