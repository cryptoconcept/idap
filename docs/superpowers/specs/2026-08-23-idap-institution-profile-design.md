# I-DAP Phase 1 — Institution Profile V1

**Institute Digital Appearance Platform**

**Date:** 2026-08-23
**Status:** Awaiting review
**Supersedes nothing.** Extends the existing Lead Network subsystem without modifying its behaviour.

---

## 1. What this is

I-DAP is a **headless institutional data platform**. It owns the master record for an
educational institution and exposes that record over an API. It does not render the
institution's public presence — the school's own website, or any other authorised
consumer, reads the API and does the presenting.

Phase 1 builds the Institution Profile: the master identity layer every future module
attaches to.

**Create once → publish everywhere.** The institution enters its information one time.
The website, and later PassPercent, the scholarship platform, EduFleet Exchange and
Circular Hub, all consume the same record. No future product re-enters institutional
master data.

### What Phase 1 is not

No results, scholarships, staff recruitment, fleet marketplace, circular hub,
PassPercent, fee basket, analytics, AI, advertising, or payment subscriptions. The
architecture leaves room for them; this phase implements none of them.

**No public-facing HTML profile.** The original brief proposed `/institution/:slug`
with a hero, gallery and CTA. That is deliberately out of scope — I-DAP is headless.
The API is the product surface.

---

## 2. Decision register

Six decisions were taken before design. They bind the rest of this document.

| # | Decision | Rationale |
|---|---|---|
| 1 | `institutionId` remains `INS0001`. A new display-only `regionCode` (`KA-MYS`) is added. | The proposed `INS-KA-MYS-000001` is embedded in issued lead/application numbers, printed PDFs, published API paths, and a counter that would return `NaN` on the new format and silently allocate duplicate IDs. Geography belongs in the slug and in indexed city/district fields — searchable *and* changeable. An identifier must be neither. |
| 2 | `active` and `profileStatus` are independent fields. | `active` is load-bearing for login, token refresh and public branding. Replacing it with a publication status would take every existing institution offline the day it shipped. |
| 3 | Platform admin may **view** any profile but never edit it. Institute admin owns the profile. | The platform admin creates institutions and manages subscriptions. The profile belongs to the school. Enquiries and applications remain hard-blocked to the platform admin, unchanged. |
| 4 | Headless. No public HTML profile pages. | The school's website is the presentation layer. I-DAP is the data layer. Keeping these separate is the point of the platform. |
| 5 | The product is **I-DAP** (Institute Digital Appearance Platform). | Replaces "Lead Platform" in every user-visible surface. |
| 6 | No subscription model in Phase 1. | Deferred per the brief. Accepted cost: a schema migration when it lands. |

### Rulings made during design

- **The public profile endpoint is credential-free** — CORS-open, IP rate-limited,
  published-only, allow-list projection. A static website cannot hold a secret; that is
  the entire reason `/api/public` exists. Consumers needing more than the public
  projection use `/api/v1` with a key and secret.
- **The slug survives** with a changed job: an API lookup key, so a consumer can fetch
  by readable name rather than memorising `INS0001`.
- **Public image hosting becomes mandatory.** Third-party sites render the logo, cover
  and gallery directly, so those URLs must be public and CDN-served. The current storage
  layer is private-by-contract and needs a second, explicitly public path.
- **Hosted apply pages and `widget.js` are kept**, unchanged. They are existing Lead
  Network functionality and the on-ramp for a school with no website.
- **§16's "Website Status" card is dropped.** I-DAP cannot know whether a school's
  website is up; the card could only lie. Replaced by an Integration card showing active
  API credentials and last use — which I-DAP does know.
- **Naming conventions follow the codebase, not the brief.** The brief uses
  `snake_case`; the codebase uses `camelCase` throughout. camelCase wins.

---

## 3. Architecture

