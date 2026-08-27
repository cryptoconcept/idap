import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { alumnusCreateSchema } from "@/lib/validation/showcase";
import { AlumniService } from "@/services/alumni.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const alumni = await AlumniService.list(institution.institutionId);
    return jsonSuccess({ alumni });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = alumnusCreateSchema.parse(await request.json().catch(() => ({})));

    // `institution.institutionId` — the tenant — comes from the session
    // (`requireInstitution`), never from `input`. But `institutionId` is NOT
    // why this parse matters: `AlumniService.create` re-assigns it after the
    // object spread (`{ ...input, institutionId, status: "ACTIVE" }`), so a
    // smuggled `institutionId` is neutralised at the service regardless of
    // whether this route parses at all. What this parse actually guards are
    // the two fields the service does NOT re-assign: `photo` (an ordinary
    // schema path on `Alumnus` — a storage key written only by the upload
    // endpoint, Task 7's `setPhoto` — deliberately absent from
    // `alumnusCreateSchema`, so an unparsed body could plant a reference to
    // another institution's stored object, bypassing the upload path's
    // magic-byte check, size cap and old-object cleanup entirely) and `_id`
    // (also a real, unguarded Mongoose path with no re-assignment — an
    // attacker-chosen document id `create` would otherwise accept as-is).
    // Neither appears in `alumnusCreateSchema`, so `.parse()` strips both
    // before any of this runs.
    const alumnus = await AlumniService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ alumnus });
  } catch (error) {
    return handleApiError(error);
  }
}
