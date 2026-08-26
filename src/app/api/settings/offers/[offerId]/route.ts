import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { updateOfferSchema } from "@/lib/validation/offer";
import { OfferService } from "@/services/offer.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/settings/offers/[offerId]">,
) {
  try {
    const { offerId } = await context.params;
    const { institution } = await requireInstitution();
    const offer = await OfferService.get(institution.institutionId, offerId);
    return jsonSuccess({ offer });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/settings/offers/[offerId]">,
) {
  try {
    assertSameOrigin(request);
    const { offerId } = await context.params;
    const { user, institution } = await requireInstitution();
    const input = updateOfferSchema.parse(await request.json().catch(() => ({})));

    const offer = await OfferService.update(
      institution.institutionId,
      offerId,
      input,
      { id: user.id, name: user.name },
    );

    return jsonSuccess({ offer });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/settings/offers/[offerId]">,
) {
  try {
    assertSameOrigin(request);
    const { offerId } = await context.params;
    const { user, institution } = await requireInstitution();

    await OfferService.remove(institution.institutionId, offerId, {
      id: user.id,
      name: user.name,
    });

    return jsonSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
