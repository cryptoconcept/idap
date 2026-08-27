import type { NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/tenant";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { upsertPlatformCredentialSchema } from "@/lib/validation/platform-credential";
import { PlatformCredentialService } from "@/services/platform-credential.service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const result = await PlatformCredentialService.list();
    return jsonSuccess({ ...result });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Creates or updates one platform's credential. `key` is optional on the
 * request body — see `upsertPlatformCredentialSchema` and
 * `PlatformCredentialService.upsert` for why that matters.
 */
export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireSuperAdmin();
    const body = await request.json().catch(() => ({}));
    const data = upsertPlatformCredentialSchema.parse(body);

    const credential = await PlatformCredentialService.upsert(
      data.platform,
      { key: data.key, baseUrl: data.baseUrl, active: data.active },
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ credential });
  } catch (error) {
    return handleApiError(error);
  }
}
