import { clearSessionCookie } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/auth/current-user";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { ActivityService } from "@/services/activity.service";

export async function POST() {
  try {
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
