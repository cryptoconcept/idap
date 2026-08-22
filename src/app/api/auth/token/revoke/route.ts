import type { NextRequest } from "next/server";
import { refreshTokenSchema } from "@/lib/validation/user";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { DeviceService } from "@/services/device.service";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** Sign-out. Always reports success so a caller cannot probe token validity. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { refreshToken } = refreshTokenSchema.parse(body);
    const revoked = await RefreshTokenService.revokeToken(refreshToken);

    // Signing out has to take the push subscription with it. Notifications
    // carry applicant names to the lock screen by design (spec §6), so a phone
    // left registered after sign-out keeps showing them to whoever holds it.
    // Scoped to the row's own device rather than every device this user owns:
    // signing out of one handset must not silence the others.
    if (revoked) {
      await DeviceService.removeForDevice(revoked.userId, revoked.deviceId);
    }

    return jsonSuccess({ message: "Signed out" });
  } catch (error) {
    return handleApiError(error);
  }
}
