# Institution Profile API

I-DAP owns the master record for an institution — identity, contact, address, academic
detail, management, facilities, social links and a gallery — and exposes it over three
audiences:

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
    "gallery": []
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

`multipart/form-data` upload of a `LOGO`, `COVER`, or `GALLERY` image.

| Field | Required | Notes |
| --- | --- | --- |
| `file` | yes | JPEG, PNG or WebP. Verified by magic bytes, not the declared content type — a renamed non-image is rejected even if it claims `image/png`. 5 MB ceiling. |
| `kind` | yes | `LOGO` \| `COVER` \| `GALLERY` |
| `title` | no | Gallery items only; ≤120 characters |
| `description` | no | Gallery items only; ≤400 characters |

`LOGO` and `COVER` **replace** the existing image — the old object is deleted (best
effort) after the new one is stored. `GALLERY` **appends**, capped at 60 items; a 61st
upload returns `409 CONFLICT` and the just-uploaded object is cleaned up so nothing
orphans. To remove a logo or cover entirely, `PATCH` `{"logoUrl": null}` or
`{"coverImageUrl": null}` through `/api/settings/institution` — there is no delete route
for `LOGO`/`COVER`, only for gallery items. Clearing the field leaves the stored object in
place; only a *replacement* upload cleans the old one up.

```bash
curl -X POST https://your-domain.com/api/settings/institution/media \
  -b cookies.txt \
  -H "Origin: https://your-domain.com" \
  -F "kind=GALLERY" \
  -F "title=Annual Day 2026" \
  -F "file=@campus.jpg;type=image/jpeg"
```

```json
{ "success": true, "profile": { "gallery": [{ "id": "6a88...", "imageUrl": "https://...", "title": "Annual Day 2026", "status": "ACTIVE" }] } }
```

Errors: `400 VALIDATION_ERROR` (missing/oversized/non-image file, bad `kind`), `401`,
`403`, `409 CONFLICT` (gallery full).

### `PATCH /api/settings/institution/media/:mediaId`

Edits one gallery item in place — title, description, `sortOrder`, and the
`ACTIVE`/`HIDDEN` flag the public projection filters on. Setting `status: "HIDDEN"` is how
an image leaves the public profile without being deleted.

```bash
curl -X PATCH https://your-domain.com/api/settings/institution/media/6a88... \
  -b cookies.txt \
  -H "Origin: https://your-domain.com" \
  -H "Content-Type: application/json" \
  -d '{"status":"HIDDEN"}'
```

Errors: `400 VALIDATION_ERROR`, `401`, `403`, `404` (no such gallery item on this
institution).

### `DELETE /api/settings/institution/media/:mediaId`

Removes one gallery image (not `LOGO`/`COVER` — see above) and deletes the stored object.

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
    "gallery": []
  }
}
```

Note what is **absent** even though it exists in the database: `active`, `profileStatus`,
`publishedAt`, `id`/`_id`, `createdAt`/`updatedAt`, `contact.alternateEmail`'s sibling
`headEmail`/`headPhone` on `management` (names and designations only), and any gallery
item with `status: "HIDDEN"`. See [§4](#4-the-public-projection) for the full allow-list.

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
building a richer presentation — it is the one this phase adds and the one the allow-list
projection is documented against.

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
`headPhone` are never public), `facilities`, `social`, and gallery items with
`status: "ACTIVE"` (title/description/imageUrl only — `_id`, `sortOrder` and `uploadedAt`
are not exposed).

**Never public:** `active`, `profileStatus`, `publishedAt`, `_id`/`id`, `createdAt`,
`updatedAt`, `management.headEmail`, `management.headPhone`, gallery items with
`status: "HIDDEN"` (they are dropped, not marked hidden in the response), and anything not
explicitly named above.

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
| Gallery | ≤60 images total (enforced atomically in the service, not just the schema) |
| Image upload | JPEG/PNG/WebP, ≤5 MB, magic-byte verified |

### Enums

| Enum | Values |
| --- | --- |
| `institutionType` | `SCHOOL`, `PU_COLLEGE`, `DEGREE_COLLEGE`, `ENGINEERING_COLLEGE`, `MEDICAL_COLLEGE`, `UNIVERSITY`, `OTHER`, `B_ED_COLLEGE`, `NURSING_COLLEGE`, `POLYTECHNIC`, `COACHING_INSTITUTION`, `TRAINING_INSTITUTION` |
| `profileStatus` | `DRAFT`, `PUBLISHED`, `SUSPENDED`, `ARCHIVED` (only `PUBLISHED` — and `active`  — is ever public) |
| `academic.genderType` | `BOYS`, `GIRLS`, `CO_ED` |
| `management.managementType` | `GOVERNMENT`, `AIDED`, `UNAIDED`, `PRIVATE`, `TRUST`, `SOCIETY`, `MINORITY`, `AUTONOMOUS`, `OTHER` |
| `gallery[].status` | `ACTIVE`, `HIDDEN` |
| media upload `kind` | `LOGO`, `COVER`, `GALLERY` |

### Error codes

Every error uses `{ "success": false, "error": { "code", "message", "details"? } }`.

| Code | Status | When |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Zod rejects the body; `details` lists every failing field |
| `UNAUTHORIZED` | 401 | No session / not signed in |
| `FORBIDDEN` | 403 | Wrong role, wrong institution, or cross-origin write |
| `NOT_FOUND` | 404 | Institution or gallery item doesn't exist for this actor — or, on public routes, isn't published |
| `CONFLICT` | 409 | Gallery already at 60 items |
| `INTERNAL_ERROR` | 500 | Unexpected — logged server-side, generic message to the caller |

---

## 6. OpenAPI

`GET /api/v1/openapi.json` and `.yaml` include both public profile endpoints, tagged
`Website`, alongside the existing hosted-form endpoints. The document title is
`I-DAP API` (or `I-DAP API · {institution name}` when generated with `?institution=INS0001`).
Since the profile endpoints require no credentials, they carry `security: []` in the spec
so tooling never prompts for a key that must not exist.
