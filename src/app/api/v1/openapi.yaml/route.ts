import type { NextRequest } from "next/server";
import { stringify } from "yaml";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { InstitutionService } from "@/services/institution.service";
import { getAppOrigin } from "@/lib/utils/origin";
import { handleApiError } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** The same document as `openapi.json`, for tooling that expects YAML. */
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

    return new Response(stringify(document, { lineWidth: 0 }), {
      headers: {
        "Content-Type": "application/yaml; charset=utf-8",
        "Content-Disposition": 'inline; filename="idap-api.openapi.yaml"',
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
