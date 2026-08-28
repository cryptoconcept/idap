import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { VacancyPublishService } from "@/services/vacancy-publish.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/**
 * The school's explicit "publish this to eduFleet" action — the only thing in
 * IDAP that puts a vacancy on a public jobs board, and the only caller of
 * `VacancyPublishService.publish`.
 *
 * It is deliberately thin. Every rule that governs a push already lives in the
 * service — which contract to use, the city gate, the preflight that keeps a
 * doomed body from burning a daily write unit (the school's own under
 * Contract Two, the platform-wide pool under Contract One), how a `403`
 * or a `409` is recorded — and re-stating any of it here would give the
 * product two answers to the same question. What this file owns is the three
 * things a route owns: the request is same-origin, the caller is an
 * institution admin, and the tenant the push runs under comes from the
 * SESSION.
 *
 * `institution.institutionId` is that last point, and it is the whole of this
 * route's authorisation: `vacancyId` arrives from the URL, so it is a claim,
 * not a permission. The service's `loadVacancy` filters on both, which is what
 * turns another school's vacancy id into a 404 instead of a push against their
 * live advert.
 *
 * **A refused push and a blocked listing answer differently, on purpose.**
 * Anything the service refused before the wire — a `DRAFT`, a missing city, a
 * failing preflight, no eduFleet credential — is a thrown `AppError` and
 * becomes a 4xx here through `handleApiError`, because the request genuinely
 * was not valid yet and nothing was sent. Anything eduFleet itself answered is
 * a returned outcome and comes back **200 with `outcome.status`** — including
 * `BLOCKED` and `CONFLICT`. Those are states of the listing the school has to
 * read and act on, not failed requests: the push happened, a write unit was
 * spent, and the reason was recorded on the listing. Mapping them to a 4xx
 * would tell the client "this didn't happen" about something that did, and
 * would invite exactly the retry that costs another unit for the same answer.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/settings/vacancies/[vacancyId]/publish">,
) {
  try {
    assertSameOrigin(request);
    const { vacancyId } = await context.params;
    const { user, institution } = await requireInstitution();

    const outcome = await VacancyPublishService.publish(institution.institutionId, vacancyId, {
      id: user.id,
      name: user.name,
    });

    // The outcome carries the listing the service just recorded, so the client
    // never has to re-fetch to learn what changed. There is no body to parse
    // and none is read: publishing takes no input beyond which vacancy, and
    // accepting any would be a second, unvalidated way to influence what gets
    // sent to a public jobs board.
    return jsonSuccess({ outcome });
  } catch (error) {
    return handleApiError(error);
  }
}
