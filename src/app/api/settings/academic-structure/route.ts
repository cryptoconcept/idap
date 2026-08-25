import { requireInstitution } from "@/lib/tenant";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { ACADEMIC_BLUEPRINTS } from "@/lib/academic/blueprints";
import { ACADEMIC_SEGMENTS, ACADEMIC_SEGMENT_LABELS } from "@/lib/constants";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** One call feeds the whole editor: the selection, the vocabulary, and the data. */
export async function GET() {
  try {
    const { institution } = await requireInstitution();

    const [segments, units] = await Promise.all([
      AcademicStructureService.getSegments(institution.institutionId),
      AcademicStructureService.list(institution.institutionId),
    ]);

    return jsonSuccess({
      segments,
      // The full map, not just the selected segments': the segment checkbox row
      // has to label segments the institution has not ticked, and the editor
      // must never hardcode a level label.
      availableSegments: ACADEMIC_SEGMENTS,
      segmentLabels: ACADEMIC_SEGMENT_LABELS,
      blueprints: ACADEMIC_BLUEPRINTS,
      units,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
