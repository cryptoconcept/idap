import { cn } from "@/lib/utils";
import { RESULT_STATUS_LABELS, type ResultStatus } from "@/lib/constants";

/**
 * The same fill-weight tone vocabulary as `status-badge.tsx` (open/solid/closed),
 * applied to the result lifecycle: DRAFT hasn't been shown to anyone yet,
 * PUBLISHED is the terminal, positive state the public API reads from, and
 * ARCHIVED is withdrawn — terminal, but no longer live.
 */
const TONE: Record<ResultStatus, string> = {
  DRAFT: "border-foreground/25 bg-background text-foreground",
  PUBLISHED: "border-transparent bg-foreground text-background",
  ARCHIVED: "border-dashed border-border bg-background text-muted-foreground",
};

export function ResultStatusBadge({ status }: { status: ResultStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE[status],
      )}
    >
      {RESULT_STATUS_LABELS[status]}
    </span>
  );
}
