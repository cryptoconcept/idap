# Media (videos + brochures) — design

**Status:** approved for planning
**Date:** 2026-08-27
**Follows:** `docs/superpowers/specs/2026-08-27-platform-connections-design.md` §12.1
**Contract reference (binding):** `docs/integrations/feesbasket-api-map.md` §4 "Media"

## 1. Goal

Give an institution a single place to manage its promotional media — photos,
videos, brochures and prospectuses — expose it on IDAP's public API, and make it
mappable to FeesBasket's `media` section when Plan 9b ships.

Videos are **external links** (YouTube/Vimeo). Documents are **uploaded PDFs**.
Images already exist as `Institution.gallery[]` and fold into the new model.

## 2. What exists today

| Thing | State |
|---|---|
| `Institution.gallery[]` | Images only. `GalleryItemSchema`: `imageUrl` (required), `title`, `description`, `sortOrder`, `status`, `uploadedAt`. Keeps its `_id` — the delete route addresses items by it. |
| `GALLERY_STATUSES` / `GALLERY_MAX_ITEMS` | `["ACTIVE","HIDDEN"]` / `60` (`src/lib/constants.ts:155-159`) |
| `POST /api/settings/institution/media` | Multipart upload. `mediaUploadSchema`: `kind ∈ LOGO\|COVER\|GALLERY`, `title ≤120`, `description ≤400`. 5 MB cap. |
| `DELETE /api/settings/institution/media/[mediaId]` | Calls `InstitutionService.removeGalleryItem`. |
| `galleryItemPatchSchema` | `title ≤120`, `description ≤400`, `sortOrder 0-999`, `status`. |
| Public API | `/api/public/[institutionId]/profile` (+ results/fees/scholarships/offers). **Gallery is exposed on none of them.** |
| Storage | `storage.putPublic` → Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set, local disk otherwise (`src/lib/storage/index.ts`). |
| Public profile page | **Does not exist.** IDAP is API-first here; institutions render IDAP data on their own sites. |

## 3. The external contract that constrains this

From `feesbasket-api-map.md` §4 (read from live route handlers, not docs):

- Media item shape: `{ externalId, kind, url, caption?: string(≤240)|null }`.
- `MEDIA_KINDS` = `image | brochure | video | prospectus`.
- **IDAP pushes a URL only.** No bytes traverse the API and FeesBasket does not
  fetch or store a copy — it links to IDAP's URL. A URL that moves or expires
  becomes a dead link on a live listing that IDAP cannot observe.
- Up to 200 media items per push; deletion is explicit via `deletes.media[]`
  (ids, ≤500).
- `mediaKinds` must be read from `GET /partner/me` at runtime. The integration
  guide is explicit: an unmapped value is a hard 422.

Two consequences that drive design decisions below:

1. **`externalId` must be stable per item**, or updates create duplicates and
   `deletes.media[]` cannot address anything. The item's `_id` is that identity.
2. **The pushed URL must be absolute and publicly reachable.** See §7.

## 4. Data model

`Institution.gallery[]` is replaced by `Institution.media[]`. Same embedded-array
shape, same per-item `_id`.

```
MediaItemSchema ( _id kept )
  kind        MEDIA_KINDS, required        IMAGE | VIDEO | BROCHURE | PROSPECTUS
  url         String, required, trim       storage key for uploads; canonical URL for video
  title       String, trim, ≤120           optional
  caption     String, trim, ≤240           optional — the field mapped to FeesBasket
  sortOrder   Number, default 0
  status      MEDIA_STATUSES, default ACTIVE   ACTIVE | HIDDEN
  provider    MEDIA_PROVIDERS              YOUTUBE | VIMEO — videos only, else absent
  videoId     String                       videos only, else absent
  uploadedAt  Date, default now
```

New constants in `src/lib/constants.ts`:

