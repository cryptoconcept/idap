import type { NextRequest } from "next/server";
import { clearSessionCookie } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/auth/current-user";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { ActivityService } from "@/services/activity.service";

export async function POST(request: NextRequest) {
  try {
    // Audit SEC-L3: logout is state-changing and cookie-scoped, so a
    // cross-site POST could force-clear a victim's session. SameSite=Lax
    // already blocks the cookie cross-site; this closes it explicitly.
    assertSameOrigin(request);
    const user = await getCurrentUser();
    await clearSessionCookie();

    if (user) {
      await ActivityService.record({
        institutionId: user.institutionId ?? "PLATFORM",
        entityType: "USER",
        entityId: user.id,
        action: "Signed out",
        performedBy: user.id,
        performedByName: user.name,
      });
    }

    return jsonSuccess({ message: "Signed out" });
  } catch (error) {
    return handleApiError(error);
  }
}
