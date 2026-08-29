# Institution Profile API

I-DAP owns the master record for an institution — identity, contact, address, academic
detail, management, facilities, social links and a media library (photos, YouTube/Vimeo
links, brochures and prospectuses) — and exposes it over three audiences:

| Audience | Base path | Auth | Can write? |
| --- | --- | --- | --- |
| Institute admin, own institution | `/api/settings/institution*` | dashboard session cookie | yes, own profile only |
| Platform admin, any institution | `/api/institutions/:institutionId` | dashboard session cookie | provisioning fields only, never profile content |
| Anyone, no credentials | `/api/public/*` | none | read-only |

`institutionId` is **never** taken from a request body or query string. On authenticated
routes it is derived from the session; on public routes it is the URL path segment, and it
only ever selects a `PUBLISHED` record.

All examples use `INS0001`. Every response uses the platform's standard envelope:

```json
{ "success": true, "...": "..." }
```

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "field: what was wrong" } }
```

---

## 1. Institute admin — own institution

Cookie-authenticated, same-origin only. State-changing requests must carry a matching
`Origin` header (the browser does this automatically) or they are rejected with `403`
before anything else runs.

### `GET /api/settings/institution`

The full profile plus how complete it is.

```bash
curl -b cookies.txt https://your-domain.com/api/settings/institution
```

```json
{
  "success": true,
  "profile": {
    "id": "6a887abc755db527bea511e6",
    "institutionId": "INS0001",
    "institutionName": "Infinity School of Excellence",
    "institutionType": "SCHOOL",
    "slug": "infinity-school-of-excellence-mysore",
    "profileStatus": "DRAFT",
    "publishedAt": null,
    "academic": { "board": "CBSE", "classesOffered": ["Grade 1", "Grade 10"] },
    "management": { "managementType": "TRUST", "principalName": "Dr. Latha Rao" },
    "facilities": [{ "code": "LIBRARY", "label": "Library", "available": true }],
    "media": []
  },
  "completion": {
    "percent": 62,
    "groups": [
      { "key": "identity", "label": "Basic information", "weight": 15, "earned": 15, "missing": [] }
    ],
    "missing": ["Cover image", "At least two social links"]
  }
}
```

Errors: `401` (no session), `403` (session is a platform admin — this route only serves
institute admins).

### `PATCH /api/settings/institution`

Section-scoped, partial update. Send only the section(s) you're changing; block fields
(`contact`, `geo`, `academic`, `management`, `social`) are merged one field deep, so a
patch touching `academic.board` alone never erases `academic.classesOffered`. Arrays
(`facilities`, `academic.medium`, `social.other`, …) always replace wholesale — there is
no element-level merge.

`institutionId`, `active` and `profileStatus` are rejected by the schema — status changes
go through the publish endpoint below, and `active` is platform-admin territory. Unknown
keys are dropped, not stored (the mass-assignment defence used everywhere else in this
codebase).

```bash
curl -X PATCH https://your-domain.com/api/settings/institution \
  -b cookies.txt \
  -H "Origin: https://your-domain.com" \
  -H "Content-Type: application/json" \
  -d '{
        "tagline": "Learning that lasts",
        "academic": { "board": "CBSE", "classesOffered": ["Grade 1", "Grade 10"] }
      }'
```

Response: same shape as `GET`, re-fetched after the write so `completion` reflects it.

Errors: `400 VALIDATION_ERROR` (a field fails its schema — see field limits in
[§5](#5-field-reference)), `401`, `403` (cross-origin, or a platform-admin session).

**Clearing a field.** `logoUrl` and `coverImageUrl` accept an explicit `null`, which
clears them — the field is `$unset`, so it comes back absent rather than as a stored
`null`. Omitting a key still means "leave it alone": `null` and `undefined` are different
instructions, and a patch naming only `logoUrl` never touches the cover.

> **Known limitation — clearing a *text* field is still a no-op.** Every optional text
> field trims and normalises an empty string to `undefined` before validation, and the
> service skips `undefined` values when building the update. The practical effect:
> sending `{ "tagline": "" }` does not clear an existing tagline — it is silently dropped
> from the update, and the stored value is unchanged. There is currently no way to blank a
> previously-set text field through this API; replacing it with a new value works fine.
> The two image fields above are the exception, because removing a logo has no
> "replace it with something else" alternative. See the architecture doc for the
> reasoning and what a wider fix would need.

### `POST /api/settings/institution/publish`

One endpoint, both directions — `action` picks which.

```bash
curl -X POST https://your-domain.com/api/settings/institution/publish \
  -b cookies.txt \
  -H "Origin: https://your-domain.com" \
  -H "Content-Type: application/json" \
  -d '{"action":"publish"}'