```
                    Institute Digital Appearance Platform
                    ─────────────────────────────────────

  Institute admin ──▶ Dashboard (Next.js, monochrome)
                           │
                           ▼
                    Institution  ◀── the single master record
                    institutionId: INS0001
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
     Profile          Lead Network        (future modules)
   identity           enquiries           results
   contact            applications        scholarships
   address            documents           announcements
   academic           notes               events
   management         activity            careers
   facilities
   social
   gallery
                           │
                           ▼
                    ┌─────────────┐
                    │     API     │
                    └─────────────┘
                     │     │     │
        ┌────────────┘     │     └────────────┐
        ▼                  ▼                  ▼
  School website      PassPercent      Other authorised
  (public, no key)    (key + secret)   consumers
```

**One institution = one master identity.** `Institution` is already that record in the
existing codebase — `institutionId` is unique, indexed, and carried by `Lead`,
`Application`, `Document`, `Note`, `Activity`, `ApiClient`, `Device`, `RefreshToken` and
`RateLimit`. Phase 1 deepens it. It creates no second institution entity.

### Layer separation

The data layer stores what an institution *is*. It stores nothing about how that
information is *presented*. No template names, no section ordering, no theme, no colour,
no layout. If a field would only make sense to one particular website, it does not
belong in the Institution record.

---

## 4. Data model

`src/models/Institution.ts` is extended. The existing thirteen fields are **left exactly
as they are** — they are referenced by the PDF generator, `serializeInstitution`,
`TenantInstitution` and `getPublicBranding`. Leaving them canonical means **no data
migration** and no risk to the Lead Network.

New material is added as sub-documents and arrays. Nothing is duplicated: a field that
exists flat today is not re-added inside a sub-document.

### 4.1 Existing fields — unchanged, canonical

```
institutionId      INS0001, unique, indexed, immutable
institutionName    display name
institutionType    enum
address            street address, line 1
city
state
pincode
contactPerson
phone              primary phone
email              primary email
website
logoUrl
active             account live: users log in, OMS accepts leads
```

### 4.2 New identity fields

```
legalName          string, optional     registered/legal entity name
shortName          string, optional     e.g. "SVS Hanur"
slug               string, unique (sparse), indexed
regionCode         string, optional     e.g. "KA-MYS" — display and filtering
coverImageUrl      string, optional
establishedYear    number, optional     1800..current year
tagline            string, optional, 160 max
description        string, optional, 4000 max
profileStatus      enum, default DRAFT
publishedAt        date, optional
```

`slug` is **not** marked `required` in the schema, and its unique index is **sparse**.
Every institution created from now on gets one at creation; existing institutions get one
from the backfill in §13. Marking it required would make every un-backfilled record fail
validation the moment its admin pressed Save — a self-inflicted outage between deploy and
backfill. The service layer treats it as mandatory; the schema tolerates its absence.

`profileStatus` ∈ `DRAFT | PUBLISHED | SUSPENDED | ARCHIVED`.

Only `PUBLISHED` is exposed by the public API. `profileStatus` never affects `active`;
a school in `DRAFT` continues to log in and receive enquiries normally.

### 4.3 Contact — extension only

Primary phone, email, website and contact person already exist flat and stay there.

```
contact {
  secondaryPhone   optional
  alternateEmail   optional
  whatsapp         optional
}
```

### 4.4 Address — extension only

`address`, `city`, `state`, `pincode` already exist flat and stay there. `address` is
line 1.

```
addressLine2       optional
locality           optional
area               optional
taluk              optional
district           optional, indexed
country            default "India"

geo {
  latitude         number, optional, -90..90
  longitude        number, optional, -180..180
  mapUrl           url, optional
}
```

India-appropriate without being India-only: `country` is a field, not an assumption, and
`taluk`/`district` are optional.

### 4.5 Academic

```
academic {
  board                string, optional, indexed   CBSE, ICSE, State, etc.
  affiliation          string, optional
  recognition          string, optional
  affiliationNumber    string, optional
  udiseCode            string, optional
  medium               string[]                    English, Kannada, Hindi, ...
  genderType           enum: BOYS | GIRLS | CO_ED
  currentAcademicYear  string, optional            "2026-27"
  classesOffered       string[]                    schools
  coursesOffered       string[]                    colleges
}
```

Both `classesOffered` and `coursesOffered` exist because the model must serve schools
*and* colleges. Neither is required.

