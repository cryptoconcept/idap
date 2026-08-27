import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { assertPlatform, ConnectionService } from "@/services/connection.service";

export const dynamic = "force-dynamic";

/**
 * Local disconnect only — status flips to `DISCONNECTED` and the grant
 * ciphertext is dropped. The remote grant itself is revoked from the
 * platform's own dashboard (UI copy explains this — see Task 9).
 */
export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/connections/[platform]">,
) {
  try {
    assertSameOrigin(request);
    const { platform } = await context.params;
    const { user, institution } = await requireInstitution();

    const connection = await ConnectionService.disconnect(
      institution.institutionId,
      assertPlatform(platform),
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ connection });
  } catch (error) {
    return handleApiError(error);
  }
}
