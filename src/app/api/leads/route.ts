import type { NextRequest } from "next/server";
import { requireUser, tenantFilter } from "@/lib/tenant";
import { leadQuerySchema, createLeadSchema } from "@/lib/validation/lead";
import { LeadService } from "@/services/lead.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { getClientIp } from "@/lib/security/request";
import { forbidden } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const query = leadQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const clause = tenantFilter(user);

    const result = await LeadService.list(clause, query);
    return jsonSuccess({ ...result });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Manual enquiry entry from the dashboard. */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    if (!user.institutionId) {
      throw forbidden("Select an institution before adding an enquiry");
    }

    const body = await request.json().catch(() => ({}));
    const data = createLeadSchema.parse(body);

    const lead = await LeadService.createLead({
      institutionId: user.institutionId,
      data,
      source: "MANUAL",
      actor: { id: user.id, name: user.name },
      ipAddress: getClientIp(request),
    });

    return jsonSuccess({ lead }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
