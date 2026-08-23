"use client";

import { cn } from "@/lib/utils";

/**
 * The percentage is always the server's number. Nothing here recomputes it —
 * the dashboard, the API and this meter read one weight table.
 */
export function CompletionMeter({
  percent,
  missingCount,
  className,
}: {
  percent: number;
  missingCount?: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));

  return (
    <div className={cn("min-w-[180px] space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">Profile completion</span>
        <span className="tabular text-sm font-semibold text-foreground">{clamped}%</span>
      </div>

      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Profile completion"
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-foreground transition-[width] duration-300"
          style={{ width: `${clamped}%` }}
        />
      </div>

      {missingCount !== undefined ? (
        <p className="text-xs text-muted-foreground">
          {missingCount === 0
            ? "Every scored detail is filled in."
            : `${missingCount} detail${missingCount === 1 ? "" : "s"} still to add.`}
        </p>
      ) : null}
    </div>
  );
}
