import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { fetchScholarshipHubDocument } from "@/lib/connectors/scholarship-hub-partner-client";
import { ScholarshipApplication } from "@/models";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { handleApiError, jsonError } from "@/lib/api/response";

export const dynamic = "force-dynamic";

const DOCUMENT_RATE_LIMIT = { limit: 120, windowSeconds: 900 };

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/scholarship-applications/[id]/documents/[key]/file">,
) {
  try {
    const { user } = await requireApiUser(request);
    requirePermission(user, "SCHOLARSHIP_APPLICATIONS_VIEW");
    const { id, key } = await context.params;

    const limit = await consumeRateLimit(`scholarship-app-doc:${user.id}`, DOCUMENT_RATE_LIMIT.limit, DOCUMENT_RATE_LIMIT.windowSeconds);
    if (!limit.allowed) {
      return jsonError("RATE_LIMITED", "You've requested a lot of documents recently. Please slow down.", { headers: rateLimitHeaders(limit) });
    }

    const application = await ScholarshipApplication.findOne({ _id: id, ...tenantFilter(user) })
      .select("hubApplicationId documents")
      .lean();
    if (!application) return jsonError("NOT_FOUND", "Document not found", { status: 404 });

    const hasDocument = (application.documents ?? []).some((d) => d.key === key);
    if (!hasDocument) return jsonError("NOT_FOUND", "Document not found", { status: 404 });

    const upstream = await fetchScholarshipHubDocument(application.hubApplicationId, key);
    if (!upstream.ok || !upstream.body) {
      return jsonError("NOT_FOUND", "Document not found", { status: 404 });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "Content-Disposition": upstream.headers.get("content-disposition") ?? "attachment",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
