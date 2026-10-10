import "server-only";
import { ROLE_PERMISSIONS, type Permission } from "@/lib/constants";
import { forbidden, notFound } from "@/lib/api/errors";
import type { CurrentUser } from "@/lib/auth/current-user";

export function hasPermission(user: CurrentUser, permission: Permission): boolean {
  return ROLE_PERMISSIONS[user.role]?.has(permission) ?? false;
}

/** The sole place a route asks "may this user do this specific thing." */
export function requirePermission(user: CurrentUser, permission: Permission): void {
  if (!hasPermission(user, permission)) throw forbidden();
}

/**
 * A role holding LEADS_VIEW_ALL sees everything; otherwise the query is
 * scoped to leads assigned to this user plus unassigned ones. This degrades
 * correctly for FRONT_DESK, who is never a valid assignment target — their
 * "mine" clause simply never matches, leaving only unassigned leads, which is
 * exactly their intake queue.
 */
export function leadVisibilityFilter(user: CurrentUser): Record<string, unknown> {
  if (hasPermission(user, "LEADS_VIEW_ALL")) return {};
  return { $or: [{ assignedTo: user.id }, { assignedTo: null }] };
}

/**
 * Ownership, not just visibility: even a lead a COUNSELOR can see (because it
 * is unassigned) is not theirs to update or set a follow-up on. NOT_FOUND
 * rather than FORBIDDEN, matching the platform's cross-tenant convention —
 * a lead outside your reach is indistinguishable from one that isn't there.
 * INSTITUTION_ADMIN always passes; this check exists only because the table
 * grants COUNSELOR its permissions without per-document scoping.
 */
export function assertOwnsLead(
  user: CurrentUser,
  lead: { assignedTo?: string | null },
): void {
  if (user.role === "INSTITUTION_ADMIN") return;
  if (lead.assignedTo !== user.id) throw notFound("Enquiry not found");
}

/**
 * Mirrors `leadVisibilityFilter`. There is no SCHOLARSHIP_APPLICATIONS_VIEW_ALL
 * permission — SCHOLARSHIP_APPLICATIONS_ASSIGN is the natural "sees
 * everything" gate instead, since only INSTITUTION_ADMIN holds it today and
 * a counselor works the applications assigned to them while reassignment is
 * an admin action. A role holding ASSIGN sees every application; otherwise
 * the query is scoped to applications assigned to this user plus unassigned
 * ones.
 */
export function scholarshipApplicationVisibilityFilter(user: CurrentUser): Record<string, unknown> {
  if (hasPermission(user, "SCHOLARSHIP_APPLICATIONS_ASSIGN")) return {};
  return { $or: [{ assignedTo: user.id }, { assignedTo: null }] };
}
