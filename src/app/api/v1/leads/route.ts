import type { NextRequest } from "next/server";
import { withApiClient, corsPreflight } from "@/lib/api/v1-handler";
import { createLeadSchema } from "@/lib/validation/lead";
import { LeadService } from "@/services/lead.service";
import { jsonSuccess } from "@/lib/api/response";
import { getClientIp } from "@/lib/security/request";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/leads
 * Creates an admission enquiry. The institution is derived from the API
 * credential, never from the request body.
 */
export async function POST(request: NextRequest) {
  return withApiClient(request, "CREATE_LEAD", async (auth) => {
    const body = await request.json().catch(() => ({}));
    const data = createLeadSchema.parse(body);

    const lead = await LeadService.createLead({
      institutionId: auth.institutionId,
      data,
      source: "API",
      actor: { name: `API: ${auth.clientName}` },
      ipAddress: getClientIp(request),
    });

    return jsonSuccess(
      {
        leadNumber: lead.leadNumber,
        message: "Enquiry submitted successfully",
      },
      { status: 201 },
    );
  });
}

export async function OPTIONS() {
  return corsPreflight();
}