```

```json
{ "success": true, "profile": { "profileStatus": "PUBLISHED", "publishedAt": "2026-08-23T09:14:02.000Z", "...": "..." } }
```

`publishedAt` is set once, on the first transition to `PUBLISHED`. Unpublishing
(`{"action":"unpublish"}`, `PUBLISHED → DRAFT`) never clears it — it records history, not
current state. Publishing is allowed at any completion percentage, including 0%.

Errors: `400 VALIDATION_ERROR` (`action` missing or not `publish`/`unpublish`), `401`,
`403`.

### `POST /api/settings/institution/media`

`multipart/form-data` upload. `target` is the upload **destination**; `kind` is the media
**type**, and only matters (and is only ever sent) when `target` is `MEDIA` — having one
word mean both in the same subsystem is exactly what this split avoids.

| Field | Required | Notes |
| --- | --- | --- |
| `file` | yes | An image for `target=LOGO`/`COVER`/`MEDIA` with `kind` omitted or `IMAGE`; a PDF for `target=MEDIA` with `kind` `BROCHURE`/`PROSPECTUS`. Verified by magic bytes, not the declared content type — a renamed file is rejected even if it claims the right one. Images: JPEG/PNG/WebP, 5 MB ceiling. Documents: PDF (`%PDF-` header), 20 MB ceiling. |
| `target` | yes | `LOGO` \| `COVER` \| `MEDIA` |
| `kind` | no | `IMAGE` \| `BROCHURE` \| `PROSPECTUS` — only read when `target` is `MEDIA`; omitted or `IMAGE` takes the image path, `BROCHURE`/`PROSPECTUS` takes the PDF path. Videos are never uploaded here — see the `/media/video` endpoint below. |
| `title` | no | `target=MEDIA` only; ≤120 characters. Silently ignored for `LOGO`/`COVER`. |
| `caption` | no | `target=MEDIA` only; ≤240 characters (FeesBasket's caption cap). Silently ignored for `LOGO`/`COVER`. |

`LOGO` and `COVER` **replace** the existing image — the old object is deleted (best
effort) after the new one is stored. `MEDIA` **appends** to the media library, capped
**per kind, not as one shared total**: 60 images, 10 videos, 10 brochures, 10
prospectuses. A cap-exceeding upload returns `409 CONFLICT` and the just-uploaded object
is cleaned up so nothing orphans. To remove a logo or cover entirely, `PATCH`
`{"logoUrl": null}` or `{"coverImageUrl": null}` through `/api/settings/institution` —
there is no delete route for `LOGO`/`COVER`, only for media items. Clearing the field
leaves the stored object in place; only a *replacement* upload cleans the old one up.

```bash
curl -X POST https://your-domain.com/api/settings/institution/media \
  -b cookies.txt \
  -H "Origin: https://your-domain.com" \
  -F "target=MEDIA" \
  -F "title=Annual Day 2026" \
  -F "file=@campus.jpg;type=image/jpeg"
```

```json
{ "success": true, "profile": { "media": [{ "id": "6a88...", "kind": "IMAGE", "url": "https://...", "title": "Annual Day 2026", "status": "ACTIVE" }] } }
```

A brochure or prospectus is the same request with `target=MEDIA`, `kind=BROCHURE` (or
`PROSPECTUS`), and a PDF `file`:

```bash
curl -X POST https://your-domain.com/api/settings/institution/media \
  -b cookies.txt \
  -H "Origin: https://your-domain.com" \
  -F "target=MEDIA" \
  -F "kind=BROCHURE" \
  -F "title=Admissions Brochure 2026" \
  -F "file=@brochure.pdf;type=application/pdf"
