"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function goTo(nextPage: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextPage <= 1) params.delete("page");
    else params.set("page", String(nextPage));
    router.push(`${pathname}${params.toString() ? `?${params}` : ""}`);
  }

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-border px-1 py-3 sm:flex-row">
      <p className="tabular text-xs text-muted-foreground">
        {total === 0 ? "No records" : `${first}–${last} of ${total}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => goTo(page - 1)}
        >
          <ChevronLeft className="size-3.5" />
          Previous
        </Button>
        <span className="tabular px-1 text-xs text-muted-foreground">
          {page} / {totalPages}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => goTo(page + 1)}
        >
          Next
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
