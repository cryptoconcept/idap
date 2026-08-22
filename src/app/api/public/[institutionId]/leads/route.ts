import type { NextRequest } from "next/server";
import { createLeadSchema } from "@/lib/validation/lead";
import { LeadService } from "@/services/lead.service";
import { InstitutionService } from "@/services/institution.service";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { PUBLIC_FORM_RATE_LIMIT } from "@/lib/constants";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { publicCorsPreflight } from "@/lib/api/v1-handler";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated submission from the hosted enquiry page. There is no API key
 * here by design, so the institution comes from the URL and the endpoint is
 * rate limited per IP and only serves active institutions.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/public/[institutionId]/leads">,
) {
  try {
    const { institutionId } = await context.params;
    const ip = getClientIp(request);

    const limit = await consumeRateLimit(
      `public-lead:${ip}:${institutionId}`,
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
    const data = createLeadSchema.parse(body);

    const lead = await LeadService.createLead({
      institutionId: institution.institutionId,
      data,
      source: "WEBSITE",
      ipAddress: ip,
    });

    return jsonSuccess(
      { leadNumber: lead.leadNumber, message: "Enquiry submitted successfully" },
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
