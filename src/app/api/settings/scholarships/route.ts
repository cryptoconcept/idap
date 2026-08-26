import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { createScholarshipSchema } from "@/lib/validation/scholarship";
import { ScholarshipService } from "@/services/scholarship.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const scholarships = await ScholarshipService.list(institution.institutionId);
    return jsonSuccess({ scholarships });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = createScholarshipSchema.parse(await request.json().catch(() => ({})));

    const scholarship = await ScholarshipService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ scholarship }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
