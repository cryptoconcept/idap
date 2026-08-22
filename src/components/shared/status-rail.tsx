import { cn } from "@/lib/utils";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/constants";
import { APPLICATION_STATUS_LABELS } from "@/lib/utils/format";

const PROGRESSION: ApplicationStatus[] = ["SUBMITTED", "UNDER_REVIEW", "SHORTLISTED", "APPROVED"];

/**
 * Review progress drawn in hairlines and fill instead of colour. A rejected
 * application leaves the rail, so it is rendered as a terminated track rather
 * than a step.
 */
export function StatusRail({
  status,
  className,
}: {
  status: ApplicationStatus;
  className?: string;
}) {
  const rejected = status === "REJECTED";
  const currentIndex = rejected ? -1 : PROGRESSION.indexOf(status);

  return (
    <ol className={cn("flex w-full items-start gap-0", className)} aria-label="Application progress">
      {PROGRESSION.map((step, index) => {
        const reached = !rejected && index <= currentIndex;
        const isCurrent = !rejected && index === currentIndex;

        return (
          <li key={step} className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center">
              <span
                className={cn(
                  "size-2 shrink-0 rotate-45 border transition-colors",
                  reached ? "border-foreground bg-foreground" : "border-border bg-background",
                  isCurrent && "ring-3 ring-foreground/10",
                )}
                aria-hidden
              />
              {index < PROGRESSION.length - 1 ? (
                <span
                  className={cn(
                    "h-px flex-1",
                    index < currentIndex ? "bg-foreground" : "bg-border",
                  )}
                  aria-hidden
                />
              ) : null}
            </div>
            <span
              className={cn(
                "pr-2 text-[10px] leading-tight tracking-wide uppercase sm:text-[11px]",
                reached ? "text-foreground" : "text-muted-foreground",
                isCurrent && "font-semibold",
              )}
            >
              {APPLICATION_STATUS_LABELS[step]}
            </span>
          </li>
        );
      })}

      {rejected ? (
        <li className="shrink-0 self-center pl-3">
          <span className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] tracking-wide text-muted-foreground uppercase">
            {APPLICATION_STATUS_LABELS.REJECTED}
          </span>
        </li>
      ) : null}
    </ol>
  );
}

export const APPLICATION_STATUS_ORDER = APPLICATION_STATUSES;
