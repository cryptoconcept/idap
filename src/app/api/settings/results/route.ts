import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { createResultSchema } from "@/lib/validation/result";
import { ResultService } from "@/services/result.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const results = await ResultService.list(institution.institutionId);
    return jsonSuccess({ results });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = createResultSchema.parse(await request.json().catch(() => ({})));

    const result = await ResultService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ result });
  } catch (error) {
    // A duplicate cycle arrives here as a Mongo 11000, which handleApiError
    // already maps to CONFLICT — the unique index is the check, not a pre-read.
    return handleApiError(error);
  }
}
