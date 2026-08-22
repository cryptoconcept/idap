import { Suspense } from "react";
import { FileText } from "lucide-react";
import { ApplicationService } from "@/services/application.service";
import { applicationQuerySchema } from "@/lib/validation/application";
import { APPLICATION_STATUSES } from "@/lib/constants";
import { APPLICATION_STATUS_LABELS } from "@/lib/utils/format";
import { tenantFilter } from "@/lib/tenant";
import type { CurrentUser } from "@/lib/auth/current-user";
import { PageHeader } from "@/components/shared/page-header";
import { FilterBar, type FilterDefinition } from "@/components/shared/filter-bar";
import { Pagination } from "@/components/shared/pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ApplicationsTable } from "@/components/applications/applications-table";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The applications list. Always scoped to exactly one institution — there is no
 * cross-tenant variant, because no role is allowed to read across tenants.
 */
export async function ApplicationsListView({
  user,
  searchParams,
  title,
  description,
}: {
  user: CurrentUser;
  searchParams: Record<string, string | string[] | undefined>;
  title: string;
  description: string;
}) {
  const query = applicationQuerySchema.parse(
    Object.fromEntries(
      Object.entries(searchParams).map(([key, value]) => [
        key,
        Array.isArray(value) ? value[0] : value,
      ]),
    ),
  );

  const clause = tenantFilter(user);
  const [result, options] = await Promise.all([
    ApplicationService.list(clause, query),
    ApplicationService.filterOptions(clause),
  ]);

  const filters: FilterDefinition[] = [
    {
      key: "academicYear",
      label: "Year",
      options: options.academicYears.map((year) => ({ value: year, label: year })),
    },
    {
      key: "applyingFor",
      label: "Class",
      options: options.classes.map((klass) => ({ value: klass, label: klass })),
    },
    {
      key: "status",
      label: "Status",
      options: APPLICATION_STATUSES.map((status) => ({
        value: status,
        label: APPLICATION_STATUS_LABELS[status],
      })),
    },
  ];


  const hasFilters = Boolean(
    query.q || query.status || query.academicYear || query.applyingFor || query.from || query.to,
  );

  return (
    <>
      <PageHeader title={title} description={description} />

      <Suspense fallback={<Skeleton className="h-9 w-full max-w-3xl rounded-md" />}>
        <FilterBar
          searchPlaceholder="Search application number, student, parent or phone..."
          filters={filters}
        />
      </Suspense>

      <div className="mt-5">
        {result.items.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={hasFilters ? "No applications match these filters" : "No applications yet"}
            description={
              hasFilters
                ? "Try a different search term, class, status or date range."
                : "Applications submitted through your website will appear here."
            }
            actionLabel={hasFilters ? undefined : "View integration"}
            actionHref={hasFilters ? undefined : "/integration"}
          />
        ) : (
          <>
            <ApplicationsTable applications={result.items} />
            <Suspense fallback={null}>
              <Pagination
                page={result.page}
                totalPages={result.totalPages}
                total={result.total}
                pageSize={result.pageSize}
              />
            </Suspense>
          </>
        )}
      </div>
    </>
  );
}
