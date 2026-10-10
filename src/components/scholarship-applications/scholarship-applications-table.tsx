import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { hubStatusBadge } from "@/lib/scholarship-applications/status-display";
import { ScholarshipApplicationReviewStatusControl } from "./scholarship-application-review-status-control";
import type { ScholarshipApplicationDTO } from "@/services/scholarship-application.service";

export function ScholarshipApplicationsTable({
  applications,
}: {
  applications: ScholarshipApplicationDTO[];
}) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs font-medium text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Applicant</th>
            <th className="px-3 py-2">Hub status</th>
            <th className="px-3 py-2">Review status</th>
            <th className="px-3 py-2">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {applications.map((application) => {
            const badge = hubStatusBadge(application.hubStatus);
            return (
              <tr key={application.id} className="border-t">
                <td className="px-3 py-2">
                  <Link href={`/scholarship-applications/${application.id}`} className="font-medium hover:underline">
                    {application.applicant.name}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                  {application.hubStatus === "withdrawn" ? (
                    <p className="mt-1 text-xs text-destructive">Withdrawn on Scholarship Hub</p>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <ScholarshipApplicationReviewStatusControl id={application.id} reviewStatus={application.reviewStatus} />
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {application.submittedAt ? new Date(application.submittedAt).toLocaleDateString() : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
