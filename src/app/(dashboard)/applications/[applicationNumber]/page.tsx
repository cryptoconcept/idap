import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, Download } from "lucide-react";
import { requireTenantUserPage, tenantFilter } from "@/lib/tenant";
import { ApplicationService } from "@/services/application.service";
import { NoteService } from "@/services/note.service";
import { ActivityService } from "@/services/activity.service";
import { AppError } from "@/lib/api/errors";
import { DOCUMENT_TYPE_LABELS } from "@/lib/constants";
import { PageHeader } from "@/components/shared/page-header";
import { Field, FieldGrid, Section } from "@/components/shared/definition-list";
import { NotesPanel } from "@/components/shared/notes-panel";
import { ActivityTimeline } from "@/components/shared/activity-timeline";
import { StatusRail } from "@/components/shared/status-rail";
import { ApplicationStatusBadge } from "@/components/shared/status-badge";
import { ApplicationStatusDialog } from "@/components/applications/application-status-dialog";
import { PrintButton } from "@/components/applications/print-button";
import { DocumentUpload } from "@/components/applications/document-upload";
import { Ref } from "@/components/shared/ref";
import { Button } from "@/components/ui/button";
import {
  formatDate,
  formatDateTime,
  formatPhone,
  formatSource,
  humanizeStatus,
  joinAddress,
} from "@/lib/utils/format";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  props: PageProps<"/applications/[applicationNumber]">,
): Promise<Metadata> {
  const { applicationNumber } = await props.params;
  return { title: `Application ${applicationNumber}` };
}

export default async function ApplicationDetailPage(
  props: PageProps<"/applications/[applicationNumber]">,
) {
  const user = await requireTenantUserPage();
  const { applicationNumber } = await props.params;

  let application;
  try {
    application = await ApplicationService.getApplication(tenantFilter(user), applicationNumber);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const [notes, activities] = await Promise.all([
    NoteService.list(application.institutionId, "APPLICATION", application.id),
    ActivityService.listForEntity(application.institutionId, "APPLICATION", application.id),
  ]);

  const encoded = encodeURIComponent(application.applicationNumber);

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3 text-muted-foreground">
        <Link href="/applications">
          <ArrowLeft className="size-3.5" />
          Applications
        </Link>
      </Button>

      <PageHeader
        title={application.student.fullName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Ref className="text-muted-foreground">{application.applicationNumber}</Ref>
            <span aria-hidden>·</span>
            <span>
              {application.admission.applyingFor} · {application.academicYear}
            </span>
          </span>
        }
        actions={
          <>
            <ApplicationStatusBadge status={application.status} />
            <ApplicationStatusDialog
              applicationNumber={application.applicationNumber}
              status={application.status}
            />
            <PrintButton applicationNumber={application.applicationNumber} />
            <Button asChild variant="outline" size="sm">
              <a href={`/api/applications/${encoded}/pdf`}>
                <Download className="size-3.5" />
                Download PDF
              </a>
            </Button>
          </>
        }
      >
        <div className="rounded-lg border border-border bg-card px-4 py-4">
          <StatusRail status={application.status} />
        </div>
      </PageHeader>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <Section title="Student information">
            <FieldGrid columns={3}>
              <Field label="First name" value={application.student.firstName} />
              <Field label="Middle name" value={application.student.middleName} />
              <Field label="Last name" value={application.student.lastName} />
              <Field label="Date of birth" value={formatDate(application.student.dateOfBirth)} />
              <Field label="Gender" value={application.student.gender} />
              <Field label="Blood group" value={application.student.bloodGroup} />
            </FieldGrid>
          </Section>

          <Section title="Parent / guardian information">
            <FieldGrid columns={3}>
              <Field label="Father's name" value={application.parent.fatherName} />
              <Field label="Mother's name" value={application.parent.motherName} />
              <Field label="Guardian's name" value={application.parent.guardianName} />
              <Field label="Mobile" value={formatPhone(application.parent.phone)} mono />
              <Field
                label="Alternate phone"
                value={
                  application.parent.alternatePhone
                    ? formatPhone(application.parent.alternatePhone)
                    : undefined
                }
                mono
              />
              <Field label="Email" value={application.parent.email} />
            </FieldGrid>
          </Section>

          <Section title="Address">
            <FieldGrid columns={2}>
              <Field
                label="Residential address"
                value={joinAddress(application.address) || undefined}
                className="sm:col-span-2"
              />
              <Field label="City" value={application.address.city} />
              <Field label="State" value={application.address.state} />
              <Field label="Pincode" value={application.address.pincode} mono />
            </FieldGrid>
          </Section>

          <Section title="Academic information">
            <FieldGrid columns={3}>
              <Field
                label="Previous institution"
                value={application.academic.previousInstitution}
              />
              <Field label="Previous class" value={application.academic.previousClass} />
              <Field
                label="Previous percentage"
                value={
                  application.academic.previousPercentage !== undefined
                    ? `${application.academic.previousPercentage}%`
                    : undefined
                }
              />
            </FieldGrid>
          </Section>

          <Section title="Admission information">
            <FieldGrid columns={3}>
              <Field label="Applying for" value={application.admission.applyingFor} />
              <Field label="Academic year" value={application.academicYear} />
              <Field
                label="Admission type"
                value={
                  application.admission.admissionType
                    ? humanizeStatus(application.admission.admissionType)
                    : undefined
                }
              />
              <Field label="Received via" value={formatSource(application.source)} />
              <Field label="Submitted" value={formatDateTime(application.createdAt)} />
              <Field label="Last updated" value={formatDateTime(application.updatedAt)} />
            </FieldGrid>

            {application.message ? (
              <div className="mt-5 border-t border-border pt-4">
                <p className="text-xs text-muted-foreground">Message from the applicant</p>
                <p className="mt-1 text-sm whitespace-pre-wrap">{application.message}</p>
              </div>
            ) : null}
          </Section>

          <Section
            title={`Documents (${application.documents.length})`}
            action={<DocumentUpload applicationNumber={application.applicationNumber} />}
          >
            {application.documents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No documents were attached to this application.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {application.documents.map((document) => (
                  <li
                    key={document.id || document.fileName}
                    className="flex items-center justify-between gap-3 py-2.5 first:pt-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm">{document.fileName}</p>
                      <p className="text-xs text-muted-foreground">
                        {DOCUMENT_TYPE_LABELS[document.documentType] ?? document.documentType} ·{" "}
                        {formatDate(document.uploadedAt)}
                      </p>
                    </div>
                    {document.fileUrl ? (
                      <Button asChild variant="ghost" size="xs">
                        <a href={document.fileUrl} target="_blank" rel="noreferrer noopener">
                          Open
                        </a>
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <NotesPanel notes={notes} endpoint={`/api/applications/${encoded}/notes`} />
        </div>

        <div className="space-y-5">
          <ActivityTimeline activities={activities} />
        </div>
      </div>
    </>
  );
}
