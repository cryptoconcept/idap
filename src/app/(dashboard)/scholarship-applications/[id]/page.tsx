import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { hasPermission, scholarshipApplicationVisibilityFilter } from "@/lib/tenant/permissions";
import { requireTenantUserPage, tenantFilter } from "@/lib/tenant";
import { AppError } from "@/lib/api/errors";
import { ScholarshipApplicationService } from "@/services/scholarship-application.service";
import { hubStatusBadge } from "@/lib/scholarship-applications/status-display";
import { Badge } from "@/components/ui/badge";
import { ScholarshipApplicationReviewStatusControl } from "@/components/scholarship-applications/scholarship-application-review-status-control";
import { ScholarshipApplicationAssignControl } from "@/components/scholarship-applications/scholarship-application-assign-control";
import { LeadService } from "@/services/lead.service";

export const metadata: Metadata = { title: "Scholarship Application" };
export const dynamic = "force-dynamic";

export default async function ScholarshipApplicationDetailPage(
  props: PageProps<"/scholarship-applications/[id]">,
) {
  const user = await requireTenantUserPage();
  if (!hasPermission(user, "SCHOLARSHIP_APPLICATIONS_VIEW")) redirect("/dashboard");
  const { id } = await props.params;
  const clause = tenantFilter(user);
  const filter = { ...clause, ...scholarshipApplicationVisibilityFilter(user) };

  let application;
  try {
    application = await ScholarshipApplicationService.get(filter, id);
  } catch (error) {
    // An application outside this tenant, or an id that is not an id at all,
    // is "no such page". Anything else is a real failure and must not be masked.
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const assignees = hasPermission(user, "SCHOLARSHIP_APPLICATIONS_ASSIGN")
    ? await LeadService.listAssignees(clause.institutionId)
    : [];
  const badge = hubStatusBadge(application.hubStatus);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{application.applicant.name}</h1>
          <p className="text-sm text-muted-foreground">{application.applicant.email ?? application.applicant.mobile ?? "No contact on file"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
      </div>

      {application.hubStatus === "withdrawn" ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          This applicant withdrew their application on Scholarship Hub. Your review status below is unaffected and stays as your institution's own record.
        </div>
      ) : null}

      <div className="flex items-center gap-4">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Review status</p>
          <ScholarshipApplicationReviewStatusControl id={application.id} reviewStatus={application.reviewStatus} />
        </div>
        {hasPermission(user, "SCHOLARSHIP_APPLICATIONS_ASSIGN") ? (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Assigned to</p>
            <ScholarshipApplicationAssignControl id={application.id} assignedTo={application.assignedTo} assignees={assignees} />
          </div>
        ) : null}
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium">Answers</h2>
        <dl className="grid gap-2 text-sm">
          {Object.entries(application.answers).map(([key, value]) => (
            <div key={key} className="rounded-md border p-2">
              <dt className="text-xs text-muted-foreground">{key}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {application.documents.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium">Documents</h2>
          <ul className="space-y-1 text-sm">
            {application.documents.map((doc) => (
              <li key={doc.key}>
                <a
                  href={`/api/scholarship-applications/${application.id}/documents/${doc.key}/file`}
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {doc.label} ({doc.filename})
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
