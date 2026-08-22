import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, FileText, Inbox } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution, tenantFilter } from "@/lib/tenant";
import { DashboardService } from "@/services/dashboard.service";
import { LeadService } from "@/services/lead.service";
import { ApplicationService } from "@/services/application.service";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { TabLinks } from "@/components/shared/tab-links";
import { EmptyState } from "@/components/shared/empty-state";
import { LeadsTable } from "@/components/leads/leads-table";
import { ApplicationsTable } from "@/components/applications/applications-table";
import { Ref } from "@/components/shared/ref";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "enquiries", label: "Enquiries" },
  { value: "applications", label: "Applications" },
];

export default async function DashboardPage(props: PageProps<"/dashboard">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const searchParams = await props.searchParams;
  const tabParam = typeof searchParams.tab === "string" ? searchParams.tab : "overview";
  const tab = TABS.some((entry) => entry.value === tabParam) ? tabParam : "overview";

  const clause = tenantFilter(user);
  const [stats, recentLeads, recentApplications] = await Promise.all([
    DashboardService.getStats(clause),
    LeadService.recent(clause, tab === "enquiries" ? 10 : 5),
    ApplicationService.recent(clause, tab === "applications" ? 10 : 5),
  ]);

  return (
    <>
      <PageHeader
        title={institution.institutionName}
        description={
          <span className="flex items-center gap-2">
            <Ref className="text-muted-foreground">{institution.institutionId}</Ref>
            <span aria-hidden>·</span>
            <span>Admission enquiries and applications</span>
          </span>
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/integration">
              Integration
              <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        }
      />

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard label="Total enquiries" value={stats.totalEnquiries} href="/enquiries" />
        <StatCard
          label="New enquiries"
          value={stats.newEnquiries}
          href="/enquiries?status=NEW"
          emphasis={stats.newEnquiries > 0}
        />
        <StatCard label="Applications" value={stats.totalApplications} href="/applications" />
        <StatCard
          label="Under review"
          value={stats.underReview}
          href="/applications?status=UNDER_REVIEW"
        />
        <StatCard label="Approved" value={stats.approved} href="/applications?status=APPROVED" />
        <StatCard label="Admitted" value={stats.admitted} href="/enquiries?status=ADMITTED" />
      </section>

      <div className="mt-7">
        <TabLinks tabs={TABS} active={tab} basePath="/dashboard" />
      </div>

      {tab === "overview" ? (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <RecentPanel
            title="Recent enquiries"
            href="/enquiries"
            isEmpty={recentLeads.length === 0}
            emptyTitle="No enquiries yet"
            emptyDescription="Enquiries submitted through your website will appear here."
            emptyIcon={Inbox}
          >
            <LeadsTable leads={recentLeads} variant="list" />
          </RecentPanel>

          <RecentPanel
            title="Recent applications"
            href="/applications"
            isEmpty={recentApplications.length === 0}
            emptyTitle="No applications yet"
            emptyDescription="Applications submitted through your website will appear here."
            emptyIcon={FileText}
          >
            <ApplicationsTable applications={recentApplications} variant="list" />
          </RecentPanel>
        </div>
      ) : null}

      {tab === "enquiries" ? (
        <div className="mt-5">
          {recentLeads.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No enquiries yet"
              description="Enquiries submitted through your website will appear here."
              actionLabel="View integration"
              actionHref="/integration"
            />
          ) : (
            <>
              <LeadsTable leads={recentLeads} />
              <ViewAll href="/enquiries" label="View all enquiries" />
            </>
          )}
        </div>
      ) : null}

      {tab === "applications" ? (
        <div className="mt-5">
          {recentApplications.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No applications yet"
              description="Applications submitted through your website will appear here."
              actionLabel="View integration"
              actionHref="/integration"
            />
          ) : (
            <>
              <ApplicationsTable applications={recentApplications} />
              <ViewAll href="/applications" label="View all applications" />
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

function RecentPanel({
  title,
  href,
  isEmpty,
  emptyTitle,
  emptyDescription,
  emptyIcon,
  children,
}: {
  title: string;
  href: string;
  isEmpty: boolean;
  emptyTitle: string;
  emptyDescription: string;
  emptyIcon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="eyebrow">{title}</h2>
        <Link
          href={href}
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          View all
        </Link>
      </div>
      <div className="px-4 py-1">
        {isEmpty ? (
          <div className="py-6">
            <EmptyState
              icon={emptyIcon}
              title={emptyTitle}
              description={emptyDescription}
              actionLabel="View integration"
              actionHref="/integration"
            />
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function ViewAll({ href, label }: { href: string; label: string }) {
  return (
    <div className="flex justify-end pt-4">
      <Button asChild variant="outline" size="sm">
        <Link href={href}>
          {label}
          <ArrowUpRight className="size-3.5" />
        </Link>
      </Button>
    </div>
  );
}
