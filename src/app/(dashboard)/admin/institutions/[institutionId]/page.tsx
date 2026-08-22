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
import { Section } from "@/components/shared/definition-list";
import { InstitutionAdminForm } from "@/components/institutions/institution-admin-form";
import { ApiKeysPanel } from "@/components/integration/api-keys-panel";
import { CodeBlock } from "@/components/integration/code-block";
import { Ref } from "@/components/shared/ref";
import { Button } from "@/components/ui/button";

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
  const [clients, origin] = await Promise.all([
    ApiClientService.list({ institutionId }),
    getAppOrigin(),
  ]);

  const applyUrl = `${origin}/apply/${institution.institutionId}`;

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
            You can edit this institution&apos;s profile, activate or deactivate its account, and
            revoke a credential. Its enquiries and applications are readable only by its own
            admins.
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-5">
        <Section title="Institution profile">
          <InstitutionAdminForm institution={institution} />
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
