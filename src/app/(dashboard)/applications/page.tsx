import type { Metadata } from "next";
import { requireTenantUserPage } from "@/lib/tenant";
import { ApplicationsListView } from "@/components/applications/applications-list-view";

export const metadata: Metadata = { title: "Applications" };
export const dynamic = "force-dynamic";

export default async function ApplicationsPage(props: PageProps<"/applications">) {
  const user = await requireTenantUserPage();
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
