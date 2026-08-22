import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { INSTITUTION_TYPE_LABELS, type InstitutionType } from "@/lib/constants";
import { PageHeader } from "@/components/shared/page-header";
import { Field, FieldGrid, Section } from "@/components/shared/definition-list";
import { InstitutionProfileForm } from "@/components/institutions/institution-profile-form";
import { Ref } from "@/components/shared/ref";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin/settings");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  return (
    <>
      <PageHeader
        title="Settings"
        description="Your institution profile and the account you are signed in with."
      />

      <div className="space-y-5">
        <Section title="Institution profile">
          <InstitutionProfileForm institution={institution} />
        </Section>

        <Section title="Account">
          <FieldGrid columns={3}>
            <Field label="Signed in as" value={user.name} />
            <Field label="Email" value={user.email} />
            <Field label="Role" value="Institution admin" />
            <Field
              label="Institution ID"
              value={<Ref>{institution.institutionId}</Ref>}
            />
            <Field
              label="Institution type"
              value={INSTITUTION_TYPE_LABELS[institution.institutionType as InstitutionType]}
            />
            <Field label="Status" value={institution.active ? "Active" : "Inactive"} />
          </FieldGrid>
        </Section>
      </div>
    </>
  );
}
