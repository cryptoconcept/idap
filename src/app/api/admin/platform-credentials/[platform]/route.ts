import type { NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/tenant";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";
import { PLATFORMS, type Platform } from "@/lib/constants";
import { PlatformCredentialService } from "@/services/platform-credential.service";

export const dynamic = "force-dynamic";

function toPlatform(value: string): Platform {
  if (!PLATFORMS.includes(value as Platform)) {
    throw validationError("Unknown platform");
  }
  return value as Platform;
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/admin/platform-credentials/[platform]">,
) {
  try {
    assertSameOrigin(request);
    const user = await requireSuperAdmin();
    const { platform } = await context.params;

    await PlatformCredentialService.remove(toPlatform(platform), {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ removed: true });
  } catch (error) {
    return handleApiError(error);
  }
}