```

Errors: `400 VALIDATION_ERROR` (missing/oversized/wrong-type file, bad `target`/`kind`),
`401`, `403`, `409 CONFLICT` (that kind's cap already reached).

### `POST /api/settings/institution/media/video`

Adds a YouTube or Vimeo link. No bytes are ever uploaded — the URL is normalized and
validated against an explicit host allow-list (`youtube.com`, `m.youtube.com`, `youtu.be`,
`vimeo.com`, `player.vimeo.com`); anything else is rejected before it reaches the
database. A JSON body, not multipart.

| Field | Required | Notes |
| --- | --- | --- |
| `url` | yes | A YouTube or Vimeo link. Normalized to a canonical form and split into `provider`/`videoId`. |
| `title` | no | ≤120 characters |
| `caption` | no | ≤240 characters |

```bash
curl -X POST https://your-domain.com/api/settings/institution/media/video \
  -b cookies.txt \
  -H "Origin: https://your-domain.com" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","title":"Campus Tour"}'
```

```json
{ "success": true, "profile": { "media": [{ "id": "6a90...", "kind": "VIDEO", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "provider": "YOUTUBE", "videoId": "dQw4w9WgXcQ", "title": "Campus Tour", "status": "ACTIVE" }] } }
```

Errors: `400 VALIDATION_ERROR` (`url` missing, or not a YouTube/Vimeo link — message names
what is supported), `401`, `403`, `409 CONFLICT` (this exact video already added, or the
10-video cap already reached).

### `PATCH /api/settings/institution/media/:mediaId`

Edits one media item in place — title, caption, `sortOrder`, and the `ACTIVE`/`HIDDEN`
flag the public projection filters on. Works on any kind (image, video, brochure,
prospectus) addressed by the same `:mediaId`. Setting `status: "HIDDEN"` is how an item
leaves the public profile without being deleted.

```bash
curl -X PATCH https://your-domain.com/api/settings/institution/media/6a88... \
  -b cookies.txt \
  -H "Origin: https://your-domain.com" \
  -H "Content-Type: application/json" \
  -d '{"status":"HIDDEN"}'
```

**Clearing the caption.** Same three-state convention as `logoUrl`/`coverImageUrl` on the
main `PATCH` above: omitting `caption` leaves it alone, a string `$set`s it, and an
explicit `null` clears it (`$unset`, not a stored empty string) — unlike the "known
limitation" on plain text fields below, a media caption genuinely can be blanked through
this API.

```bash
curl -X PATCH https://your-domain.com/api/settings/institution/media/6a88... \
  -b cookies.txt \
  -H "Origin: https://your-domain.com" \
  -H "Content-Type: application/json" \
  -d '{"caption": null}'
```

Errors: `400 VALIDATION_ERROR`, `401`, `403`, `404` (no such media item on this
institution).

### `DELETE /api/settings/institution/media/:mediaId`

Removes one media item (not `LOGO`/`COVER` — see above) and deletes the stored object —
for an image, video link, brochure or prospectus alike. A video's URL points at
YouTube/Vimeo, not this institution's storage, so nothing is deleted from storage for
those; only the array entry goes.

```bash
curl -X DELETE https://your-domain.com/api/settings/institution/media/6a88... \
  -b cookies.txt \
  -H "Origin: https://your-domain.com"
```

Errors: `401`, `403`, `404`.

---

## 2. Platform admin — provisioning, read-only on profiles

Cookie-authenticated only — these routes are deliberately excluded from bearer/API-key
auth, so a stolen mobile token can never reach institution provisioning.

### `GET /api/institutions/:institutionId`

**View** any institution's full profile — the same payload shape as the institute admin's
own `GET`, plus the provisioning `institution` object. There is no write counterpart to
this read; see `PATCH` below for what a platform admin may actually change.

```bash
curl -b platform-cookies.txt https://your-domain.com/api/institutions/INS0001
```

```json
{
  "success": true,
  "institution": { "institutionId": "INS0001", "institutionName": "Infinity School of Excellence", "active": true },
  "profile": { "...": "the full profile, same shape as §1's GET" },
  "completion": { "percent": 62, "groups": ["..."], "missing": ["..."] }
}
```

An institution admin may call this route too, but only for their **own** `institutionId`
— any other value is `403`.

Errors: `401`, `403` (institution admin requesting someone else's id), `404`.

### `PATCH /api/institutions/:institutionId`

Provisioning fields only: `institutionName`, `institutionType`, `active`, `regionCode`.
This is enforced by a schema (`platformInstitutionPatchSchema`) that has no other keys —
not by a UI that happens to omit them. Sending `description`, `academic`, `logoUrl`, or
any other profile field is silently stripped by Zod before it reaches the service; it is
never applied, and the response reflects the unchanged profile.

```bash
curl -X PATCH https://your-domain.com/api/institutions/INS0001 \
  -b platform-cookies.txt \
  -H "Origin: https://your-domain.com" \
  -H "Content-Type: application/json" \
  -d '{"active": false, "regionCode": "KA-MYS"}'
