import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { FeeStructureService } from "@/services/fee-structure.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const ACTIONS = ["publish", "unpublish", "archive"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/settings/fees/[feeId]/publish">,
) {
  try {
    assertSameOrigin(request);
    const { feeId } = await context.params;
    const { user, institution } = await requireInstitution();

    const body = (await request.json().catch(() => ({}))) as { action?: string };
    if (!ACTIONS.includes(body.action as Action)) {
      throw validationError(`action: must be one of ${ACTIONS.join(", ")}`);
    }

    const feeStructure = await FeeStructureService.setStatus(
      institution.institutionId,
      feeId,
      body.action as Action,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ feeStructure });
  } catch (error) {
    return handleApiError(error);
  }
}
