import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { ApplicationService } from "@/services/application.service";
import { DocumentService } from "@/services/document.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { validationError } from "@/lib/api/errors";
import { DOCUMENT_TYPES, type DocumentType } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/applications/[applicationNumber]/documents">,
) {
  try {
    const { user } = await requireApiUser(request);
    requirePermission(user, "APPLICATIONS_VIEW");
    const { applicationNumber } = await context.params;
    const application = await ApplicationService.getApplication(
      tenantFilter(user),
      applicationNumber,
    );
    const documents = await DocumentService.listForApplication(
      application.institutionId,
      application.id,
    );
    return jsonSuccess({ documents });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/applications/[applicationNumber]/documents">,
) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    requirePermission(user, "APPLICATIONS_CREATE");
    const { applicationNumber } = await context.params;

    const form = await request.formData();
    const file = form.get("file");
    const documentType = String(form.get("documentType") ?? "");

    if (!(file instanceof File)) throw validationError("file: choose a file to upload");
    if (!DOCUMENT_TYPES.includes(documentType as DocumentType)) {
      throw validationError("documentType: choose what kind of document this is");
    }

    // Resolving through the service enforces the tenant clause before writing.
    const application = await ApplicationService.getApplication(
      tenantFilter(user),
      applicationNumber,
    );

    const document = await DocumentService.upload({
      institutionId: application.institutionId,
      applicationId: application.id,
      documentType: documentType as DocumentType,
      file: {
        name: file.name,
        type: file.type,
        size: file.size,
        bytes: Buffer.from(await file.arrayBuffer()),
      },
      actor: { id: user.id, name: user.name },
    });

    return jsonSuccess({ document }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
