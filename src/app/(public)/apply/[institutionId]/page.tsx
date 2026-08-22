import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { InstitutionService } from "@/services/institution.service";
import { ApplicationForm } from "@/components/public/application-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  props: PageProps<"/apply/[institutionId]">,
): Promise<Metadata> {
  const { institutionId } = await props.params;
  const institution = await InstitutionService.getPublicBranding(institutionId);
  return {
    title: institution ? `Admission application · ${institution.institutionName}` : "Apply",
    robots: { index: false, follow: false },
  };
}

export default async function ApplyPage(props: PageProps<"/apply/[institutionId]">) {
  const { institutionId } = await props.params;
  const institution = await InstitutionService.getPublicBranding(institutionId);
  if (!institution) notFound();

  return (
    <div className="space-y-7">
      <header className="space-y-2">
        <p className="eyebrow">Admission application</p>
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          Apply for admission to {institution.institutionName}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Fields marked * are required. You will get an application number as soon as you submit —
          the admissions office uses it to track your application.
        </p>
        <p className="text-sm text-muted-foreground">
          Just have a question?{" "}
          <Link
            href={`/apply/${institution.institutionId}/enquiry`}
            className="text-foreground underline underline-offset-4"
          >
            Send an enquiry instead
          </Link>
          .
        </p>
      </header>

      <div className="rounded-lg border border-border bg-background p-5 sm:p-7">
        <ApplicationForm institutionId={institution.institutionId} />
      </div>
    </div>
  );
}