```
MEDIA_KINDS      = ["IMAGE","VIDEO","BROCHURE","PROSPECTUS"]
MEDIA_STATUSES   = ["ACTIVE","HIDDEN"]        (replaces GALLERY_STATUSES)
MEDIA_PROVIDERS  = ["YOUTUBE","VIMEO"]
MEDIA_MAX_ITEMS  = { IMAGE: 60, VIDEO: 10, BROCHURE: 10, PROSPECTUS: 10 }
MEDIA_MAX_PDF_BYTES = 20 * 1024 * 1024
MEDIA_CAPTION_MAX   = 240
```

**Why `caption` is capped at 240 and `description` disappears.** Today
`description` allows 400 characters while FeesBasket's caption allows 240, so a
mapping that silently truncated would corrupt text on a public listing. Capping
at the input boundary means the value IDAP holds is always the value it can
push. `title` (≤120) stays as IDAP's own short label and is not pushed.

**Per-kind caps, not one total.** Sixty brochures is a data-entry error rather
than a use case, and a single shared cap would let one kind starve another.

### 4.1 Migration

A one-time idempotent script, `scripts/migrate-gallery-to-media.ts`, run as
`npm run migrate:media`, following the existing `scripts/` conventions:

- `imageUrl → url`, `title → title`, `description → caption`, `kind = "IMAGE"`,
  preserving `_id`, `sortOrder`, `status`, `uploadedAt`.
- **A `description` longer than 240 characters is reported, never truncated.**
  The script prints institutionId + item `_id` + the length and exits non-zero
  without writing that institution, so an admin shortens it deliberately.
  Silent data loss during a migration is not recoverable by a later edit.
- Idempotent: re-running after a successful migration is a no-op (an
  institution with `media` already populated and no `gallery` is skipped).
- Dry-run by default; `--apply` performs writes, matching
  `npm run sync:fee-indexes`'s existing shape.

## 5. Ingestion

Two paths, because the two kinds are genuinely different operations.

### 5.1 Documents (PDF upload)

`POST /api/settings/institution/media` — the existing multipart route, extended.

- **Rename its `kind` parameter to `target`** (`LOGO | COVER | MEDIA`). The word
  `kind` now means the media *type*; having it also mean the upload *target* in
  the same subsystem is the kind of collision that misleads every later reader.
  Internal dashboard route, updated in the same phase as its only caller.
- New body field `kind` (`IMAGE | BROCHURE | PROSPECTUS`) when `target=MEDIA`.
- PDFs: `contentType` must be `application/pdf` **and** the bytes must begin
  with `%PDF-` — a content type from a multipart form is client-supplied and
  proves nothing on its own.
- Size cap `MEDIA_MAX_PDF_BYTES` (20 MB); images keep their existing 5 MB cap.
- Stored via `storage.putPublic` under
  `media/{institutionId}/documents/{objectId}.pdf`, matching the existing
  `media/{institutionId}/…` prefix convention that `isOwnedMediaUrl` relies on.
- Refuses with a clear message when the kind's cap in `MEDIA_MAX_ITEMS` is
  already reached.

### 5.2 Videos (external link)

`POST /api/settings/institution/media/video` — JSON, not multipart.

`{ url, title?, caption? }` → normalise, then store `url` (canonical),
`provider`, `videoId`, `kind: "VIDEO"`.

Accepted shapes, all normalising to a canonical form:

| Input | Provider | Canonical |
|---|---|---|
| `youtube.com/watch?v=ID` | YOUTUBE | `https://www.youtube.com/watch?v=ID` |
| `youtu.be/ID` | YOUTUBE | same |
| `youtube.com/embed/ID` | YOUTUBE | same |
| `youtube.com/shorts/ID` | YOUTUBE | same |
| `m.youtube.com/watch?v=ID` | YOUTUBE | same |
| `youtube.com/watch?v=ID&t=30s` | YOUTUBE | same (query dropped except `v`) |
| `vimeo.com/ID` | VIMEO | `https://vimeo.com/ID` |
| `player.vimeo.com/video/ID` | VIMEO | `https://vimeo.com/ID` |

- **Host allowlist, not a URL regex.** Anything outside YouTube/Vimeo is
  refused with a message naming what is supported. An arbitrary URL cannot be
  embedded, and accepting one would let a dashboard field become an open
  redirect surface on partner listings.
