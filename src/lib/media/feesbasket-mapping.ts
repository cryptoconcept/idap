import { assertExternallyReachable, toPublicUrl } from "@/lib/media/public-url";
import type { MediaKind, MediaStatus } from "@/lib/constants";

/**
 * FeesBasket media mapping — the pure core.
 *
 * Given IDAP's own media items plus the live `mediaKinds` vocabulary
 * FeesBasket's `GET /partner/me` reports, produces the wire objects Plan 9b's
 * FeesBasket adapter will place under `IngestionPayload.media[]`
 * (`docs/integrations/feesbasket-api-map.md` §4). Pure: no HTTP, no
 * database, no `Date.now()`, no `Math.random()` — everything arrives as an
 * argument. The adapter that calls this composes it with the actual push,
 * the same way `passpercent.ts` composes `passpercent-mapping.ts`.
 *
 * `assertExternallyReachable` MUST run here — the mirror image of the public
 * profile projection (Task 7), where calling it would have been wrong.
 * FeesBasket links to whatever URL IDAP supplies and never fetches a copy of
 * the bytes (map §4: "IDAP pushes a URL only ... the platform does not
 * fetch/store bytes on IDAP's behalf"), so an unreachable URL becomes a
 * permanently dead link on a live public listing that IDAP has no way to
 * observe afterwards. `env.APP_URL` defaults to `http://localhost:3000`
 * rather than being unset (`src/lib/env.ts`), so a default developer
 * configuration is exactly the dangerous case — failing the whole call
 * loudly beats publishing a link that resolves for nobody.
 *
 * The kind vocabulary is validated against `ctx.mediaKinds`, the LIVE list a
 * real adapter reads from `GET /partner/me` — never a hardcoded list — because
 * the map is explicit that an unmapped `kind` is a hard 422 that fails the
 * *entire* ingestion call, not just the one bad item. Skipping the offending
 * item with a warning is what keeps one bad kind from discarding every other
 * item in the same payload.
 */

/** The shape of one institution media item as stored by IDAP (the Mongoose
 * subdocument fields relevant to this mapping — see `MediaItemSchema` in
 * `src/models/Institution.ts`). `_id` is kept exactly as-is: it becomes
 * `externalId`, the handle FeesBasket uses to address updates and deletes, so
 * a regenerated or synthesised value here would silently orphan remote
 * records. */
export type MediaItem = {
  _id: unknown;
  kind: MediaKind;
  url: string;
  title?: string;
  caption?: string;
  sortOrder: number;
  status: MediaStatus;
  provider?: string;
  videoId?: string;
  uploadedAt: unknown;
};

export type FeesBasketMedia = {
  externalId: string;
  kind: string;
  url: string;
  caption?: string;
};

/** IDAP's `MediaKind` -> FeesBasket's wire vocabulary is a plain lowercase of
 * IDAP's own enum (map §4: `MEDIA_KINDS = image | brochure | video |
 * prospectus`) — no renaming, only a case difference — but it is spelled out
 * as an explicit lookup rather than a bare `.toLowerCase()` so a future,
 * non-uppercase IDAP kind can never slip through unchecked. */
const KIND_TO_FEESBASKET: Record<MediaKind, string> = {
  IMAGE: "image",
  VIDEO: "video",
  BROCHURE: "brochure",
  PROSPECTUS: "prospectus",
};

/**
 * Builds the `media[]` section of a FeesBasket ingestion payload.
 *
 * `ctx.warnings` is an output channel, not an input: this function only ever
 * pushes onto it, once per skipped item, naming that item so an admin
 * reading the sync report can find and fix it.
 */
export function buildMediaPayload(
  media: MediaItem[],
  ctx: { mediaKinds: string[]; warnings: string[] },
): FeesBasketMedia[] {
  const out: FeesBasketMedia[] = [];

  for (const item of media) {
    // Same guarantee as the public profile API (Task 7): an admin who hides
    // an item expects it gone everywhere, including third-party listings.
    if (item.status === "HIDDEN") continue;

    const externalId = String(item._id);
    const mappedKind = KIND_TO_FEESBASKET[item.kind];

    // Validated against the LIVE vocabulary passed in via ctx — never a
    // hardcoded list. An unmapped kind is a hard 422 that fails the whole
    // ingestion call (map §3), so this item is skipped and warned about
    // rather than sent and risking every other item in the payload.
    if (!mappedKind || !ctx.mediaKinds.includes(mappedKind)) {
      const label = item.title ? ` ("${item.title}")` : "";
      ctx.warnings.push(
        `Media item "${externalId}"${label} has kind "${item.kind}", which is not in FeesBasket's current mediaKinds vocabulary — skipped rather than sent, since one unmapped item would fail the entire ingestion call`,
      );
      continue;
    }

    const url = toPublicUrl(item.url);
    // Throws (aborting this whole call) rather than returning — an
    // unreachable URL has no per-item recovery the way an unmapped kind
    // does, so the caller must fix the underlying media before retrying.
    assertExternallyReachable(url);

    const entry: FeesBasketMedia = { externalId, kind: mappedKind, url };
    if (item.caption) entry.caption = item.caption;
    out.push(entry);
  }

  return out;
}
