import type { NextRequest } from "next/server";
import { createApplicationSchema } from "@/lib/validation/application";
import { ApplicationService } from "@/services/application.service";
import { InstitutionService } from "@/services/institution.service";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_FORM_RATE_LIMIT } from "@/lib/constants";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

/** Unauthenticated submission from the hosted admission application page. */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/public/[institutionId]/applications">,
) {
  try {
    const { institutionId } = await context.params;
    const ip = getClientIp(request);

    const limit = await consumeRateLimit(
      `public-application:${ip}:${institutionId}`,
      PUBLIC_FORM_RATE_LIMIT.limit,
      PUBLIC_FORM_RATE_LIMIT.windowSeconds,
    );
    if (!limit.allowed) {
      return jsonError("RATE_LIMITED", "Too many submissions. Please try again in a minute.", {
        headers: {
          ...rateLimitHeaders(limit),
          "Retry-After": String(limit.retryAfterSeconds),
        },
      });
    }

    const institution = await InstitutionService.getPublicBranding(institutionId);
    if (!institution) return jsonError("NOT_FOUND", "Institution not found");

    const body = await request.json().catch(() => ({}));
    const data = createApplicationSchema.parse(body);

    const application = await ApplicationService.createApplication({
      institutionId: institution.institutionId,
      data,
      source: "WEBSITE",
      ipAddress: ip,
    });

    return jsonSuccess(
      {
        applicationNumber: application.applicationNumber,
        status: application.status,
      },
      { status: 201, headers: rateLimitHeaders(limit) },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/** Browsers preflight the JSON POST from the institution's own website. */
export async function OPTIONS() {
  return publicCorsPreflight();
}
