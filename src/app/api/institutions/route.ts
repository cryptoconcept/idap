import type { NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/tenant";
import { createInstitutionSchema } from "@/lib/validation/institution";
import { InstitutionService } from "@/services/institution.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin();
    const params = request.nextUrl.searchParams;
    const activeParam = params.get("active");

    const result = await InstitutionService.list({
      q: params.get("q") ?? undefined,
      active: activeParam === null ? undefined : activeParam === "true",
      page: Number(params.get("page") ?? 1),
      pageSize: Math.min(Number(params.get("pageSize") ?? 20), 100),
    });

    return jsonSuccess({ ...result });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireSuperAdmin();
    const body = await request.json().catch(() => ({}));
    const data = createInstitutionSchema.parse(body);

    const result = await InstitutionService.create(data, { id: user.id, name: user.name });
    return jsonSuccess({ ...result }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
