import type { NextRequest } from "next/server";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { InstitutionService } from "@/services/institution.service";
import { getAppOrigin } from "@/lib/utils/origin";
import { handleApiError } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/openapi.json[?institution=INS0001]
 *
 * The spec itself carries no secrets, so it is public — that is what lets a
 * developer point Swagger UI or Postman straight at the URL. An unknown
 * institution silently falls back to the placeholder examples rather than
 * erroring, so this cannot be used to probe which institution IDs exist.
 */
export async function GET(request: NextRequest) {
  try {
    const requested = request.nextUrl.searchParams.get("institution");
    const origin = await getAppOrigin();

    const institution = requested
      ? await InstitutionService.getPublicBranding(requested)
      : null;

    const document = buildOpenApiDocument({
      origin,
      institutionId: institution?.institutionId,
      institutionName: institution?.institutionName,
      slug: institution?.slug,
    });

    return new Response(JSON.stringify(document, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'inline; filename="idap-api.openapi.json"',
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