### 4.6 Management

```
management {
  managementType   enum: GOVERNMENT | AIDED | UNAIDED | PRIVATE | TRUST | SOCIETY | MINORITY | AUTONOMOUS | OTHER
  trustName        optional
  societyName      optional
  managementName   optional
  principalName    optional
  headDesignation  optional      Principal / Director / Dean / Correspondent
  headEmail        optional
  headPhone        optional
}
```

Flat by design. No hierarchy in V1.

### 4.7 Facilities

```
facilities: [
  {
    code       string, required     LIBRARY, SCIENCE_LAB, TRANSPORT, ...
    label      string, required     display text, editable by the institution
    available  boolean, default true
    note       string, optional     "40 buses across 12 routes"
  }
]
```

A known-code list ships as a UI convenience for picking common facilities. The stored
shape accepts **any** code with any label, so a new facility type never requires a schema
change or a migration — the brief's §11 requirement.

### 4.8 Social

```
social {
  facebook   url, optional
  instagram  url, optional
  youtube    url, optional
  linkedin   url, optional
  x          url, optional
  other      [{ label, url }]
}
```

Every value validated by the existing `optionalUrlSchema`.

### 4.9 Gallery

```
gallery: [
  {
    _id          ObjectId
    imageUrl     string, required     public URL
    title        optional
    description  optional
    sortOrder    number, default 0
    status       enum: ACTIVE | HIDDEN, default ACTIVE
    uploadedAt   date
  }
]
```

Embedded, **capped at 60 items**. This is a gallery, not a media platform. If a later
phase needs unbounded media, it gets its own collection; embedding now keeps V1 to a
single read.

### 4.10 Institution types

Five values are appended to the existing seven. Nothing is renamed or removed, so all
existing records stay valid.

Existing: `SCHOOL`, `PU_COLLEGE`, `DEGREE_COLLEGE`, `ENGINEERING_COLLEGE`,
`MEDICAL_COLLEGE`, `UNIVERSITY`, `OTHER`

Added: `B_ED_COLLEGE`, `NURSING_COLLEGE`, `POLYTECHNIC`, `COACHING_INSTITUTION`,
`TRAINING_INSTITUTION`

### 4.11 Indexes

| Index | Why |
|---|---|
| `institutionId` unique | exists |
| `slug` unique | public lookup by readable name |
| `active` | exists |
| `profileStatus` | public listing filters on it |
| `institutionType` | directory filtering |
| `district`, `city` | geographic filtering — the job the ID format was wrongly asked to do |
| `academic.board` | directory filtering |
| `institutionName` text | search |

---

## 5. Slug

Derived from `institutionName` plus locality: `sri-vivekananda-school-hanur`.

- Lowercase, ASCII, hyphen-separated, 4–90 characters.
- Unique across the platform.
- **Stable.** Generated once at creation and never changed automatically — renaming an
  institution does not move its slug, because consumers have URLs pointing at it.
  Changing it is a deliberate act by the institute admin.
- Collisions resolve by appending `-2`, `-3`, … allocated through the same atomic
  compare-and-swap `Counter` idiom already used for institution and lead numbers. Never a
  read-then-write, which races.
- Reserved words (`api`, `admin`, `public`, `login`, `institution`, `institutions`,
  `settings`, `apply`, `widget`) are rejected.

The slug is a lookup key, never a primary key. Every internal reference remains
`institutionId`.

---

## 6. Profile completion

A deterministic, server-computed score. One function, one weight table, used by the
dashboard and the API alike so the two can never disagree.

| Group | Weight | Complete when |
|---|---:|---|
| Basic identity | 15 | name, type, description, establishedYear all present |
| Contact | 12 | phone, email, contactPerson present |
| Address | 12 | address, city, district, state, pincode present |
| Academic | 15 | board present and at least one of classesOffered / coursesOffered non-empty |
| Management | 10 | managementType and principalName present |
| Facilities | 10 | at least three facilities recorded |
| Logo | 10 | logoUrl present |
| Cover image | 8 | coverImageUrl present |
| Social | 8 | at least two social links present |
| | **100** | |

