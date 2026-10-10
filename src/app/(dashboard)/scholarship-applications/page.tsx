import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/tenant/permissions";
import { requireTenantUserPage } from "@/lib/tenant";
import { ScholarshipApplicationsListView } from "@/components/scholarship-applications/scholarship-applications-list-view";

export const metadata: Metadata = { title: "Scholarship Applications" };
export const dynamic = "force-dynamic";

export default async function ScholarshipApplicationsPage(props: PageProps<"/scholarship-applications">) {
  const user = await requireTenantUserPage();
  if (!hasPermission(user, "SCHOLARSHIP_APPLICATIONS_VIEW")) redirect("/dashboard");
  const searchParams = await props.searchParams;

  return <ScholarshipApplicationsListView user={user} searchParams={searchParams} />;
}