- A video ID that does not match the provider's id format is refused. IDAP does
  **not** call out to verify the video exists — that is a network dependency on
  a dashboard save path, and a deleted video is indistinguishable from a
  private one. Liveness is out of scope for this phase.
- Re-submitting a URL that normalises to an existing item's `(provider, videoId)`
  is refused as a duplicate rather than silently creating a second card.

### 5.3 Editing and removal

`PATCH /api/settings/institution/media/[mediaId]` — `title`, `caption`,
`sortOrder`, `status`. `mediaItemPatchSchema` replaces `galleryItemPatchSchema`.

`DELETE /api/settings/institution/media/[mediaId]` — unchanged in shape.
`InstitutionService.removeGalleryItem` is renamed `removeMediaItem`. For an
uploaded document it also deletes the stored object, mirroring how
`deleteOwnedPhoto` already works for topper photos.

## 6. Dashboard UI

`src/components/profile/sections/gallery-section.tsx` becomes
`media-section.tsx`, grouped by kind rather than one flat grid:

- **Photos** — the existing grid, unchanged in behaviour.
- **Videos** — paste-a-link field, then a card per video showing provider,
  title, caption. Thumbnail via the provider's public thumbnail URL
  (`img.youtube.com/vi/{id}/hqdefault.jpg`); no player embedded in the
  dashboard, since the dashboard is for management, not viewing.
- **Documents** — upload button, then a row per PDF with kind
  (brochure/prospectus), title, caption, and file size.

Each item: caption, reorder, hide/show, delete — reusing the existing editor's
patterns and the established confirm-dialog pattern for deletion. Per-kind caps
surface as a disabled add-control with the reason stated, not a failure after
the user has already chosen a file.

## 7. Public API

Media joins the existing public profile response at
`/api/public/[institutionId]/profile`, under a `media` key. No new route — an
institution's site already fetches this endpoint, and a second round-trip for
media would be worse for the consumer.

Each item serialises as:

```
{ id, kind, url, title, caption, provider, videoId, sortOrder }
```

- **`ACTIVE` only.** `HIDDEN` items never appear on any public response.
- Sorted by `sortOrder`, then `uploadedAt`.
- `url` is **absolute**. See §7.1.

### 7.1 The absolute-URL requirement

`storage.putPublic` returns `/api/media/{key}` on the local-disk backend — a
**relative** path. Vercel Blob returns an absolute `https://…` URL. So the value
stored in `url` differs in kind between backends.

Both the public API and the FeesBasket adapter must emit an absolute URL, but
they need **different strictness**, and conflating them would ship dead links.

`toPublicUrl(url)` in `src/lib/media/` (alongside the existing
`ownership.ts`) resolves a stored value against `env.APP_URL`:

- Already absolute (`https://` or `http://`) → returned unchanged.
- Relative → prefixed with `env.APP_URL`.

That is sufficient for the public API, where a localhost URL in development is
harmless.

It is **not** sufficient for an outbound partner push, because
`env.APP_URL` never comes back unset — it defaults to `http://localhost:3000`
(`src/lib/env.ts:16-17`). A naive "throw if unset" guard would therefore never
fire, and IDAP would push `http://localhost:3000/api/media/…` to FeesBasket: a
well-formed URL, a permanently dead link on a public listing, and nothing in
IDAP able to observe it.

So a second, stricter helper guards the outbound path:

`assertExternallyReachable(url)` throws when the resolved absolute URL's host is
`localhost`, `127.0.0.1`, `[::1]`, or any RFC1918 private address. The FeesBasket
mapping calls it on every media URL; the public API does not.

Failing a sync loudly on a misconfigured `NEXT_PUBLIC_APP_URL` is strictly
better than publishing links that will never resolve for anyone but the
developer who created them.

These two helpers are the single place that knowledge lives.

## 8. FeesBasket mapping (groundwork; Plan 9b wires it)

