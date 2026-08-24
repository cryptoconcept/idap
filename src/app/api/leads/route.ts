import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { requirePermission, leadVisibilityFilter } from "@/lib/tenant/permissions";
import { leadQuerySchema, createLeadSchema } from "@/lib/validation/lead";
import { LeadService } from "@/services/lead.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { getClientIp } from "@/lib/security/request";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { user } = await requireApiUser(request);
    const query = leadQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const clause = { ...tenantFilter(user), ...leadVisibilityFilter(user) };

    const result = await LeadService.list(clause, query);
    return jsonSuccess({ ...result });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Manual enquiry entry from the dashboard. */
export async function POST(request: NextRequest) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    requirePermission(user, "LEADS_CREATE");
    // Through tenantFilter like every other tenant-touching path, rather than
    // reading user.institutionId directly. The platform's isolation story rests
    // on that single function, and these two were the last write paths outside
    // it — a check of their own is an exception that has to be re-argued every
    // time the boundary moves, and it also let a platform admin who happened to
    // carry an institutionId through.
    const clause = tenantFilter(user);

    const body = await request.json().catch(() => ({}));
    const data = createLeadSchema.parse(body);

    const lead = await LeadService.createLead({
      institutionId: clause.institutionId,
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
