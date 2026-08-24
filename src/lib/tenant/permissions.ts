import "server-only";
import { ROLE_PERMISSIONS, type Permission } from "@/lib/constants";
import { forbidden } from "@/lib/api/errors";
import type { CurrentUser } from "@/lib/auth/current-user";

export function hasPermission(user: CurrentUser, permission: Permission): boolean {
  return ROLE_PERMISSIONS[user.role]?.has(permission) ?? false;
}

/** The sole place a route asks "may this user do this specific thing." */
export function requirePermission(user: CurrentUser, permission: Permission): void {
  if (!hasPermission(user, permission)) throw forbidden();
}
