import { requireInstitution } from "@/lib/tenant";
import { ConnectionService } from "@/services/connection.service";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const connections = await ConnectionService.list(institution.institutionId);
    return jsonSuccess({ connections });
  } catch (error) {
    return handleApiError(error);
  }
}
