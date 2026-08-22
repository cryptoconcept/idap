import type { NextRequest } from "next/server";
import { withApiClient, corsPreflight } from "@/lib/api/v1-handler";
import { ApplicationService } from "@/services/application.service";
import { jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/applications/{applicationNumber}
 *
 * Scoped to the credential's institution, and deliberately narrower than the
 * dashboard view: notes, activity and internal metadata are never returned.
 */
export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/v1/applications/[applicationNumber]">,
) {
  return withApiClient(request, "READ_APPLICATION", async (auth) => {
    const { applicationNumber } = await context.params;

    const application = await ApplicationService.getApplication(
      { institutionId: auth.institutionId },
      applicationNumber,
    );

    return jsonSuccess({
      application: {
        applicationNumber: application.applicationNumber,
        status: application.status,
        academicYear: application.academicYear,
        student: {
          firstName: application.student.firstName,
          middleName: application.student.middleName,
          lastName: application.student.lastName,
          dateOfBirth: application.student.dateOfBirth,
          gender: application.student.gender,
        },
        parent: {
          fatherName: application.parent.fatherName,
          motherName: application.parent.motherName,
          guardianName: application.parent.guardianName,
          phone: application.parent.phone,
          email: application.parent.email,
        },
        address: application.address,
        academic: application.academic,
        admission: application.admission,
        documents: application.documents.map((document) => ({
          documentType: document.documentType,
          fileName: document.fileName,
          uploadedAt: document.uploadedAt,
        })),
        submittedAt: application.createdAt,
        updatedAt: application.updatedAt,
      },
    });
  });
}

export async function OPTIONS() {
  return corsPreflight();
}
