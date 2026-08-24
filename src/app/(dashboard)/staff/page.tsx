import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { hasPermission } from "@/lib/tenant/permissions";
import { StaffService } from "@/services/staff.service";
import { StaffListView } from "@/components/staff/staff-list-view";

export const metadata: Metadata = { title: "Staff" };
export const dynamic = "force-dynamic";

/**
 * Manual redirect checks, matching every other dashboard page in this
 * codebase (see profile/page.tsx) — `requireInstitution()` throws rather
 * than redirects, which is right for an API route and wrong for a page.
 * The `hasPermission` check below is new to this phase: before Counselor and
 * Front Desk existed, "any non-SUPER_ADMIN session" was equivalent to
 * "admin," so no page needed a finer check. Now it isn't, and this page
 * needs one explicitly rather than inheriting a guarantee that no longer
 * holds.
 */
export default async function StaffPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (!hasPermission(user, "STAFF_MANAGE")) redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const staff = await StaffService.list(institution.institutionId);

  return <StaffListView staff={staff} />;
}
