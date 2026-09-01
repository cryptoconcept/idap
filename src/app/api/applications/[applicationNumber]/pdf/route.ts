import type { NextRequest } from "next/server";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution } from "@/models";
import { requireApiUser, serializeInstitution, tenantFilter } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { ApplicationService } from "@/services/application.service";
import { ActivityService } from "@/services/activity.service";
import { buildApplicationPdf } from "@/lib/pdf/application-pdf";
import { handleApiError } from "@/lib/api/response";
import { notFound } from "@/lib/api/errors";

// PDFKit is a Node-only library; keep this handler on the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/applications/[applicationNumber]/pdf">,
) {
  try {
    const { user } = await requireApiUser(request);
    requirePermission(user, "APPLICATIONS_VIEW");
    const { applicationNumber } = await context.params;

    const application = await ApplicationService.getApplication(
      tenantFilter(user),
      applicationNumber,
    );

    await connectToDatabase();
    const institutionDoc = await Institution.findOne({
      institutionId: application.institutionId,
    }).lean();
    if (!institutionDoc) throw notFound("Institution not found");

    const pdf = await buildApplicationPdf(application, serializeInstitution(institutionDoc));

    await ActivityService.record({
      institutionId: application.institutionId,
      entityType: "APPLICATION",
      entityId: application.id,
      entityRef: application.applicationNumber,
      action: "PDF downloaded",
      performedBy: user.id,
      performedByName: user.name,
    });

    const disposition = request.nextUrl.searchParams.get("inline") === "1" ? "inline" : "attachment";

    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${disposition}; filename="${application.applicationNumber}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
