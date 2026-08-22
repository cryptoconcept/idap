import { getCurrentUser } from "@/lib/auth/current-user";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return jsonError("UNAUTHORIZED", "Authentication required");
    return jsonSuccess({ user });
  } catch (error) {
    return handleApiError(error);
  }
}
