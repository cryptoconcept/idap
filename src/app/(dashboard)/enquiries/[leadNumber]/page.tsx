import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { requireTenantUserPage, tenantFilter } from "@/lib/tenant";
import { LeadService } from "@/services/lead.service";
import { NoteService } from "@/services/note.service";
import { ActivityService } from "@/services/activity.service";
import { AppError } from "@/lib/api/errors";
import { PageHeader } from "@/components/shared/page-header";
import { Field, FieldGrid, Section } from "@/components/shared/definition-list";
import { NotesPanel } from "@/components/shared/notes-panel";
import { ActivityTimeline } from "@/components/shared/activity-timeline";
import { LeadStatusControl } from "@/components/leads/lead-status-control";
import { LeadStatusBadge } from "@/components/shared/status-badge";
import { Ref } from "@/components/shared/ref";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatPhone, formatSource } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  props: PageProps<"/enquiries/[leadNumber]">,
): Promise<Metadata> {
  const { leadNumber } = await props.params;
  return { title: `Enquiry ${leadNumber}` };
}

export default async function EnquiryDetailPage(props: PageProps<"/enquiries/[leadNumber]">) {
  const user = await requireTenantUserPage();
  const { leadNumber } = await props.params;

  let lead;
  try {
    lead = await LeadService.getById(tenantFilter(user), leadNumber);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const [notes, activities] = await Promise.all([
    NoteService.list(lead.institutionId, "LEAD", lead.id),
    ActivityService.listForEntity(lead.institutionId, "LEAD", lead.id),
  ]);

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3 text-muted-foreground">
        <Link href="/enquiries">
          <ArrowLeft className="size-3.5" />
          Enquiries
        </Link>
      </Button>

      <PageHeader
        title={lead.studentName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Ref className="text-muted-foreground">{lead.leadNumber}</Ref>
            <span aria-hidden>·</span>
            <span>Received {formatDateTime(lead.createdAt)}</span>
          </span>
        }
        actions={
          <>
            <LeadStatusBadge status={lead.status} />
            <LeadStatusControl leadNumber={lead.leadNumber} status={lead.status} />
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <Section title="Enquiry details">
            <FieldGrid columns={3}>
              <Field label="Student name" value={lead.studentName} />
              <Field label="Parent / guardian" value={lead.parentName} />
              <Field label="Class interested in" value={lead.classInterested} />
              <Field label="Phone" value={formatPhone(lead.phone)} mono />
              <Field label="Email" value={lead.email} />
              <Field label="Status" value={<LeadStatusBadge status={lead.status} />} />
            </FieldGrid>

            {lead.message ? (
              <div className="mt-5 border-t border-border pt-4">
                <p className="text-xs text-muted-foreground">Message</p>
                <p className="mt-1 text-sm whitespace-pre-wrap">{lead.message}</p>
              </div>
            ) : null}
          </Section>

          <Section title="Source">
            <FieldGrid columns={3}>
              <Field label="Received via" value={formatSource(lead.source)} />
              <Field label="Sending application" value={lead.sourceApplication} />
              <Field
                label="Source page"
                value={
                  lead.sourceUrl ? (
                    <a
                      href={lead.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="underline underline-offset-4"
                    >
                      {lead.sourceUrl}
                    </a>
                  ) : undefined
                }
              />
              <Field label="Last updated" value={formatDateTime(lead.updatedAt)} />
            </FieldGrid>
          </Section>

          <NotesPanel
            notes={notes}
            endpoint={`/api/leads/${encodeURIComponent(lead.leadNumber)}/notes`}
          />
        </div>

        <div className="space-y-5">
          <ActivityTimeline activities={activities} />
        </div>
      </div>
    </>
  );
}
