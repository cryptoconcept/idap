import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight, Building2, ShieldCheck } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { DashboardService } from "@/services/dashboard.service";
import { InstitutionService } from "@/services/institution.service";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { Section } from "@/components/shared/definition-list";
import { EmptyState } from "@/components/shared/empty-state";
import { Ref } from "@/components/shared/ref";
import { Button } from "@/components/ui/button";
import { CreateInstitutionDialog } from "@/components/institutions/create-institution-dialog";
import { INSTITUTION_TYPE_LABELS, type InstitutionType } from "@/lib/constants";
import { formatDate } from "@/lib/utils/format";

export const metadata: Metadata = { title: "Platform overview" };
export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");

  const [platform, recent] = await Promise.all([
    DashboardService.getPlatformStats(),
    InstitutionService.list({ page: 1, pageSize: 8 }),
  ]);

  return (
    <>
      <PageHeader
        title="Platform overview"
        description="Provision institutions and the accounts that run them."
        actions={<CreateInstitutionDialog />}
      />

      {/*
        The boundary is stated where the platform admin will look for the data,
        so its absence reads as a deliberate rule rather than a missing feature.
      */}
      <div className="mb-5 flex items-start gap-3 rounded-lg border border-border bg-mist px-4 py-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Institution data stays with the institution</p>
          <p className="text-sm text-muted-foreground">
            Enquiries and applications are readable only by the institution that received them.
            Your account provisions institutions and their admin accounts; it has no route to
            applicant records, in aggregate or one by one.
          </p>
        </div>
      </div>

      <section aria-label="Platform summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Institutions"
          value={platform.institutions}
          hint={`${platform.activeInstitutions} active`}
          href="/admin/institutions"
        />
        <StatCard
          label="Deactivated"
          value={platform.institutions - platform.activeInstitutions}
          href="/admin/institutions?active=false"
        />
        <StatCard label="Institution admins" value={platform.institutionAdmins} />
        <StatCard
          label="Active API keys"
          value={platform.apiClients}
          href="/admin/api-clients"
        />
      </section>

      <div className="mt-7">
        <Section
          title="Recently added institutions"
          action={
            <Button asChild variant="ghost" size="xs">
              <Link href="/admin/institutions">
                View all
                <ArrowUpRight className="size-3" />
              </Link>
            </Button>
          }
        >
          {recent.items.length === 0 ? (
            <EmptyState
              icon={Building2}
              title="No institutions yet"
              description="Create the first institution and its admin account to get started."
            />
          ) : (
            <ul className="divide-y divide-border">
              {recent.items.map((institution) => (
                <li
                  key={institution.id}
                  className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0"
                >
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/admin/institutions/${institution.institutionId}`}
                      className="text-sm font-medium underline-offset-4 hover:underline"
                    >
                      {institution.institutionName}
                    </Link>
                    <div className="flex flex-wrap items-center gap-2">
                      <Ref className="text-[11px] text-muted-foreground">
                        {institution.institutionId}
                      </Ref>
                      <span className="text-[11px] text-muted-foreground">
                        {INSTITUTION_TYPE_LABELS[institution.institutionType as InstitutionType]}
                      </span>
                      {!institution.active ? (
                        <span className="rounded-full border border-dashed border-border px-1.5 text-[10px] text-muted-foreground">
                          Deactivated
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span className="tabular text-xs text-muted-foreground">
                    {formatDate(institution.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
