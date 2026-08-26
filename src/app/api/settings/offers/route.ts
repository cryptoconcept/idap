import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { createOfferSchema } from "@/lib/validation/offer";
import { OfferService } from "@/services/offer.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const offers = await OfferService.list(institution.institutionId);
    return jsonSuccess({ offers });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const input = createOfferSchema.parse(await request.json().catch(() => ({})));

    const offer = await OfferService.create(institution.institutionId, input, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ offer }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
