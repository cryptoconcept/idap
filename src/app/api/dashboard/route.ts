import { requireUser, tenantFilter } from "@/lib/tenant";
import { DashboardService } from "@/services/dashboard.service";
import { LeadService } from "@/services/lead.service";
import { ApplicationService } from "@/services/application.service";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const clause = tenantFilter(user);

    const [stats, recentLeads, recentApplications] = await Promise.all([
      DashboardService.getStats(clause),
      LeadService.recent(clause, 5),
      ApplicationService.recent(clause, 5),
    ]);

    return jsonSuccess({ stats, recentLeads, recentApplications });
  } catch (error) {
    return handleApiError(error);
  }
}