This phase does **not** ship an adapter. It ships the pure mapping function and
its tests, so 9b's adapter composes it the way `passpercent.ts` composes
`passpercent-mapping.ts`.

`buildMediaPayload(media, ctx)` → `{ externalId, kind, url, caption }[]`

| IDAP | FeesBasket |
|---|---|
| `_id` | `externalId` |
| `IMAGE` | `image` |
| `VIDEO` | `video` |
| `BROCHURE` | `brochure` |
| `PROSPECTUS` | `prospectus` |
| `caption` | `caption` (already ≤240 by §4) |
| `url` via `toPublicUrl` **then `assertExternallyReachable`** | `url` |

- `ACTIVE` items only.
- Kinds are validated against the **live** `mediaKinds` vocabulary passed in via
  `ctx`, read from `GET /partner/me`, never hardcoded. An unmapped kind is
  **skipped with a warning naming the item**, never sent — an unmapped value is
  a hard 422 that would fail the entire ingestion call, not just that item.
- Mapping losses are warnings, never silent drops and never exceptions,
  matching the established rule from the platform-connections phase.
- The function is pure: no HTTP, no DB, no `Date.now()`.

## 9. Error handling

- Upload/link validation failures return `VALIDATION_ERROR` with a message that
  names the field and what would fix it.
- A storage failure mid-upload leaves no media row — the row is written only
  after `putPublic` resolves.
- A delete whose storage removal fails still removes the row and logs, matching
  `deleteOwnedPhoto`'s existing behaviour: an orphaned blob is recoverable, a
  row pointing at a deleted file is not.
- `assertExternallyReachable` throwing on a localhost/private `APP_URL` surfaces
  as a clear configuration error naming the offending host, not a scrubbed 500.
  It fails the sync rather than pushing a link that cannot resolve.

## 10. Testing

Unit:
- URL normalisation across every row of §5.2's table, both directions —
  accepted shapes normalise correctly, and rejected hosts are actually rejected.
- Duplicate detection by `(provider, videoId)`.
- `toPublicUrl`: absolute passthrough, and relative resolution against
  `env.APP_URL`.
- `assertExternallyReachable`: **throws** for `localhost`, `127.0.0.1`, `[::1]`
  and an RFC1918 host; passes a real https URL. This is the load-bearing test in
  this phase — with `env.APP_URL` defaulting to `http://localhost:3000`, it is
  the only thing standing between a default dev config and dead links on a live
  public listing. Mutation-check it: remove the localhost case and confirm
  exactly this test fails.
- `buildMediaPayload`: kind mapping, `ACTIVE`-only filtering, unmapped-kind
  warning (asserting the warning names the specific item), caption passthrough.
- Per-kind caps.

Integration:
- PDF magic-byte rejection (a `.pdf` filename with non-PDF bytes must fail).
- Public profile response includes `ACTIVE` and excludes `HIDDEN` — mutation-
  checked by flipping the filter and confirming exactly that test fails.
- Tenant isolation on every new/changed service method, each mutation-checked
  by removing its `institutionId` and confirming exactly its test fails.

Migration:
- Idempotence (second run is a no-op).
- The >240 `description` case reports and exits non-zero **without writing**.

## 11. Out of scope

- Rendering media on an IDAP-hosted public page (no such page exists; §2).
- Video upload/hosting/transcoding.
- Link-liveness checking for videos or documents.
- The FeesBasket adapter itself — Plan 9b.
- Pushing media to PassPercent. Its contract covers topper photos only.

## 12. Global constraints

- Tenant scoping absolute: every read and write is `institutionId`-scoped.
- Mapping losses are warnings attributed to the specific item, never silent.
- Guard optional numerics with `!= null`, never `?? 0`.
- `npx tsc --noEmit` 0 errors; `npx eslint src` exactly 0 errors / 7 warnings.
- Test helpers are positional: `makeInstitution(id, overrides)`.
- Playwright lives at `/Users/automicai/VVOGI/node_modules/playwright` (absolute
  path; not installed in this repo).
- Never restart dev servers by pattern — kill by PID after confirming cwd.
