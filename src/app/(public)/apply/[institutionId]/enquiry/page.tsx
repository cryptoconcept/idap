import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { InstitutionService } from "@/services/institution.service";
import { EnquiryForm } from "@/components/public/enquiry-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  props: PageProps<"/apply/[institutionId]/enquiry">,
): Promise<Metadata> {
  const { institutionId } = await props.params;
  const institution = await InstitutionService.getPublicBranding(institutionId);
  return {
    title: institution ? `Admission enquiry · ${institution.institutionName}` : "Enquiry",
    robots: { index: false, follow: false },
  };
}

export default async function EnquiryPage(props: PageProps<"/apply/[institutionId]/enquiry">) {
  const { institutionId } = await props.params;
  const institution = await InstitutionService.getPublicBranding(institutionId);
  if (!institution) notFound();

  return (
    <div className="space-y-7">
      <header className="space-y-2">
        <p className="eyebrow">Admission enquiry</p>
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          Ask {institution.institutionName} about admissions
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Tell us who the enquiry is for and how to reach you. The admissions office will follow up.
        </p>
        <p className="text-sm text-muted-foreground">
          Ready to apply?{" "}
          <Link
            href={`/apply/${institution.institutionId}`}
            className="text-foreground underline underline-offset-4"
          >
            Fill in the admission application
          </Link>
          .
        </p>
      </header>

      <div className="rounded-lg border border-border bg-background p-5 sm:p-7">
        <EnquiryForm institutionId={institution.institutionId} />
      </div>
    </div>
  );
}