The API returns the percentage **and the itemised list of what is missing**, so the
dashboard shows the institution exactly what to fix rather than an unexplained number.

Partial credit within a group is proportional to fields present. The score is never
rounded up and never padded — a profile with nothing filled in scores 0.

---

## 7. Storage — the public path

Today `StorageAdapter` is private by contract: "Objects are always private: served
through an authenticated, tenant-checked route." That contract is correct for admission
documents and must not change for them.

Logo, cover and gallery images are different — a third-party website renders them
directly and cannot authenticate. They need a second, explicitly public path.

```ts
interface StorageAdapter {
  // existing — unchanged, for admission documents
  put(input): Promise<StoredObject>
  get(key): Promise<...>
  delete(key): Promise<void>

  // new — for institution media only
  putPublic(input): Promise<StoredObject>   // returns a directly-loadable URL
  deletePublic(key): Promise<void>
}
```

- **Vercel Blob adapter:** `access: "public"`. Returns a CDN URL.
- **Local adapter:** writes under a public directory served by an unauthenticated
  `/api/media/[...key]` route. Honest about being a development path.

Two consequences recorded deliberately:

1. **The cost model changes.** Egress now scales with website visitors rather than
   enquiry volume. A school going viral on results day costs money on a plan priced for
   admissions.
2. **Only institution media may use `putPublic`.** Admission documents keep the private
   path. This boundary is enforced by which service calls which method —
   `DocumentService` never touches `putPublic`.

Upload constraints: JPEG/PNG/WebP only, verified by magic bytes rather than the declared
content type; 5 MB per image; dimensions bounded; filenames never taken from user input.

---

## 8. API surface

Existing conventions are followed. The brief's §20 escape hatch applies: "Use the
project's existing API naming conventions if they differ."

### 8.1 Institute admin — own institution

`/api/settings/institution` already exists as institution self-service and is the correct
home. Extended, not replaced.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/settings/institution` | full profile + completion + missing list |
| `PATCH` | `/api/settings/institution` | partial update, any section |
| `POST` | `/api/settings/institution/publish` | DRAFT → PUBLISHED, sets `publishedAt` |
| `POST` | `/api/settings/institution/unpublish` | PUBLISHED → DRAFT |
| `POST` | `/api/settings/institution/media` | upload an image; `kind` ∈ `LOGO` \| `COVER` \| `GALLERY` |
| `DELETE` | `/api/settings/institution/media/:id` | remove a gallery image |

`kind` is required and validated. `LOGO` and `COVER` replace the existing image and
delete the old object; `GALLERY` appends, subject to the 60-item cap. Deleting a logo or
cover is done by `PATCH`ing the field to null, not through the media endpoint.

`PATCH` accepts any subset of sections. Unknown keys are stripped by Zod — the existing
mass-assignment defence. `institutionId`, `active` and `profileStatus` are **not**
accepted here; status changes go through the explicit publish endpoints, and `active` is
platform-admin territory.

### 8.2 Platform admin

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/institutions` | list — exists, extended with profileStatus + completion |
| `POST` | `/api/institutions` | create — exists, now also allocates a slug |
| `GET` | `/api/institutions/:institutionId` | **view** full profile, read-only |
| `PATCH` | `/api/institutions/:institutionId` | provisioning fields only: `institutionName`, `institutionType`, `active`, `regionCode` |

Per decision 3, the platform admin's `PATCH` cannot reach profile content. That is
enforced by a separate, narrower Zod schema — not by a UI that omits the fields.

These routes stay **cookie-only**, excluded from bearer auth, as they are today. A stolen
mobile token must not reach provisioning.

