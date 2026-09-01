import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, Download } from "lucide-react";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution } from "@/models";
import { requireTenantUserPage, serializeInstitution, tenantFilter } from "@/lib/tenant";
import { ApplicationService } from "@/services/application.service";
import { ActivityService } from "@/services/activity.service";
import { AppError } from "@/lib/api/errors";
import { ApplicationPrintDocument } from "@/components/applications/print-document";
import { AutoPrint } from "@/components/applications/auto-print";
import { PrintNow } from "@/components/applications/print-now";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  props: PageProps<"/applications/[applicationNumber]/print">,
): Promise<Metadata> {
  const { applicationNumber } = await props.params;
  return { title: `Print ${applicationNumber}` };
}

export default async function ApplicationPrintPage(
  props: PageProps<"/applications/[applicationNumber]/print">,
) {
  const user = await requireTenantUserPage();
  const { applicationNumber } = await props.params;
  const searchParams = await props.searchParams;

  let application;
  try {
    application = await ApplicationService.getApplication(tenantFilter(user), applicationNumber);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  await connectToDatabase();
  const institutionDoc = await Institution.findOne({
    institutionId: application.institutionId,
  }).lean();
  if (!institutionDoc) notFound();

  // Audit flows-L3: record a print only on an actual print intent
  // (?autoprint=1, which the dashboard Print button always sets and AutoPrint
  // acts on), not on every GET. Opening the view to read it, or refreshing,
  // no longer logs a print that never happened.
  if (searchParams.autoprint === "1") {
    await ActivityService.record({
      institutionId: application.institutionId,
      entityType: "APPLICATION",
      entityId: application.id,
      entityRef: application.applicationNumber,
      action: "Application printed",
      performedBy: user.id,
      performedByName: user.name,
    });
  }

  const encoded = encodeURIComponent(application.applicationNumber);

  return (
    <div className="min-h-dvh bg-mist py-6 print:bg-white print:py-0">
      <AutoPrint enabled={searchParams.autoprint === "1"} />

      <div className="no-print mx-auto mb-5 flex w-full max-w-[210mm] flex-wrap items-center justify-between gap-2 px-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2.5 text-muted-foreground">
          <Link href={`/applications/${encoded}`}>
            <ArrowLeft className="size-3.5" />
            Back to application
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <a href={`/api/applications/${encoded}/pdf`}>
              <Download className="size-3.5" />
              Download PDF
            </a>
          </Button>
          <PrintNow />
        </div>
      </div>

      <ApplicationPrintDocument
        application={application}
        institution={serializeInstitution(institutionDoc)}
      />
    </div>
  );
}
