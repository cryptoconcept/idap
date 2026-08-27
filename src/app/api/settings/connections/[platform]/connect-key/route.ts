import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { connectWithKeySchema } from "@/lib/validation/connection";
import { assertPlatform, ConnectionService } from "@/services/connection.service";

export const dynamic = "force-dynamic";

/**
 * FeesBasket's paste-key connect flow. In this plan (9a) no adapter
 * implements `connectWithKey`, so this always refuses — see
 * `ConnectionService.connectWithKey`'s doc comment.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/settings/connections/[platform]/connect-key">,
) {
  try {
    assertSameOrigin(request);
    const { platform } = await context.params;
    const { user, institution } = await requireInstitution();
    const { key } = connectWithKeySchema.parse(await request.json().catch(() => ({})));

    const connection = await ConnectionService.connectWithKey(
      institution.institutionId,
      assertPlatform(platform),
      key,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ connection });
  } catch (error) {
    return handleApiError(error);
  }
}
