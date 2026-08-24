import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { INSTITUTION_TYPE_LABELS, type InstitutionType } from "@/lib/constants";
import { PageHeader } from "@/components/shared/page-header";
import { Field, FieldGrid, Section } from "@/components/shared/definition-list";
import { Ref } from "@/components/shared/ref";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * Institution profile fields (name, contact, branding, and beyond) are edited
 * at /profile — this page is account-only so the two never overlap.
 */
export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin/settings");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  return (
    <>
      <PageHeader
        title="Settings"
        description="The account you are signed in with."
      />

      <div className="space-y-5">
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
