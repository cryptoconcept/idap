import type { NextRequest } from "next/server";
import { credentialScope, requireUser } from "@/lib/tenant";
import { ApiClientService } from "@/services/api-client.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/**
 * Revokes a credential. Available to the owning institution and to platform
 * admins, who need to be able to shut off a leaked key. The record is retained
 * so audit history stays intact.
 */
export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/api-clients/[id]">,
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;

    const client = await ApiClientService.revoke({
      tenantClause: credentialScope(user),
      id,
      actor: { id: user.id, name: user.name },
    });

    return jsonSuccess({ client });
  } catch (error) {
    return handleApiError(error);
  }
}
