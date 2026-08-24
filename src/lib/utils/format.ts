import type { ApplicationStatus, LeadStatus } from "@/lib/constants";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

/** `21 Aug 2026` */
export function formatDate(value?: string | Date | null): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return DATE_FORMATTER.format(date);
}

export type FollowUpUrgency = "overdue" | "due-today";

/** Undefined when there's no follow-up date set, or it's still in the future. */
export function followUpUrgency(followUpAt?: string): FollowUpUrgency | undefined {
  if (!followUpAt) return undefined;
  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const due = new Date(followUpAt);
  if (Number.isNaN(due.getTime())) return undefined;
  if (due.getTime() < startOfToday.getTime()) return "overdue";
  if (due.getTime() === startOfToday.getTime()) return "due-today";
  return undefined;
}

/** `21 Aug 2026, 04:30 pm` */
export function formatDateTime(value?: string | Date | null): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return DATE_TIME_FORMATTER.format(date);
}

/** `21-08-2026` — the form used on printed documents. */
export function formatDocumentDate(value?: string | Date | null): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${date.getFullYear()}`;
}

export function formatRelative(value?: string | Date | null): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(date);
}

/** `NEW` -> `New`, `UNDER_REVIEW` -> `Under review` */
export function humanizeStatus(status: string): string {
  const lower = status.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  INTERESTED: "Interested",
  FOLLOW_UP: "Follow up",
  ADMITTED: "Admitted",
  REJECTED: "Rejected",
};

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  SHORTLISTED: "Shortlisted",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export const SOURCE_LABELS: Record<string, string> = {
  WEBSITE: "Website",
  API: "API",
  MANUAL: "Manual entry",
};

export function formatSource(source: string): string {
  return SOURCE_LABELS[source] ?? humanizeStatus(source);
}

export function formatPhone(phone?: string | null): string {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  return phone;
}

export function joinAddress(address?: {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  pincode?: string;
}): string {
  if (!address) return "";
  const street = [address.addressLine1, address.addressLine2].filter(Boolean).join(", ");
  const region = [address.city, address.state].filter(Boolean).join(", ");
  const tail = address.pincode ? `${region} - ${address.pincode}` : region;
  return [street, tail].filter(Boolean).join(", ");
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
