import type { NextRequest } from "next/server";
import { credentialScope, requireInstitution, requireUser } from "@/lib/tenant";
import { createApiClientSchema } from "@/lib/validation/api-client";
import { ApiClientService } from "@/services/api-client.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const requested = request.nextUrl.searchParams.get("institutionId");
    const clients = await ApiClientService.list(credentialScope(user, requested));
    return jsonSuccess({ clients });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Only an institution admin can issue credentials, and only for their own
 * institution. A platform admin is excluded on purpose: a key carrying
 * READ_APPLICATION would otherwise be a route around the rule that platform
 * admins cannot read tenant data.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const body = await request.json().catch(() => ({}));
    const data = createApiClientSchema.parse(body);

    const result = await ApiClientService.create({
      institutionId: institution.institutionId,
      name: data.name,
      permissions: data.permissions,
      actor: { id: user.id, name: user.name },
    });

    return jsonSuccess({ ...result }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
