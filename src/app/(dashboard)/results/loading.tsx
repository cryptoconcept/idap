import { Skeleton } from "@/components/ui/skeleton";

/** The editor's own shape, so the page does not jump when the results arrive. */
export default function ResultsLoading() {
  return (
    <div className="space-y-6" aria-busy>
      <div className="space-y-2 pb-5">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>

      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-5 w-24" />
        <div className="flex items-center gap-4">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[228px_minmax(0,1fr)]">
        <div className="hidden flex-col gap-2 lg:flex">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>

        <div className="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5">
          <Skeleton className="h-4 w-40" />
          <div className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
          <Skeleton className="h-8 w-28" />
        </div>
      </div>
    </div>
  );
}
