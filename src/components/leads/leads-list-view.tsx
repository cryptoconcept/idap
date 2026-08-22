import { Suspense } from "react";
import { Inbox } from "lucide-react";
import { LeadService } from "@/services/lead.service";
import { leadQuerySchema } from "@/lib/validation/lead";
import { LEAD_STATUSES, SOURCES } from "@/lib/constants";
import { LEAD_STATUS_LABELS, formatSource } from "@/lib/utils/format";
import { tenantFilter } from "@/lib/tenant";
import type { CurrentUser } from "@/lib/auth/current-user";
import { PageHeader } from "@/components/shared/page-header";
import { FilterBar, type FilterDefinition } from "@/components/shared/filter-bar";
import { Pagination } from "@/components/shared/pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { LeadsTable } from "@/components/leads/leads-table";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The enquiries list. Always scoped to exactly one institution — there is no
 * cross-tenant variant, because no role is allowed to read across tenants.
 */
export async function LeadsListView({
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
  const query = leadQuerySchema.parse(
    Object.fromEntries(
      Object.entries(searchParams).map(([key, value]) => [
        key,
        Array.isArray(value) ? value[0] : value,
      ]),
    ),
  );

  const result = await LeadService.list(tenantFilter(user), query);
  const hasFilters = Boolean(query.q || query.status || query.source || query.from || query.to);

  const filters: FilterDefinition[] = [
    {
      key: "status",
      label: "Status",
      options: LEAD_STATUSES.map((status) => ({
        value: status,
        label: LEAD_STATUS_LABELS[status],
      })),
    },
    {
      key: "source",
      label: "Source",
      options: SOURCES.map((source) => ({ value: source, label: formatSource(source) })),
    },
  ];


  return (
    <>
      <PageHeader title={title} description={description} />

      <Suspense fallback={<Skeleton className="h-9 w-full max-w-2xl rounded-md" />}>
        <FilterBar
          searchPlaceholder="Search enquiry number, student, parent or phone..."
          filters={filters}
        />
      </Suspense>

      <div className="mt-5">
        {result.items.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={hasFilters ? "No enquiries match these filters" : "No enquiries yet"}
            description={
              hasFilters
                ? "Try a different search term, status or date range."
                : "Enquiries submitted through your website will appear here."
            }
            actionLabel={hasFilters ? undefined : "View integration"}
            actionHref={hasFilters ? undefined : "/integration"}
          />
        ) : (
          <>
            <LeadsTable leads={result.items} />
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
