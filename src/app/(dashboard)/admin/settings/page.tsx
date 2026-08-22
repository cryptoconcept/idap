import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { DashboardService } from "@/services/dashboard.service";
import { getAppOrigin } from "@/lib/utils/origin";
import { PageHeader } from "@/components/shared/page-header";
import { Field, FieldGrid, Section } from "@/components/shared/definition-list";
import { API_RATE_LIMIT, LOGIN_RATE_LIMIT, PUBLIC_FORM_RATE_LIMIT } from "@/lib/constants";
import { Ref } from "@/components/shared/ref";

export const metadata: Metadata = { title: "Platform settings" };
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/settings");

  const [platform, origin] = await Promise.all([
    DashboardService.getPlatformStats(),
    getAppOrigin(),
  ]);

  return (
    <>
      <PageHeader
        title="Platform settings"
        description="Your account and the limits currently protecting the platform."
      />

      <div className="space-y-5">
        <Section title="Account">
          <FieldGrid columns={3}>
            <Field label="Signed in as" value={user.name} />
            <Field label="Email" value={user.email} />
            <Field label="Role" value="Platform admin" />
          </FieldGrid>
        </Section>

        <Section title="What this account can do">
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>Create institutions, edit their profiles, and activate or deactivate them.</li>
            <li>Create the first admin account for an institution.</li>
            <li>Review API credential metadata and revoke a leaked key.</li>
          </ul>
          <p className="mt-4 border-t border-border pt-4 text-sm text-muted-foreground">
            It cannot read enquiries or applications — not individually, not in aggregate, and not
            through an API key, because issuing credentials is reserved to institution admins.
          </p>
        </Section>

        <Section title="Platform">
          <FieldGrid columns={4}>
            <Field label="Institutions" value={platform.institutions} />
            <Field label="Active institutions" value={platform.activeInstitutions} />
            <Field label="Institution admins" value={platform.institutionAdmins} />
            <Field label="Active API keys" value={platform.apiClients} />
            <Field label="Public URL" value={<Ref>{origin}</Ref>} className="sm:col-span-2" />
          </FieldGrid>
        </Section>

        <Section title="Rate limits">
          <FieldGrid columns={3}>
            <Field
              label="External API"
              value={`${API_RATE_LIMIT.limit} requests / ${API_RATE_LIMIT.windowSeconds}s per API key`}
            />
            <Field
              label="Hosted forms"
              value={`${PUBLIC_FORM_RATE_LIMIT.limit} submissions / ${PUBLIC_FORM_RATE_LIMIT.windowSeconds}s per IP`}
            />
            <Field
              label="Sign-in"
              value={`${LOGIN_RATE_LIMIT.limit} attempts / ${LOGIN_RATE_LIMIT.windowSeconds / 60} min per account`}
            />
          </FieldGrid>
        </Section>
      </div>
    </>
  );
}
