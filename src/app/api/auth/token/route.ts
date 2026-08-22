import type { NextRequest } from "next/server";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution, User } from "@/models";
import { mobileTokenSchema } from "@/lib/validation/user";
import { fakeVerify, verifyPassword } from "@/lib/security/password";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { LOGIN_RATE_LIMIT } from "@/lib/constants";
import { signAccessToken } from "@/lib/auth/session";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { PLATFORM_ADMIN_DENIED } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const ACCESS_TOKEN_SECONDS = 900;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const credentials = mobileTokenSchema.parse(body);
    const ip = getClientIp(request);

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
      await fakeVerify();
      return jsonError("UNAUTHORIZED", "Incorrect email or password");
    }

    const valid = await verifyPassword(credentials.password, user.passwordHash);
    if (!valid || !user.active) {
      return jsonError("UNAUTHORIZED", "Incorrect email or password");
    }

    // The app is for institution staff. A platform admin has no tenant data to
    // show, and issuing them a token would be a way around that boundary.
    if (user.role === "SUPER_ADMIN" || !user.institutionId) {
      return jsonError("FORBIDDEN", PLATFORM_ADMIN_DENIED);
    }

    const institution = await Institution.findOne({ institutionId: user.institutionId })
      .select("active")
      .lean();
    if (!institution?.active) {
      return jsonError("FORBIDDEN", "This institution account is currently inactive");
    }

    const accessToken = await signAccessToken({
      sub: String(user._id),
      role: user.role,
      institutionId: user.institutionId,
      name: user.name,
      email: user.email,
      v: user.sessionVersion ?? 0,
    });

    const { token: refreshToken } = await RefreshTokenService.issue({
      userId: String(user._id),
      deviceId: credentials.deviceId,
    });

    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    return jsonSuccess({
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_SECONDS,
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        institutionId: user.institutionId,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
