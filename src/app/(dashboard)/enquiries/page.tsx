import type { Metadata } from "next";
import { requireTenantUserPage } from "@/lib/tenant";
import { LeadsListView } from "@/components/leads/leads-list-view";

export const metadata: Metadata = { title: "Enquiries" };
export const dynamic = "force-dynamic";

export default async function EnquiriesPage(props: PageProps<"/enquiries">) {
  const user = await requireTenantUserPage();
  const searchParams = await props.searchParams;

  return (
    <LeadsListView
      user={user}
      searchParams={searchParams}
      title="Admission Enquiries"
      description="Every enquiry received from your website, API integrations and manual entry."
    />
  );
}
