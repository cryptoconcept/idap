import type { NextRequest } from "next/server";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution, User } from "@/models";
import { loginSchema } from "@/lib/validation/user";
import { fakeVerify, verifyPassword } from "@/lib/security/password";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { LOGIN_RATE_LIMIT } from "@/lib/constants";
import { setSessionCookie, signSession } from "@/lib/auth/session";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { ActivityService } from "@/services/activity.service";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const credentials = loginSchema.parse(body);
    const ip = getClientIp(request);

    // Brute-force guard, bucketed per IP + account so one attacker cannot lock
    // every account from a single address.
    const limit = await consumeRateLimit(
      `login:${ip}:${credentials.email}`,
      LOGIN_RATE_LIMIT.limit,
      LOGIN_RATE_LIMIT.windowSeconds,
    );
    if (!limit.allowed) {
      return jsonError("RATE_LIMITED", "Too many sign-in attempts. Try again in a few minutes.", {
        headers: rateLimitHeaders(limit),
      });
    }

    await connectToDatabase();
    const user = await User.findOne({ email: credentials.email }).select("+passwordHash").lean();

    if (!user) {
      // Keep the timing profile identical whether or not the account exists.
      await fakeVerify();
      return jsonError("UNAUTHORIZED", "Incorrect email or password");
    }

    const valid = await verifyPassword(credentials.password, user.passwordHash);
    if (!valid || !user.active) {
      return jsonError("UNAUTHORIZED", "Incorrect email or password");
    }

    if (user.role === "INSTITUTION_ADMIN") {
      const institution = await Institution.findOne({ institutionId: user.institutionId })
        .select("active")
        .lean();
      if (!institution?.active) {
        return jsonError(
          "FORBIDDEN",
          "This institution account is inactive. Contact your platform administrator.",
        );
      }
    }

    const token = await signSession({
      sub: String(user._id),
      role: user.role,
      institutionId: user.institutionId ?? undefined,
      name: user.name,
      email: user.email,
      v: user.sessionVersion ?? 0,
    });
    await setSessionCookie(token);

    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    await ActivityService.record({
      institutionId: user.institutionId ?? "PLATFORM",
      entityType: "USER",
      entityId: user._id,
      action: "Signed in",
      performedBy: user._id,
      performedByName: user.name,
      ipAddress: ip,
    });

    return jsonSuccess({
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
        institutionId: user.institutionId ?? undefined,
      },
      redirectTo: user.role === "SUPER_ADMIN" ? "/admin" : "/dashboard",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
