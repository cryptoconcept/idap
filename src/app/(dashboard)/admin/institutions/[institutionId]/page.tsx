import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { InstitutionService } from "@/services/institution.service";
import { ApiClientService } from "@/services/api-client.service";
import { getAppOrigin } from "@/lib/utils/origin";
import { AppError } from "@/lib/api/errors";
import { PageHeader } from "@/components/shared/page-header";
import { Field, FieldGrid, Section } from "@/components/shared/definition-list";
import { InstitutionAdminForm } from "@/components/institutions/institution-admin-form";
import { ApiKeysPanel } from "@/components/integration/api-keys-panel";
import { CodeBlock } from "@/components/integration/code-block";
import { Ref } from "@/components/shared/ref";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PROFILE_STATUS_LABELS } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  props: PageProps<"/admin/institutions/[institutionId]">,
): Promise<Metadata> {
  const { institutionId } = await props.params;
  return { title: `Institution ${institutionId}` };
}

export default async function AdminInstitutionDetailPage(
  props: PageProps<"/admin/institutions/[institutionId]">,
) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");

  const { institutionId } = await props.params;

  let institution;
  try {
    institution = await InstitutionService.getById(institutionId);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  // Credential metadata only — no enquiry or application figures are read here.
  // The profile comes along for the read-only summary below: decision 3 lets the
  // platform admin *see* a profile so support does not need a developer, and
  // never edit one.
  const [{ profile, completion }, clients, origin] = await Promise.all([
    InstitutionService.getProfile(institutionId),
    ApiClientService.list({ institutionId }),
    getAppOrigin(),
  ]);

  const applyUrl = `${origin}/apply/${institution.institutionId}`;
  const addressLine =
    [
      profile.address,
      profile.addressLine2,
      profile.locality,
      profile.city,
      profile.district,
      profile.state,
      profile.pincode,
    ]
      .filter(Boolean)
      .join(", ") || undefined;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3 text-muted-foreground">
        <Link href="/admin/institutions">
          <ArrowLeft className="size-3.5" />
          Institutions
        </Link>
      </Button>

      <PageHeader
        title={institution.institutionName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Ref className="text-muted-foreground">{institution.institutionId}</Ref>
            <span aria-hidden>·</span>
            <span>{institution.active ? "Active" : "Deactivated"}</span>
          </span>
        }
      />

      <div className="flex items-start gap-3 rounded-lg border border-border bg-mist px-4 py-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Provisioning only</p>
          <p className="text-sm text-muted-foreground">
            You can rename this institution, set its region code, activate or deactivate its
            account, and revoke a credential. Its profile content is edited by its own admins;
            its enquiries and applications are readable only by them too.
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-5">
        <Section title="Provisioning">
          <InstitutionAdminForm institution={institution} />
        </Section>

        <Section
          title="Institution profile"
          action={
            <span className="flex items-center gap-2">
              <span className="tabular text-xs text-muted-foreground">
                {completion.percent}% complete
              </span>
              <Badge variant={profile.profileStatus === "PUBLISHED" ? "default" : "outline"}>
                {PROFILE_STATUS_LABELS[profile.profileStatus]}
              </Badge>
            </span>
          }
        >
          <p className="mb-4 text-sm text-muted-foreground">
            Read-only. This content belongs to the institution&apos;s own admins; there is no
            platform-side edit for it.
          </p>

          <FieldGrid columns={3}>
            <Field label="Tagline" value={profile.tagline} />
            <Field label="Primary contact" value={profile.contactPerson} />
            <Field label="Phone" value={profile.phone} mono />
            <Field label="Email" value={profile.email} />
            <Field label="Website" value={profile.website} />
            <Field label="Address" value={addressLine} />
          </FieldGrid>

          <div className="mt-4">
            <Field
              label="About"
              value={
                profile.description ? (
                  <span className="whitespace-pre-line">{profile.description}</span>
                ) : undefined
              }
            />
          </div>
        </Section>

        <Section title="API credentials">
          <ApiKeysPanel
            clients={clients}
            canCreate={false}
            emptyDescription="This institution has not issued any API credentials yet. Its admins create them from their own Integration page."
          />
        </Section>

        <Section title="Hosted pages">
          <CodeBlock
            label="Links"
            code={`Apply for admission   ${applyUrl}
Admission enquiry     ${applyUrl}/enquiry`}
          />
        </Section>
      </div>
    </>
  );
}
