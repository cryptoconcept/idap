import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { ResultService } from "@/services/result.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const ACTIONS = ["publish", "unpublish", "archive"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/settings/results/[resultId]/publish">,
) {
  try {
    assertSameOrigin(request);
    const { resultId } = await context.params;
    const { user, institution } = await requireInstitution();

    const body = (await request.json().catch(() => ({}))) as { action?: string };
    if (!ACTIONS.includes(body.action as Action)) {
      throw validationError(`action: must be one of ${ACTIONS.join(", ")}`);
    }

    const result = await ResultService.setStatus(
      institution.institutionId,
      resultId,
      body.action as Action,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ result });
  } catch (error) {
    return handleApiError(error);
  }
}
