import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { ScholarshipService } from "@/services/scholarship.service";
import { ScholarshipsListView } from "@/components/scholarships/scholarships-list-view";

export const metadata: Metadata = { title: "Scholarships" };
export const dynamic = "force-dynamic";

/**
 * The institute admin owns this screen, matching Fees and Results exactly:
 * the platform admin has no route here, and neither does Counselor or Front
 * Desk — they read published scholarships the same way any public caller does.
 */
export default async function ScholarshipsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const scholarships = await ScholarshipService.list(institution.institutionId);

  return <ScholarshipsListView scholarships={scholarships} />;
}
