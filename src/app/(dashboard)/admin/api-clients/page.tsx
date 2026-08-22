import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { ApiClientService } from "@/services/api-client.service";
import { getAppOrigin } from "@/lib/utils/origin";
import { PageHeader } from "@/components/shared/page-header";
import { Section } from "@/components/shared/definition-list";
import { ApiKeysPanel } from "@/components/integration/api-keys-panel";
import { ApiDocs } from "@/components/integration/api-docs";
import { TabLinks } from "@/components/shared/tab-links";

export const metadata: Metadata = { title: "API clients" };
export const dynamic = "force-dynamic";

const TABS = [
  { value: "clients", label: "API clients" },
  { value: "api", label: "API documentation" },
];

export default async function AdminApiClientsPage(props: PageProps<"/admin/api-clients">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/integration");

  const searchParams = await props.searchParams;
  const tabParam = typeof searchParams.tab === "string" ? searchParams.tab : "clients";
  const tab = TABS.some((entry) => entry.value === tabParam) ? tabParam : "clients";

  const [clients, origin] = await Promise.all([ApiClientService.list({}), getAppOrigin()]);

  return (
    <>
      <PageHeader
        title="API Clients"
        description="Credentials issued by institutions to their websites and portals."
      />

      {/* Revocation is a safety action; issuing keys is not a platform-admin power. */}
      <div className="mb-5 flex items-start gap-3 rounded-lg border border-border bg-mist px-4 py-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-0.5">
          <p className="text-sm font-medium">You can review and revoke, but not issue</p>
          <p className="text-sm text-muted-foreground">
            Institutions issue their own credentials. Revoking one here shuts off a leaked key
            immediately. Secrets are stored only as hashes and are never readable, by anyone.
          </p>
        </div>
      </div>

      <TabLinks tabs={TABS} active={tab} basePath="/admin/api-clients" />

      <div className="mt-5">
        {tab === "clients" ? (
          <Section title="All credentials">
            <ApiKeysPanel
              clients={clients}
              showInstitution
              canCreate={false}
              emptyDescription="No institution has issued API credentials yet."
            />
          </Section>
        ) : (
          <ApiDocs origin={origin} />
        )}
      </div>
    </>
  );
}
