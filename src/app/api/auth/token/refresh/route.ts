import type { NextRequest } from "next/server";
import { connectToDatabase } from "@/lib/db/mongoose";
import { User } from "@/models";
import { refreshTokenSchema } from "@/lib/validation/user";
import { signAccessToken } from "@/lib/auth/session";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

const ACCESS_TOKEN_SECONDS = 900;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { refreshToken } = refreshTokenSchema.parse(body);

    const rotated = await RefreshTokenService.rotate(refreshToken);
    // Null covers unknown, expired, revoked and reused. The caller is told
    // nothing that would let them tell those apart.
    if (!rotated) return jsonError("UNAUTHORIZED", "Session expired. Please sign in again.");

    await connectToDatabase();
    const user = await User.findById(rotated.userId).lean();
    if (!user || !user.active || user.role === "SUPER_ADMIN" || !user.institutionId) {
      return jsonError("UNAUTHORIZED", "Session expired. Please sign in again.");
    }

    const accessToken = await signAccessToken({
      sub: String(user._id),
      role: user.role,
      institutionId: user.institutionId,
      name: user.name,
      email: user.email,
      v: user.sessionVersion ?? 0,
    });

    return jsonSuccess({
      accessToken,
      refreshToken: rotated.token,
      expiresIn: ACCESS_TOKEN_SECONDS,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