### 8.3 Public — credential-free

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/public/:institutionId/profile` | published profile, public projection |
| `GET` | `/api/public/institutions/:slug` | same payload, resolved by slug |
| `GET` | `/api/public/:institutionId` | existing branding endpoint — unchanged |

CORS `*`, `OPTIONS` preflight, IP rate-limited on the existing limiter, cached. Returns
`404` for any institution that is not `PUBLISHED` — never `403`, which would confirm the
record exists.

The existing branding endpoint keeps its exact response shape. Consumers already
depending on it see no change.

### 8.4 OpenAPI

The generator at `src/lib/api/openapi.ts` gains the two public profile endpoints, tagged
`Website`. Every institution's downloadable spec therefore describes the profile API
automatically — the create-once-publish-everywhere principle applied to the
documentation itself. Document title becomes `I-DAP API`.

### 8.5 Future extensibility

Later modules attach as siblings under the same institution namespace —
`/api/public/:institutionId/results`, `/announcements`, `/events` — with no restructuring.
None are implemented in Phase 1.

---

## 9. Authorization

The existing chokepoint in `src/lib/tenant/index.ts` is **not modified**. `tenantFilter()`
continues to throw for `SUPER_ADMIN`; the platform admin's access to enquiries and
applications remains zero.

Profile access is a distinct concern and gets a distinct guard.

| Actor | Own profile | Other profiles | Enquiries / applications |
|---|---|---|---|
| Institute admin | read + write | none | own institution only |
| Platform admin | n/a | **read only** | **none** |
| Public (no credentials) | published projection | published projection | create only |
| API key + secret | per permissions | none | per permissions |

`institutionId` is never taken from a request body or query. It is derived from the
session for authenticated routes, and from the URL path for public routes where it
identifies a published record only.

---

## 10. Public vs private projection

One function is the only path from an Institution document to a public response. It is an
**allow-list**: it names the fields that may leave. A field added to the schema is private
by default and stays private until someone deliberately adds it to the list.

A deny-list would leak every future field the day it was added. This is the single
highest-risk surface in Phase 1 and is designed accordingly.

**Public:** institutionId, slug, name, legal/short name, type, regionCode, tagline,
description, establishedYear, logo, cover, address block, geo, primary contact, academic
block, management (names and designations only), facilities, social, active gallery items.

`regionCode` is public because it encodes nothing that `state` and `district` do not
already expose — it is a compact form of geography the institution publishes anyway.

**Never public:** `active`, `profileStatus`, `publishedAt`, internal timestamps, users,
credentials, leads, applications, documents, notes, activity, device registrations, head
email and phone unless the institution explicitly marks them public.

Gallery items with `status: HIDDEN` are excluded. Draft, suspended and archived profiles
return `404`.

---

## 11. Dashboard

Monochrome, existing design system, existing components. No new visual language.

### 11.1 Navigation

`Institution Profile` is added to the institute-admin nav, above Enquiries. The platform
admin's nav gains nothing — profile viewing happens inside the existing institution
detail screen.

### 11.2 Institution dashboard

Header: logo, institution name, `INS0001`, profile status badge, completion percentage.

Cards:

| Card | Source |
|---|---|
| Profile completion | computed, links to the first incomplete section |
| Integration | active API credentials + last used — replaces the dropped "Website Status" |
| Lead Network | active/inactive, enquiries accepted |
| Enquiries | existing `DashboardService.getStats` |
| Applications | existing `DashboardService.getStats` |

No duplicate enquiry or application tables are created. The dashboard reads the existing
Lead Network services.

Recent Enquiries and Recent Applications lists appear on the **institute admin**
dashboard only, and never on the platform admin's.

### 11.3 Profile editor

Eight sections with left-hand navigation, each its own form — never one giant form:

1. Basic Information
2. Contact
3. Address
4. Academic
5. Management
6. Facilities
7. Social
8. Gallery

Per section: explicit Save, dirty-state guard on navigate-away, inline Zod messages,
success and error toasts via the existing `sonner` setup, loading / empty / error states,
responsive down to mobile. A completion meter is visible throughout.

Publish is a deliberate action with a confirmation summarising what will become public.
Publishing is allowed below 100% completion — a school should not be blocked from
publishing because it has no YouTube channel.

**Autosave is deliberately not implemented.** The brief said "where appropriate"; it is
not appropriate for a record that becomes public on publish. Explicit save, explicit
publish.

---

## 12. Lead Network integration

Nothing about the Lead Network changes. Enquiries and applications already carry
`institutionId` and already resolve to the master record.

- No route is removed, renamed, or given a different response shape.
- No enquiry or application field changes.
- The 214 existing tests must pass unmodified. Any test that needs editing to pass is
  treated as a regression, not as a test that needs updating.
- Hosted apply pages and `widget.js` continue to work exactly as they do.
- The existing `/api/public/:institutionId` branding endpoint keeps its exact shape.

The only integration point is the dashboard reading existing Lead Network services for
its summary cards.

---

## 13. Migration

**No data migration is required.** Every new field is optional or has a default.

| Concern | Handling |
|---|---|
| Existing institutions have no slug | Backfilled by an idempotent, re-runnable script from name + locality. Reversible: the script only writes where `slug` is absent. |
| Existing institutions have no `profileStatus` | Defaults to `DRAFT`. Harmless: `active` is untouched, so login and lead capture continue. |
| Existing flat fields | Untouched. No copying into sub-documents, no dual-write. |
| New institution types | Appended to the enum. Existing values unchanged. |

**Mongoose model cache:** schema changes do not take effect until `next dev` restarts.
This has already cost this project a debugging session and will recur throughout a phase
that is mostly schema work.

---

## 14. Testing

New coverage:

- **Institution profile:** create, read, partial update per section, publish, unpublish.
- **Slug:** generation, uniqueness, collision suffixing under concurrency, reserved-word
  rejection, stability across a rename.
- **Authorization:** institute admin A cannot read or write institution B's profile;
  platform admin can read but every write path returns 403; unauthenticated write returns
  401.
- **Public projection — the important one:** a `DRAFT` profile returns 404; a `HIDDEN`
  gallery item is absent; `active`, `profileStatus` and `regionCode` never appear in a
  public response; a newly added schema field does not leak without being allow-listed.
- **Completion:** deterministic for a given document; empty profile scores 0; every group
  contributes its stated weight.
- **Media:** non-image rejected by magic bytes even with a spoofed content type;
  oversized rejected; gallery cap enforced; admission documents still take the private
  path.
- **Regression:** all 214 existing tests pass unmodified.

Security tests are verified by mutation: the guard is removed and the test must fail. A
test that still passes without its guard proves nothing and is rewritten.

---

## 15. Definition of done

- [ ] Application starts; `main` still green.
- [ ] All 214 existing tests pass unmodified.
- [ ] Existing enquiry and application create/read paths verified working.
- [ ] Hosted apply pages and widget verified working.
- [ ] Institution created with `INS0001`-format id and a unique slug.
- [ ] Institute admin can edit every profile section and see validation.
- [ ] Logo, cover and gallery upload, display and delete.
- [ ] Facilities and social links work.
- [ ] Completion computed deterministically with an itemised missing list.
- [ ] Draft saved; publish and unpublish work.
- [ ] Public profile API returns the published projection by id and by slug.
- [ ] Draft, suspended and archived profiles return 404 publicly.
- [ ] No private field reachable through any public endpoint.
- [ ] Platform admin can view but provably cannot edit a profile.
- [ ] Cross-institution access blocked, proven by mutation-tested cases.
- [ ] Product renamed to I-DAP across every user-visible surface.
- [ ] OpenAPI document includes the public profile endpoints.
- [ ] Responsive; loading, empty and error states present throughout.
- [ ] Documentation updated: API reference, data model, architecture.

---

## 16. Known limitations

- Gallery capped at 60 images, embedded. A media-heavy institution will outgrow it.
- No image transformation or thumbnailing — full-size images are served to consumers.
- No subscription model, by decision 6. Adding it later is a migration.
- No versioning or audit history of profile changes beyond the existing `Activity` log.
- No bulk import of institutions.
- Slug backfill is name-derived and may need manual correction for institutions with
  similar names in the same locality.
- The public API has no per-consumer analytics; you cannot tell which website is reading.

---

## 17. Recommended Phase 2

**Results Management**, per the brief — attaching to the same master identity and
exposed through the same public API pattern established here.

Before it, one thing from Phase 1's findings deserves consideration: the Lead Network
still has no follow-up mechanism. Leads have no assignee and no follow-up date, and there
is only one institution role. Results attract enquiries; nothing yet converts them.
