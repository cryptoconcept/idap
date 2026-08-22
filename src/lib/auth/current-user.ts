import "server-only";
import { cache } from "react";
import { connectToDatabase } from "@/lib/db/mongoose";
import { User } from "@/models";
import { readSessionCookie, verifySessionToken } from "./session";
import type { UserRole } from "@/lib/constants";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  institutionId?: string;
};

/**
 * Resolves the signed-in user from the HTTP-only session cookie and re-checks
 * the database record, so deactivated users and rotated sessions stop working
 * immediately rather than at token expiry. `cache` dedupes this per request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = await readSessionCookie();
  if (!token) return null;

  const payload = await verifySessionToken(token);
  if (!payload) return null;

  await connectToDatabase();
  const user = await User.findById(payload.sub).lean();
  if (!user || !user.active) return null;
  if ((user.sessionVersion ?? 0) !== payload.v) return null;

  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role as UserRole,
    institutionId: user.institutionId ?? undefined,
  };
});
