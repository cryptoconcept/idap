import type { NextRequest } from "next/server";
import { refreshTokenSchema } from "@/lib/validation/user";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** Sign-out. Always reports success so a caller cannot probe token validity. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { refreshToken } = refreshTokenSchema.parse(body);
    await RefreshTokenService.revokeToken(refreshToken);
    return jsonSuccess({ message: "Signed out" });
  } catch (error) {
    return handleApiError(error);
  }
}
