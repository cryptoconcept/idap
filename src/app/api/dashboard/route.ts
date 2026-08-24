import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { leadVisibilityFilter } from "@/lib/tenant/permissions";
import { DashboardService } from "@/services/dashboard.service";
import { LeadService } from "@/services/lead.service";
import { ApplicationService } from "@/services/application.service";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { user } = await requireApiUser(request);
    const clause = tenantFilter(user);
    const leadVisibility = { ...clause, ...leadVisibilityFilter(user) };

    const [stats, recentLeads, recentApplications] = await Promise.all([
      DashboardService.getStats(clause),
      LeadService.recent(leadVisibility, 5),
      ApplicationService.recent(clause, 5),
    ]);

    return jsonSuccess({ stats, recentLeads, recentApplications });
  } catch (error) {
    return handleApiError(error);
  }
}
