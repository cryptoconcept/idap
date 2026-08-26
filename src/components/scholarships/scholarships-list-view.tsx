import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { ScholarshipStatusBadge } from "@/components/scholarships/scholarship-status-badge";
import type { ScholarshipDTO } from "@/services/scholarship.service";
import type { ScholarshipStatus } from "@/lib/constants";

/** `updatedAt` is an ISO string on the DTO, and can be absent on a row from
 * before the field existed — render a dash rather than an "Invalid Date". */
function formatUpdated(scholarship: ScholarshipDTO): string {
  if (!scholarship.updatedAt) return "—";
  return new Date(scholarship.updatedAt).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * No bulk selection here, unlike `FeeStructuresListView` — a scholarship has
 * no line items to bulk-price, so there is nothing analogous to `/fees/bulk`,
 * and this stays a server component like `ResultsListView`.
 */
export function ScholarshipsListView({ scholarships }: { scholarships: ScholarshipDTO[] }) {
  return (
    <>
      <PageHeader
        title="Scholarships"
        description="Scholarships your website and partner sites read from the public API."
        actions={
          <Button asChild size="sm">
            <Link href="/scholarships/new">
              <Plus className="size-4" />
              Add a scholarship
            </Link>
          </Button>
        }
      />

      {scholarships.length === 0 ? (
        <EmptyState
          title="No scholarships yet"
          description="Publish a scholarship and any website reading your public API picks it up."
          actionLabel="Add a scholarship"
          actionHref="/scholarships/new"
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Applies to</th>
                <th className="px-4 py-2 font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {scholarships.map((scholarship) => (
                <tr key={scholarship.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/scholarships/${scholarship.id}`}
                      className="font-medium hover:underline"
                    >
                      {scholarship.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    {scholarship.classOrCourse ?? "All classes and courses"}
                  </td>
                  <td className="px-4 py-2.5">{scholarship.amount ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <ScholarshipStatusBadge status={scholarship.status as ScholarshipStatus} />
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {formatUpdated(scholarship)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
