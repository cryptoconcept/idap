import { assertExternallyReachable, toPublicUrl } from "@/lib/media/public-url";

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

/** Permissive by design — see `passpercent-mapping.ts`'s `Rec`, the precedent
 * spec §8 names for this exact situation. IDAP has no single concrete type
 * for "one media item": the Mongoose subdocument, a `.lean()` read,
 * `ProfileDTO["media"]` and `PublicProfile["media"]` all disagree on
 * nullability (Mongoose types every optional string path
 * `string | null | undefined`) and even on the id field's name (`_id` vs.
 * `id`). A strict field-typed alternative is assignable from none of them —
 * every real caller would need `as unknown as MediaItem` — which makes the
 * type documentation that lies rather than a constraint it enforces. This
 * function narrows what it actually reads instead (`str()` below), the same
 * discipline `passpercent-mapping.ts` applies with its own local helpers. */
type Rec = Record<string, unknown>;
export type MediaItem = Rec;

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export type FeesBasketMedia = {
  externalId: string;
  kind: string;
  url: string;
  caption: string | null;
};

/** IDAP's `MediaKind` -> FeesBasket's wire vocabulary is a plain lowercase of
 * IDAP's own enum (map §4: `MEDIA_KINDS = image | brochure | video |
 * prospectus`) — no renaming, only a case difference — but it is spelled out
 * as an explicit lookup rather than a bare `.toLowerCase()` so a future,
 * non-uppercase IDAP kind can never slip through unchecked. Keyed by plain
 * `string` (not `MediaKind`) because `item.kind` arrives as `unknown` — see
 * `MediaItem` above — and is narrowed with `str()` before it ever reaches
 * this lookup. */
const KIND_TO_FEESBASKET: Record<string, string> = {
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
    // Excludes a HIDDEN item from THIS payload — it is simply absent from
    // `media[]`. That is NOT the same as retracting it from a listing
    // FeesBasket already has: the map's merge rule (§4, "Merge semantics")
    // treats an absent field/item as "untouched", and deletion is only ever
    // explicit via the top-level `deletes: { …, media[] }` block (map §4,
    // point 3). So hiding an item that was previously pushed removes it from
    // IDAP's own surfaces but leaves it live on the remote listing
    // indefinitely, until something emits `deletes.media[]` for it.
    // `buildMediaPayload` does not do that here — it needs the adapter's
    // push/reconcile context (the id of what FeesBasket currently has, to
    // diff against), which belongs to the FeesBasket adapter plan (9b), not
    // this pure mapping function. The next implementer of that adapter must
    // add it; this comment is the pointer so the obligation is inherited
    // rather than rediscovered.
    if (str(item.status) === "HIDDEN") continue;

    const externalId = String(item._id);
    const kind = str(item.kind);
    const mappedKind = kind ? KIND_TO_FEESBASKET[kind] : undefined;

    // Validated against the LIVE vocabulary passed in via ctx — never a
    // hardcoded list. An unmapped kind is a hard 422 that fails the whole
    // ingestion call (map §3), so this item is skipped and warned about
    // rather than sent and risking every other item in the payload.
    if (!mappedKind || !ctx.mediaKinds.includes(mappedKind)) {
      const title = str(item.title);
      const label = title ? ` ("${title}")` : "";
      ctx.warnings.push(
        `Media item "${externalId}"${label} has kind "${String(item.kind)}", which is not in FeesBasket's current mediaKinds vocabulary — skipped rather than sent, since one unmapped item would fail the entire ingestion call`,
      );
      continue;
    }

    const url = toPublicUrl(str(item.url) ?? "");
    // Throws (aborting this whole call) rather than returning — an
    // unreachable URL has no per-item recovery the way an unmapped kind
    // does, so the caller must fix the underlying media before retrying.
    assertExternallyReachable(url);

    // `caption` is ALWAYS present on the wire object, never omitted, even
    // when IDAP has no caption for this item. The map's merge rule (§4) is
    // explicit: "Absent field/section = untouched. Explicit `null` = clear
    // (nullable fields only)." `caption?: string|null` is nullable, so
    // omitting the key when an admin clears a previously-set caption would
    // read as "leave it alone" to FeesBasket — the stale caption would stay
    // on a public listing forever, with no way for IDAP to retract it.
    // Always emitting `null` for an item that never had one is harmless (it
    // clears an already-empty field); the asymmetric alternative — sending
    // the key only when a caption exists — is the one that loses data.
    out.push({ externalId, kind: mappedKind, url, caption: str(item.caption) ?? null });
  }

  return out;
}
