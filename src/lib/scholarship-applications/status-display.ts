import type { HubApplicationStatus } from "@/lib/constants";

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const LABELS: Record<HubApplicationStatus, string> = {
  submitted: "Submitted",
  under_review: "Under review",
  shortlisted: "Shortlisted",
  additional_info_required: "More info requested",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn on Hub",
};

/**
 * `withdrawn` gets the destructive (red) variant deliberately — per the
 * spec's failure matrix, a withdrawn-after-decision application must
 * surface prominently, since `reviewStatus` can still read SHORTLISTED or
 * APPROVED underneath it. Every other status is a neutral/secondary badge.
 */
export function hubStatusBadge(status: HubApplicationStatus): { label: string; variant: BadgeVariant } {
  return { label: LABELS[status], variant: status === "withdrawn" ? "destructive" : "secondary" };
}

export function hubStatusIsClosed(status: HubApplicationStatus): boolean {
  return status === "withdrawn";
}