```

```json
{ "success": true, "institution": { "institutionId": "INS0001", "active": false, "regionCode": "KA-MYS" } }
```

Errors: `400 VALIDATION_ERROR`, `401`, `403` (an institution admin's session — this write
is platform-admin only, unlike the `GET` above).

`GET /api/institutions` (list) and `POST /api/institutions` (create) are unchanged in
shape and continue to exist; `POST` now also allocates a slug for the new institution
before it is returned.

---

## 3. Public — credential-free

**These are the endpoints a static website (plain HTML, Astro, Hugo, a Next.js export —
anything with no backend) calls directly, with no API key.** They are CORS-open
(`Access-Control-Allow-Origin: *`, applied platform-wide to `/api/public/*` in
`next.config.ts`), respond to `OPTIONS` preflight, and return only what has been
deliberately published.

`profileStatus` other than `PUBLISHED`, a deactivated institution (`active: false`), or an
unknown id/slug all produce the **identical** `404` — never `403` — so a caller cannot use
the response to determine whether a private institution exists.

**Cached *and* rate limited.** Responses carry `Cache-Control: public, max-age=300`, and
every request also spends from a per-IP bucket on the same `consumeRateLimit` limiter the
credential-free write endpoints use: **60 requests per minute per visitor IP**
(`PUBLIC_READ_RATE_LIMIT`), looser than the 10/minute write limit because a read is cheap,
cacheable, and shared by everyone behind one NAT address.

The bucket is keyed by IP **only** — not by `institutionId` or `slug`. A per-institution
bucket would hand a scraper a fresh allowance for every id it invented, which is exactly
the cache-busting pattern the limiter exists to stop. Both profile routes share one
bucket for the same reason.

Over the limit returns `429 RATE_LIMITED` with `Retry-After`, `X-RateLimit-*` and
`Cache-Control: no-store`, so a shared cache never holds on to one visitor's rejection.
Successful responses deliberately carry no `X-RateLimit-*` headers: they are publicly
cacheable, and a cached counter would describe the wrong client.

### ⚠ BREAKING CHANGE in this release — `gallery` → `media`

Both public profile routes below (`GET /api/public/:institutionId/profile` and
`GET /api/public/institutions/:slug`) have **removed** `profile.gallery[]` and
replaced it with `profile.media[]`. This is a hard breaking change with **no
transition period and no dual-write** — a consumer that keeps reading the old
field gets `undefined` back and silently renders nothing. There is no error, no
warning header, nothing to notice except an empty gallery on a live website.

| Before | After |
| --- | --- |
| `profile.gallery[]` | `profile.media[]` |
| `gallery[].imageUrl` | `media[].url` |
| `gallery[].description` | `media[].caption` |
| `gallery[].title` | `media[].title` (unchanged) |
| — (did not exist) | `media[].id`, `media[].kind` — `"IMAGE"` for every item migrated from `gallery` |
| — (did not exist) | `media[].sortOrder` |
| — (did not exist) | `media[].provider`, `media[].videoId` — present only on `kind: "VIDEO"` items, which `gallery` never had |

**What a consumer must change:** read `profile.media[].url` and
`profile.media[].caption` instead of `profile.gallery[].imageUrl` and
`profile.gallery[].description`. `title` did not change. If the consumer only
ever wanted photos, it should now filter on `media[].kind === "IMAGE"` — the
array also carries videos, brochures and prospectuses, none of which `gallery`
ever returned.

### Deploy sequence (required) — two one-time migrations, both after deploy

`npm run migrate:media -- --apply` **must be run immediately after this
release deploys, before the deployment takes production traffic.** It is a
manual, one-time step: no build hook, cron job, or startup check runs it for
you.

Between the deploy landing and that command completing, the public projection
reads only `doc.media` — it does not fall back to `doc.gallery` — so **any
institution whose photos are still in the legacy `gallery` field publishes
`media: []` on both routes below.** Their photos disappear from their own
website, with no error and no indication anywhere that it is temporary. This
is expected only if the migration is run right after deploy; there is no
code-level safeguard that stops someone from skipping or delaying it.

`npm run migrate:facility-codes -- --apply` is the second required one-time
step of this release. It converts `Institution.facilities[].code` from the
eleven legacy uppercase codes onto the 38-key **lowercase** vocabulary in
`src/lib/profile/facilities.ts`. Nine codes map 1:1; `HOSTEL` and `SPORTS`
have no honest target and are left alone and reported under `unmapped` for a
human to re-pick.

**It must run only AFTER this release is deployed, never against a server
still on the previous build — and it fails silently if you get that wrong.**
The pre-release schema declared the field as:

```js
code: { type: String, required: true, trim: true, uppercase: true },
```

Mongoose applies `uppercase: true` on write. Run the migration while that
build is still serving and every lowercase code it writes is re-uppercased on
its way into the document. The script reads its own writes back as successful,
reports the full converted count, and exits `0` — while the data is exactly as
it was. There is no error, no warning, and nothing in the report distinguishes
this from a real conversion. The only way to detect it afterwards is to read
the stored codes and notice they are still uppercase.

That constraint is about deploy order, not about the other migration: this and
`migrate:media` touch different fields and may be run in either order relative
to each other, provided both run after the deploy.

Dry-run first — `npm run migrate:facility-codes` with no `--apply` reports what
it would change without writing.

### `GET /api/public/:institutionId/profile`

```bash
curl https://your-domain.com/api/public/INS0001/profile
```

```json
{
  "success": true,
  "profile": {
    "institutionId": "INS0001",
    "slug": "infinity-school-of-excellence-mysore",
    "institutionName": "Infinity School of Excellence",
    "institutionType": "SCHOOL",
    "regionCode": "KA-MYS",
    "tagline": "Learning that lasts",
    "description": "A CBSE school in Mysore teaching Grades 1 to 12.",
    "establishedYear": 1998,
    "logoUrl": "https://...blob.vercel-storage.com/media/INS0001/....png",
    "coverImageUrl": null,
    "address": { "addressLine1": "Plot 14, Hebbal Industrial Area", "city": "Mysore", "state": "Karnataka", "pincode": "570016", "country": "India" },
    "geo": null,
    "contact": { "phone": "8212540111", "email": "admissions@infinityschool.edu.in", "website": "https://infinityschool.edu.in", "contactPerson": "Admissions Office" },
    "academic": { "board": "CBSE", "classesOffered": ["Grade 1", "Grade 10"] },
    "management": { "managementType": "TRUST", "principalName": "Dr. Latha Rao", "headDesignation": "Principal" },
    "facilities": [{ "code": "LIBRARY", "label": "Library", "available": true, "note": "12,000 titles" }],
    "social": null,
    "media": [
      { "id": "6a8b...", "kind": "IMAGE", "url": "https://...blob.vercel-storage.com/media/INS0001/....jpg", "title": "Campus Front Gate", "caption": "Main entrance on Hebbal Road", "sortOrder": 0 },
      { "id": "6a90...", "kind": "VIDEO", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "title": "Campus Tour", "provider": "YOUTUBE", "videoId": "dQw4w9WgXcQ", "sortOrder": 1 },
      { "id": "6a90...", "kind": "BROCHURE", "url": "https://...blob.vercel-storage.com/media/INS0001/documents/....pdf", "title": "Admissions Brochure 2026", "sortOrder": 2 }
    ],
    "achievements": [
      {
        "id": "6a9c...",
        "category": "SPORTS",
        "title": "State Kabaddi Champions",
        "description": "Under-16 team, Karnataka State Championship",
        "eventDate": "2026-02-01T00:00:00.000Z",
        "level": "STATE",
        "students": [{ "name": "Asha Rao", "grade": "10" }],
        "photos": ["https://...blob.vercel-storage.com/showcase/INS0001/achievements/....jpg"],
        "certificates": ["https://...blob.vercel-storage.com/showcase/INS0001/achievements/....pdf"]
      }
    ],
    "alumni": [
      {
        "id": "6a9d...",
        "name": "Dr. Meera Iyer",
        "batch": "2012-2015",
        "category": "DOCTOR",
        "currentRole": "Cardiologist",
        "org": "Apollo Hospitals",
        "photo": "https://...blob.vercel-storage.com/showcase/INS0001/alumni/....jpg",
        "note": "Heads the alumni association."
      }
    ]
  }
}
```

Every `media` item carries `id`, `kind`, `url` (always an absolute URL, even for a
locally-stored file — see [§4](#4-the-public-projection)), `sortOrder`, and
`title`/`caption` when set; `provider` and `videoId` appear only on `kind: "VIDEO"` items.
A field that is unset is omitted from the object entirely (never sent as `null`) — the
brochure above has no `caption` because none was given.

`achievements[]` and `alumni[]` are the institution's published showcase. Unlike `media`,
which is embedded on the institution record, each lives in its own collection and is
fetched per request; both are **always present**, as `[]` when the institution has none.
Only records with `status: "ACTIVE"` are returned — the status itself never appears in the
payload, and a hidden record is dropped rather than marked.

**Hiding a record is not immediate on the wire.** Both public profile routes send
`Cache-Control: public, max-age=300`, so a record hidden a moment ago can still be served
from a shared cache, a CDN or a browser for up to five minutes after the change. The same
is true of a hidden `media` item, and of any other edit to the profile. Treat the
`ACTIVE`-only guarantee as one about what IDAP serves, not about what every caller
already holds.

| `achievements[]` field | Notes |
| --- | --- |
| `id` | The achievement's own id. |
| `category` | Always present. See [§5](#enums). |
| `title` | Always present. |
| `description` | Omitted when unset. |
| `eventDate` | ISO 8601 date-time. Omitted when the institution recorded none. |
| `level` | Always present; `SCHOOL` when the institution set nothing else. See [§5](#enums). |
| `students[]` | `{ "name", "grade"? }`. Free text, **not** links to student records. Always an array, `[]` when none; `grade` omitted when unset. |
| `photos[]` | Absolute URLs. Always an array, `[]` when none. |
| `certificates[]` | Absolute PDF URLs. Always an array, `[]` when none. |

Ordered by `eventDate` **descending**, then `createdAt` descending to break ties between
two achievements on the same day. `eventDate` is optional, and a record without one sorts
**last** — the newest events lead, and undated ones trail the list rather than heading it.

| `alumni[]` field | Notes |
| --- | --- |
| `id` | The alumnus's own id. |
| `name` | Always present. |
| `batch` | **Free text** — `"2015"` or `"2012-2015"`. Omitted when unset. |
| `category` | Always present. See [§5](#enums). |
| `currentRole`, `org`, `note` | Omitted when unset. |
| `photo` | One per alumnus, absolute URL. Omitted when none was uploaded. |

Ordered by `batch` **descending, then `name` ascending**. Because `batch` is free text,
that descending sort is a **raw string comparison and not a chronological guarantee**:
`"2015"` sorts above `"2012-2015"` because the two first differ at their fourth character.
An alumnus with no `batch` sorts last. A consumer that needs true chronological order must
parse `batch` itself.

`photos[]`, `certificates[]` and `photo` are absolute URLs on the same terms as
`media[].url` — resolved by `toPublicUrl`, so a consumer never has to know which storage
backend a deployment uses.

Note what is **absent** even though it exists in the database: `active`, `profileStatus`,
`publishedAt`, `id`/`_id` on the institution itself, `createdAt`/`updatedAt`,
`contact.alternateEmail`'s sibling `headEmail`/`headPhone` on `management` (names and
designations only), each media item's `uploadedAt`, any media item with
`status: "HIDDEN"`, each achievement's and alumnus's own `status`/`createdAt`/`updatedAt`,
and any achievement or alumnus with `status: "HIDDEN"`. See
[§4](#4-the-public-projection) for the full allow-list.

`404` example — draft, suspended, unpublished, deactivated, or unknown, all identical:

```bash
curl -i https://your-domain.com/api/public/INS9999/profile
```

```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Institution not found" } }
```

### `GET /api/public/institutions/:slug`

Byte-identical payload to the route above, looked up by the institution's public slug
instead of its id — what a hosted profile page's pretty URL would call. The slug is
lowercased before lookup, so the URL is case-insensitive.

```bash
curl https://your-domain.com/api/public/institutions/infinity-school-of-excellence-mysore
```

Same response shape, same error behaviour, as `GET /api/public/:institutionId/profile`.

### `GET /api/public/:institutionId` (existing branding endpoint — unchanged)

Pre-dates this phase; kept exactly as it was so no existing integration breaks. Returns a
much smaller set of fields (name, type, address, phone, email, website, logo, slug) for
the hosted apply pages and `widget.js`. Prefer the `/profile` endpoint above for anything
building a richer presentation — it is the one the allow-list projection is documented
against.

```bash
curl https://your-domain.com/api/public/INS0001
```

---

## 4. The public projection

`src/lib/profile/public-projection.ts` is the **only** path from an Institution document
to a public response, and it is an **allow-list**: it names every field that may leave. A
field added to the Mongoose schema tomorrow is private by default and stays private until
someone deliberately adds it to this function. See the architecture doc for why this is a
deny-list and not an allow-list, and how it's tested.

**Public:** `institutionId`, `slug`, `institutionName`, `legalName`, `shortName`,
`institutionType`, `regionCode`, `tagline`, `description`, `establishedYear`, `logoUrl`,
`coverImageUrl`, the full address block (including `geo`), primary contact
(`phone`/`email`/`website`/`contactPerson` plus `secondaryPhone`/`whatsapp`/`alternateEmail`),
the full `academic` block, `management` (**names and designations only** — `headEmail` and
`headPhone` are never public), `facilities`, `social`, and media items with
`status: "ACTIVE"` — `id` (the item's own id, not the institution's `_id`), `kind`, `url`,
`title`, `caption`, `sortOrder`, and, for `kind: "VIDEO"` only, `provider` and `videoId`.
`url` is always resolved to an absolute URL by `toPublicUrl` (`src/lib/media/public-url.ts`)
before it leaves this projection — Vercel Blob's own URLs are absolute already and pass
through unchanged, while the local-disk backend's `/api/media/…` keys are resolved against
`env.APP_URL` first, so a consumer never has to know which storage backend is behind a
given deployment. `uploadedAt` is **not** exposed on a media item.

Achievements and alumni join that output but do **not** come from the institution
document — they are separate collections, so `InstitutionService.getPublicProfile` fetches
them and hands them to the same projection, which stays a pure function over what it is
given. The `ACTIVE`-only filter and the institution scope both live in the queries
(`AchievementService.listPublic`, `AlumniService.listPublic`), **at the database** rather
than in memory afterwards: a `HIDDEN` or another tenant's record is never fetched, so no
downstream bug in the projection can leak one. Public per record: `id`, `category`,
`title`, `description`, `eventDate`, `level`, `students[]`, `photos[]` and
`certificates[]` on an achievement; `id`, `name`, `batch`, `category`, `currentRole`,
`org`, `photo` and `note` on an alumnus.

**Never public:** `active`, `profileStatus`, `publishedAt`, the institution's own
`_id`/`id`, `createdAt`, `updatedAt`, `management.headEmail`, `management.headPhone`, each
media item's `uploadedAt`, media items with `status: "HIDDEN"` (they are dropped, not
marked hidden in the response), each achievement's and alumnus's `institutionId`,
`status`, `createdAt` and `updatedAt`, achievements and alumni with `status: "HIDDEN"`
(dropped the same way, before they are ever read), and anything not explicitly named
above.

---

## 5. Field reference

### Section max lengths (`updateProfileSchema`)

| Field | Limit |
| --- | --- |
| `institutionName` | 160 chars |
| `legalName` | 200 chars |
| `shortName` | 80 chars |
| `tagline` | 160 chars |
| `description` | 4000 chars |
| `establishedYear` | integer, 1800–2200 |
| `address` | 300 chars |
| `city`, `state` | 80 chars |
| `addressLine2` | 200 chars |
| `locality`, `area`, `taluk`, `district` | 120 chars |
| `country` | 80 chars |
| `logoUrl`, `coverImageUrl` | `http(s)` URL, or `null` to clear |
| `academic.medium[]` | ≤12 items, 40 chars each |
| `academic.classesOffered[]` | ≤60 items, 40 chars each |
| `academic.coursesOffered[]` | ≤120 items, 120 chars each |
| `facilities[]` | ≤40 items |
| `social.other[]` | ≤6 items |
| Media items | per kind, not one shared total — enforced atomically in the service, not just the schema: **60** images, **10** videos, **10** brochures, **10** prospectuses |
| Media title | ≤120 characters |
| Media caption | ≤240 characters (FeesBasket's caption cap — `MEDIA_CAPTION_MAX`) |
| Media image upload | JPEG/PNG/WebP, ≤5 MB, magic-byte verified |
| Media document upload | PDF only, ≤20 MB, magic-byte (`%PDF-` header) verified |

### Enums

| Enum | Values |
| --- | --- |
| `institutionType` | `SCHOOL`, `PU_COLLEGE`, `DEGREE_COLLEGE`, `ENGINEERING_COLLEGE`, `MEDICAL_COLLEGE`, `UNIVERSITY`, `OTHER`, `B_ED_COLLEGE`, `NURSING_COLLEGE`, `POLYTECHNIC`, `COACHING_INSTITUTION`, `TRAINING_INSTITUTION` |
| `profileStatus` | `DRAFT`, `PUBLISHED`, `SUSPENDED`, `ARCHIVED` (only `PUBLISHED` — and `active`  — is ever public) |
| `academic.genderType` | `BOYS`, `GIRLS`, `CO_ED` |
| `management.managementType` | `GOVERNMENT`, `AIDED`, `UNAIDED`, `PRIVATE`, `TRUST`, `SOCIETY`, `MINORITY`, `AUTONOMOUS`, `OTHER` |
| `media[].status` | `ACTIVE`, `HIDDEN` |
| `media[].kind` | `IMAGE`, `VIDEO`, `BROCHURE`, `PROSPECTUS` |
| `media[].provider` | `YOUTUBE`, `VIMEO` — `kind: "VIDEO"` items only |
| media upload `target` | `LOGO`, `COVER`, `MEDIA` |
| media upload `kind` | `IMAGE`, `BROCHURE`, `PROSPECTUS` — read only when `target` is `MEDIA` |
| `achievements[].category` | `ACADEMIC`, `SPORTS`, `CULTURAL`, `OLYMPIAD`, `SCIENCE_FAIR`, `ROBOTICS`, `COMMUNITY_SERVICE` |
| `achievements[].level` | `SCHOOL`, `TALUK`, `DISTRICT`, `STATE`, `NATIONAL`, `INTERNATIONAL` |
| `alumni[].category` | `DOCTOR`, `ENGINEER`, `ENTREPRENEUR`, `CIVIL_SERVICES`, `SCIENTIST`, `ARTIST`, `SPORTS`, `OTHER` |
| achievement / alumnus `status` | `ACTIVE`, `HIDDEN` — only `ACTIVE` is ever public, and the field itself is never in the payload |

### Error codes

Every error uses `{ "success": false, "error": { "code", "message", "details"? } }`.

| Code | Status | When |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Zod rejects the body; `details` lists every failing field |
| `UNAUTHORIZED` | 401 | No session / not signed in |
| `FORBIDDEN` | 403 | Wrong role, wrong institution, or cross-origin write |
| `NOT_FOUND` | 404 | Institution or media item doesn't exist for this actor — or, on public routes, isn't published |
| `CONFLICT` | 409 | That media kind's cap already reached, or (video only) this exact link was already added |
| `INTERNAL_ERROR` | 500 | Unexpected — logged server-side, generic message to the caller |

---

## 6. OpenAPI

`GET /api/v1/openapi.json` and `.yaml` include both public profile endpoints, tagged
`Website`, alongside the existing hosted-form endpoints. The document title is
`I-DAP API` (or `I-DAP API · {institution name}` when generated with `?institution=INS0001`).
Since the profile endpoints require no credentials, they carry `security: []` in the spec
so tooling never prompts for a key that must not exist.
