import { cn } from "@/lib/utils";
import type { ApplicationStatus, LeadStatus } from "@/lib/constants";
import { APPLICATION_STATUS_LABELS, LEAD_STATUS_LABELS } from "@/lib/utils/format";

/**
 * Without hue to lean on, status is encoded by fill weight:
 *   solid   — a terminal, positive outcome
 *   filled  — actively in progress
 *   open    — untouched, waiting on someone
 *   closed  — terminal, negative outcome
 */
type Tone = "solid" | "filled" | "open" | "closed";

const TONE_CLASSES: Record<Tone, string> = {
  solid: "border-transparent bg-foreground text-background",
  filled: "border-border bg-muted text-foreground",
  open: "border-foreground/25 bg-background text-foreground",
  closed: "border-dashed border-border bg-background text-muted-foreground",
};

const DOT_CLASSES: Record<Tone, string> = {
  solid: "bg-background",
  filled: "bg-foreground",
  open: "bg-transparent ring-1 ring-inset ring-foreground/60",
  closed: "bg-muted-foreground/50",
};

const LEAD_TONES: Record<LeadStatus, Tone> = {
  NEW: "open",
  CONTACTED: "filled",
  INTERESTED: "filled",
  FOLLOW_UP: "filled",
  ADMITTED: "solid",
  REJECTED: "closed",
};

const APPLICATION_TONES: Record<ApplicationStatus, Tone> = {
  SUBMITTED: "open",
  UNDER_REVIEW: "filled",
  SHORTLISTED: "filled",
  APPROVED: "solid",
  REJECTED: "closed",
};

function Chip({ tone, label, className }: { tone: Tone; label: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", DOT_CLASSES[tone])} aria-hidden />
      {label}
    </span>
  );
}

export function LeadStatusBadge({ status, className }: { status: LeadStatus; className?: string }) {
  return <Chip tone={LEAD_TONES[status] ?? "open"} label={LEAD_STATUS_LABELS[status] ?? status} className={className} />;
}

export function ApplicationStatusBadge({
  status,
  className,
}: {
  status: ApplicationStatus;
  className?: string;
}) {
  return (
    <Chip
      tone={APPLICATION_TONES[status] ?? "open"}
      label={APPLICATION_STATUS_LABELS[status] ?? status}
      className={className}
    />
  );
}
