import { Suspense } from "react";
import { Inbox } from "lucide-react";
import { ScholarshipApplicationService } from "@/services/scholarship-application.service";
import { scholarshipApplicationQuerySchema } from "@/lib/validation/scholarship-application";
import { HUB_APPLICATION_STATUSES, SCHOLARSHIP_APPLICATION_REVIEW_STATUSES } from "@/lib/constants";
import { tenantFilter } from "@/lib/tenant";
import type { CurrentUser } from "@/lib/auth/current-user";
import { PageHeader } from "@/components/shared/page-header";
import { FilterBar, type FilterDefinition } from "@/components/shared/filter-bar";
import { Pagination } from "@/components/shared/pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ScholarshipApplicationsTable } from "./scholarship-applications-table";
import { Skeleton } from "@/components/ui/skeleton";

export async function ScholarshipApplicationsListView({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const query = scholarshipApplicationQuerySchema.parse(
    Object.fromEntries(Object.entries(searchParams).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])),
  );

  const clause = tenantFilter(user);
  const result = await ScholarshipApplicationService.list(clause, query);

  const filters: FilterDefinition[] = [
    { key: "hubStatus", label: "Hub status", options: HUB_APPLICATION_STATUSES.map((s) => ({ value: s, label: s })) },
    { key: "reviewStatus", label: "Review status", options: SCHOLARSHIP_APPLICATION_REVIEW_STATUSES.map((s) => ({ value: s, label: s })) },
  ];

  const hasFilters = Boolean(query.q || query.hubStatus || query.reviewStatus || query.from || query.to);

  return (
    <>
      <PageHeader title="Scholarship Applications" description="Applications students submitted through Scholarship Hub." />

      <Suspense fallback={<Skeleton className="h-9 w-full max-w-3xl rounded-md" />}>
        <FilterBar searchPlaceholder="Search applicant name..." filters={filters} />
      </Suspense>

      <div className="mt-5">
        {result.items.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={hasFilters ? "No applications match these filters" : "No scholarship applications yet"}
            description={
              hasFilters
                ? "Try a different search term, status, or date range."
                : "Applications students submit through Scholarship Hub will appear here once you've connected and published a scholarship."
            }
          />
        ) : (
          <>
            <ScholarshipApplicationsTable applications={result.items} />
            <Suspense fallback={null}>
              <Pagination page={result.page} totalPages={result.totalPages} total={result.total} pageSize={result.pageSize} />
            </Suspense>
          </>
        )}
      </div>
    </>
  );
}
