import "server-only";
import type { NextRequest } from "next/server";
import { connectToDatabase } from "@/lib/db/mongoose";
import { User } from "@/models";
import { verifyAccessToken } from "./session";
import type { CurrentUser } from "./current-user";
import type { UserRole } from "@/lib/constants";

/**
 * Resolves a mobile caller from an Authorization header. Like the cookie path,
 * the user record is re-checked on every request so deactivation and session
 * rotation take effect immediately rather than at token expiry.
 */
export async function resolveBearerUser(request: NextRequest): Promise<CurrentUser | null> {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;

  const payload = await verifyAccessToken(header.slice(7).trim());
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
}
