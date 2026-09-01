import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/tenant/permissions";
import { requireTenantUserPage } from "@/lib/tenant";
import { ApplicationsListView } from "@/components/applications/applications-list-view";

export const metadata: Metadata = { title: "Applications" };
export const dynamic = "force-dynamic";

export default async function ApplicationsPage(props: PageProps<"/applications">) {
  const user = await requireTenantUserPage();
  // H1 fix: the applications plane is INSTITUTION_ADMIN-only. Without this a
  // FRONT_DESK/COUNSELOR could reach the server-rendered record directly by
  // URL even though the API now refuses them.
  if (!hasPermission(user, "APPLICATIONS_VIEW")) redirect("/dashboard");
  const searchParams = await props.searchParams;

  return (
    <ApplicationsListView
      user={user}
      searchParams={searchParams}
      title="Admission Applications"
      description="Review, decide on and print admission applications for your institution."
    />
  );
}
