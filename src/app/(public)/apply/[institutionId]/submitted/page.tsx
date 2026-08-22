import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { InstitutionService } from "@/services/institution.service";
import { Ref } from "@/components/shared/ref";
import { CopyButton } from "@/components/shared/copy-button";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Submitted",
  robots: { index: false, follow: false },
};

export default async function SubmittedPage(
  props: PageProps<"/apply/[institutionId]/submitted">,
) {
  const { institutionId } = await props.params;
  const searchParams = await props.searchParams;

  const institution = await InstitutionService.getPublicBranding(institutionId);
  if (!institution) notFound();

  const reference = typeof searchParams.reference === "string" ? searchParams.reference : "";
  const isEnquiry = searchParams.type === "enquiry";

  return (
    <div className="mx-auto max-w-[560px] space-y-7 py-6 text-center">
      <div className="flex justify-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-foreground text-background">
          <Check className="size-5" />
        </span>
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          {isEnquiry ? "Enquiry submitted successfully" : "Application submitted successfully"}
        </h1>
        <p className="text-sm text-balance text-muted-foreground">
          Thank you for {isEnquiry ? "your interest in" : "applying to"}{" "}
          {institution.institutionName}.
        </p>
      </div>

      {reference ? (
        <div className="space-y-3 rounded-lg border border-border bg-background p-5">
          <p className="eyebrow">{isEnquiry ? "Enquiry number" : "Application number"}</p>
          <Ref size="lg" className="block text-xl">
            {reference}
          </Ref>
          <p className="text-xs text-muted-foreground">
            Please save this number for future reference.
          </p>
          <div className="flex justify-center">
            <CopyButton value={reference} label="Copy number" size="sm" />
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {isEnquiry
            ? "The admissions office will contact you on the number you provided."
            : "The admissions office will review your application and get in touch."}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/apply/${institution.institutionId}`}>
              {isEnquiry ? "Apply for admission" : "Submit another application"}
            </Link>
          </Button>
          {institution.website ? (
            <Button asChild variant="ghost" size="sm">
              <a href={institution.website} target="_blank" rel="noreferrer noopener">
                Back to {institution.institutionName}
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
