import "server-only";
import { connectToDatabase } from "@/lib/db/mongoose";
import { ApiClient, Application, Institution, Lead, User } from "@/models";
import type { DashboardStats } from "@/lib/types";
import { toIso } from "@/lib/utils/serialize";
import { InstitutionService } from "./institution.service";

export const DashboardService = {
  async getStats(
    tenantClause: Record<string, unknown>,
    leadVisibility: Record<string, unknown> = {},
  ): Promise<DashboardStats> {
    await connectToDatabase();

    // `tenantFilter()` always hands back `{ institutionId }` for a tenant user
    // (it throws for SUPER_ADMIN before this is ever called with anything
    // else), so the institution id is always present and always a string here.
    const institutionId = tenantClause.institutionId as string;
    const activeCredentialClause = { ...tenantClause, active: true };

    const [leadCounts, applicationCounts, { profile, completion }, activeCredentials, mostRecentlyUsed] =
      await Promise.all([
        Lead.aggregate<{ _id: string; count: number }>([
          { $match: { ...tenantClause, ...leadVisibility } },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ]),
        Application.aggregate<{ _id: string; count: number }>([
          { $match: tenantClause },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ]),
        InstitutionService.getProfile(institutionId),
        ApiClient.countDocuments(activeCredentialClause),
        ApiClient.findOne(activeCredentialClause)
          .sort({ lastUsedAt: -1 })
          .select("lastUsedAt")
          .lean(),
      ]);

    const leadByStatus = new Map(leadCounts.map((row) => [row._id, row.count]));
    const applicationByStatus = new Map(applicationCounts.map((row) => [row._id, row.count]));
    const sum = (map: Map<string, number>) =>
      [...map.values()].reduce((total, value) => total + value, 0);

    return {
      totalEnquiries: sum(leadByStatus),
      newEnquiries: leadByStatus.get("NEW") ?? 0,
      totalApplications: sum(applicationByStatus),
      underReview: applicationByStatus.get("UNDER_REVIEW") ?? 0,
      approved: applicationByStatus.get("APPROVED") ?? 0,
      admitted: leadByStatus.get("ADMITTED") ?? 0,
      profile: { status: profile.profileStatus, completionPercent: completion.percent },
      integration: {
        activeCredentials,
        lastUsedAt: toIso(mostRecentlyUsed?.lastUsedAt),
      },
    };
  },

  /**
   * Provisioning-only figures for the platform admin. Deliberately counts
   * institutions and their accounts, never enquiries or applications: the
   * platform operator has no window into what tenants receive, not even an
   * aggregate one.
   */
  async getPlatformStats() {
    await connectToDatabase();
    const [institutions, activeInstitutions, institutionAdmins, apiClients] = await Promise.all([
      Institution.countDocuments({}),
      Institution.countDocuments({ active: true }),
      User.countDocuments({ role: "INSTITUTION_ADMIN" }),
      ApiClient.countDocuments({ active: true, revokedAt: { $exists: false } }),
    ]);
    return { institutions, activeInstitutions, institutionAdmins, apiClients };
  },

};
