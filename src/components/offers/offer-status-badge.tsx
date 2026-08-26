import { cn } from "@/lib/utils";
import { OFFER_STATUS_LABELS, type OfferStatus } from "@/lib/constants";

/**
 * The same fill-weight tone vocabulary as `scholarship-status-badge.tsx`:
 * DRAFT hasn't been shown to anyone yet, PUBLISHED is the terminal, positive
 * state the public API reads from, ARCHIVED is withdrawn.
 */
const TONE: Record<OfferStatus, string> = {
  DRAFT: "border-foreground/25 bg-background text-foreground",
  PUBLISHED: "border-transparent bg-foreground text-background",
  ARCHIVED: "border-dashed border-border bg-background text-muted-foreground",
};

export function OfferStatusBadge({ status }: { status: OfferStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE[status],
      )}
    >
      {OFFER_STATUS_LABELS[status]}
    </span>
  );
}
