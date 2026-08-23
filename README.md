# I-DAP

**Institute Digital Appearance Platform.** A multi-tenant admission engine for schools, PU colleges,
degree colleges, universities and other institutions, built around one master `Institution` record
per tenant. External websites push admission enquiries and applications in over an authenticated
API; each institution reviews, decides on and prints them from its own dashboard. Every institution
also owns a headless **profile** — identity, contact, academics, facilities, gallery — that it
publishes once and any authorised consumer, starting with its own website, reads over the API. See
[Institution profile](#institution-profile) below.

Every record is scoped to an `institutionId` (`INS0001`, `INS0002`, …) that is always derived from
the authenticated session or API credential — never from the request body.

---

## Quick start

```bash
npm install
cp .env.example .env.local        # then set AUTH_SECRET and MONGODB_URI
npm run seed -- --demo            # institutions, users and one API credential
npm run dev
```

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The seed prints the accounts it creates and one API key/secret pair. **The secret is shown once** —
it is stored only as a keyed hash.

| Role | Email | Password |
| --- | --- | --- |
| Super admin | `admin@aemplatform.local` | `ChangeMe!2026` |
| Institution admin (INS0001) | `admin@infinityschool.edu.in` | `Infinity!2026` |
| Institution admin (INS0002) | `admin@intelligentpublic.edu.in` | `Intelligent!2026` |

Change these before deploying anywhere real.

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | yes | MongoDB connection string. |
| `AUTH_SECRET` | yes | Signs dashboard sessions **and** hashes API secrets. Rotating it invalidates every session and every issued API secret. |
| `NEXT_PUBLIC_APP_URL` | no | Fallback public origin for generated snippets. The request's own host is preferred. |
| `SESSION_TTL_HOURS` | no | Dashboard session lifetime. Default `12`. |
| `UPLOAD_DIR` | no | Where the local storage adapter writes uploads. Default `.uploads/`, outside `public/`. Ignored when `BLOB_READ_WRITE_TOKEN` is set. |
| `BLOB_READ_WRITE_TOKEN` | no | The **public**-access Blob store — institution logo/cover/gallery media. Its presence switches that path from local disk to Blob. |
| `DOCUMENTS_BLOB_READ_WRITE_TOKEN` | no | The **private**-access Blob store — admission documents. Its presence switches document storage from local disk to Blob. A separate store from the one above on purpose — see [Institution media — the public path](#institution-media--the-public-path). |

---

## Verifying it works

```bash
npm test          # 289 tests, ~18s, no server needed
npm run typecheck
npm run lint
npm run build
```

`npm test` spins up an in-memory MongoDB per test file, so it needs nothing running. Set
`TEST_MONGODB_URI` to point at a real server instead if the in-memory binary is unavailable.

What it covers, roughly in order of how much it matters:

| Area | What is asserted |
| --- | --- |
| Tenant isolation | Every clause names exactly one institution; cross-tenant reads return `404`; search, filters, notes and dashboard counts all stay inside one tenant; the platform admin gets no clause at all |
| Identifier generation | 100 concurrent application numbers produce 100 distinct values — a collision would merge two families' records |
| API credentials | Bearer and header forms, wrong secret, unknown key, missing separator, per-endpoint scopes, revoked keys, deactivated institutions, and that only a hash is ever stored |
| Rate limiting | Exact allowance then `429`, independent buckets, correct counting under 30 concurrent requests, window rollover |
| Validation | Phone normalisation, academic-year formats, and that unknown keys are dropped — which is what stops mass assignment |
| Sessions | Round-trip, tampered payload rejected, wrong signing secret rejected, malformed input handled |
| Uploads | MIME/extension agreement, size ceiling, generated filenames |
| Error envelope | Documented shape per code, and that an unexpected error's message never reaches the caller |
| PDF | Single-page A4 output, a near-empty application still renders, a non-`http(s)` logo URL is ignored rather than fetched |
| OpenAPI | Paths concrete when scoped, browser-safe operations declare `security: []`, every `$ref` resolves |

### End-to-end

```bash
npm run dev
npm run test:e2e -- http://localhost:3000 --cleanup
```

This drives a running server through the full acceptance scenario: a platform admin creates an
institution and its admin, an external site posts an enquiry and an application with API credentials,
a second institution is shown to be unable to see either, the application moves
`SUBMITTED → UNDER_REVIEW → APPROVED`, the print view and PDF render with the institution's branding,
revoked credentials stop working, a static site submits without credentials, and the platform admin
is refused everywhere including through the credential-minting path.

---

## Architecture

```
src/
  app/
    (auth)/login              sign in
    (dashboard)/              sidebar shell — institution and super admin screens
      dashboard  enquiries  applications  profile  integration  settings
      admin/     institutions  api-clients  settings
    (print)/applications/[applicationNumber]/print   A4 print view, no app chrome
    (public)/apply/[institutionId]                   hosted enquiry + application forms
    api/
      auth/          login, logout, me
      v1/            external API (API-key authenticated)
      public/        hosted-form submission (IP rate limited), public profile (cached, credential-free)
      settings/institution/  institute admin's own profile — read, write, publish, media
      institutions/  platform admin — create, list, view any profile, provision-only patch
      …              dashboard + admin APIs (cookie authenticated)
    widget.js        embeddable script
  components/  ui/ dashboard/ leads/ applications/ institutions/ integration/ profile/ public/ shared/
  lib/         auth/ api/ db/ pdf/ profile/ security/ storage/ tenant/ utils/ validation/
  models/      Institution User Lead Application Document Note Activity ApiClient Counter RateLimit
  services/    LeadService ApplicationService InstitutionService ApiClientService
               DocumentService ActivityService NoteService DashboardService slug.service

tests/
  unit/        tenant guards, validation, security primitives, API contract
  integration/ tenant isolation, identifier concurrency, credential auth,
               rate limiting, application lifecycle and PDF
  helpers/     in-memory MongoDB harness and factories
```

Business logic lives in `src/services`. Route handlers and pages authenticate, resolve the tenant,
validate input and hand off — so the web UI, the REST API and any future client share one
implementation.

### Multi-tenancy

`src/lib/tenant/index.ts` is the only place that decides which tenant a request acts on:

```ts
const { clause } = await requireTenantUser();   // { institutionId }, always
const leads = await LeadService.list(clause, query);
```

- Institution admins are pinned to their own `institutionId`. An `institutionId` in the query string
  or body is **ignored**, not honoured — there is no parameter that widens a query.
- API clients get their tenant from the credential (`src/lib/api/api-auth.ts`).
- **Platform admins are refused outright.** `tenantFilter()` has no code path that returns an
  unscoped clause; for a `SUPER_ADMIN` it throws.

`getCurrentInstitution()` returns the signed-in institution's branding for pages, print views and PDFs.

### The platform admin boundary

The platform administrator provisions institutions. They are deliberately **not** a super-user over
what those institutions receive: enquiries and applications are readable only by the institution
that received them, individually and in aggregate.

| Platform admin can | Platform admin cannot |
| --- | --- |
| Create institutions, edit profiles, activate/deactivate | Read any enquiry or application |
| Create an institution's first admin account | See counts or statistics derived from them |
| Review API credential metadata, revoke a leaked key | **Issue** API credentials |
| Read platform provisioning figures | Open a print view, PDF or uploaded document |

Issuing credentials is excluded on purpose. A platform admin who could mint a key carrying
`READ_APPLICATION` would have a route straight around the rule, so key creation belongs to
institution admins alone. Revocation stays available, because shutting off a leaked key grants no
data access and is a platform-safety action.

The boundary is enforced in three places:

1. **`proxy.ts`** redirects a platform admin off every tenant screen with a `307`, before anything
   renders.
2. **`tenantFilter()`** throws for `SUPER_ADMIN`, so every route handler that touches tenant data
   returns `403` — this is the authoritative check, and it holds even if a route forgets its guard.
3. **`POST /api/api-clients`** requires `requireInstitution()`, closing the credential escalation path.

`scripts/acceptance-test.sh` asserts all of this, including that the refused response carries no
applicant data.

### Identifiers

Allocated with an atomic `$inc` on a per-scope counter, so concurrent requests can never collide.

```
INS0001              institution
INS0001-LD000001     enquiry
INS0001-APP-000001   admission application
```

---

## Institution profile

I-DAP is **headless**: every institution has one master profile — identity, contact, address,
academic detail, management, facilities, social links and a gallery, layered onto the existing
`Institution` record — and I-DAP exposes it over an API rather than rendering it. The institution's
own website, or any other authorised consumer, reads the API and does the presenting.

The profile has its own publication lifecycle, and it is **independent of `active`** in one
sentence: `active` governs login and whether the Lead Network accepts enquiries, `profileStatus`
governs whether the public API serves the profile, and publishing or unpublishing one never touches
the other — a `DRAFT` institution keeps logging in and taking enquiries exactly as before.

- Institute admins edit their own profile at **Institution Profile** in the dashboard (`/profile`),
  across eight sections, with an explicit, deliberate **Publish** action —
  `POST /api/settings/institution/publish`.
- Platform admins can view any institution's profile (`GET /api/institutions/{institutionId}`) but
  can never write its content — only provisioning fields (`institutionName`, `institutionType`,
  `active`, `regionCode`), enforced by a narrower schema on the server.
- Anyone, with no credentials, can read a **published** profile:

  ```bash
  curl https://your-domain.com/api/public/INS0001/profile
  curl https://your-domain.com/api/public/institutions/infinity-school-of-excellence-mysore
  ```

  A draft, suspended, archived, deactivated, or unknown institution all return an identical `404` —
  never `403` — so the response can never be used to confirm which institutions exist privately.

Full endpoint reference, request/response shapes and curl examples:
[`docs/api/institution-profile.md`](docs/api/institution-profile.md). Architecture, the allow-list
public projection rule, the slug contract, the storage split, and two known limitations recorded
honestly rather than glossed over: [`docs/architecture/institution-master-identity.md`](docs/architecture/institution-master-identity.md).

---

## External API

Base path `/api/v1`. Credentials come from **Integration → API credentials** in the dashboard.

```http
Authorization: Bearer <KEY_ID>.<SECRET>
# or
X-API-KEY: <KEY_ID>
X-API-SECRET: <SECRET>
```

| Endpoint | Permission |
| --- | --- |
| `POST /api/v1/leads` | `CREATE_LEAD` |
| `POST /api/v1/applications` | `CREATE_APPLICATION` |
| `GET /api/v1/applications/{applicationNumber}` | `READ_APPLICATION` |
| `GET /api/v1/openapi.json` · `GET /api/v1/openapi.yaml` | none — the spec is public |

Browser-safe endpoints, for websites with no backend of their own:

| Endpoint | Credentials |
| --- | --- |
| `POST /api/public/{institutionId}/leads` | none — rate limited per visitor IP |
| `POST /api/public/{institutionId}/applications` | none — rate limited per visitor IP |
| `GET /api/public/{institutionId}` | none — branding only (name, address, phone, logo) |
| `GET /api/public/{institutionId}/profile` | none — full **published** profile; cached, not rate limited |
| `GET /api/public/institutions/{slug}` | none — same, looked up by slug |

```bash
curl -X POST http://localhost:3000/api/v1/leads \
  -H "Authorization: Bearer <KEY_ID>.<SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"studentName":"Rahul Kumar","phone":"9876543210","classInterested":"Grade 5"}'
```

```json
{ "success": true, "leadNumber": "INS0001-LD000128", "message": "Enquiry submitted successfully" }
```

Errors are always the same shape, with an appropriate status code:

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "phone: Phone number is required" } }
```

Limit: **100 requests per minute per API key**, reported through `X-RateLimit-*` headers and a `429`
with `Retry-After` when exceeded. The read endpoint returns only what the API scope allows — notes,
activity and internal metadata are never exposed.

### OpenAPI / Swagger

The API describes itself. An OpenAPI 3.1 document is generated from the same constants the runtime
uses, so it cannot drift from the code:

```
GET /api/v1/openapi.json[?institution=INS0001]
GET /api/v1/openapi.yaml[?institution=INS0001]
```

Pass `institution` and every example is pre-filled with that tenant's identifier format
(`INS0001-APP-000124` rather than a placeholder) — which is exactly what the download buttons on an
institution's **Integration → API documentation** tab do. An unknown institution falls back to the
placeholder examples rather than erroring, so the endpoint cannot be used to probe which institution
IDs exist.

The document carries no secrets, so it is public and any tool can read it by URL:

```bash
npx openapi-typescript https://your-domain.com/api/v1/openapi.json -o admissions-api.d.ts
```

Postman and Insomnia both import it from the URL directly, and it renders in any Swagger UI
instance. Both formats validate against the official OpenAPI 3.1 schema.

The browsable, monochrome version of this reference lives at **Integration → API documentation**,
with a Copy cURL button on every endpoint and download buttons for the spec.

### Dashboard and admin APIs

Cookie-authenticated, same-origin only.

```
GET    /api/dashboard
GET    /api/leads                                   POST   /api/leads
GET    /api/leads/{id}                              PATCH  /api/leads/{id}
GET    /api/leads/{id}/notes                        POST   /api/leads/{id}/notes
GET    /api/applications                            POST   /api/applications
GET    /api/applications/{applicationNumber}        PATCH  /api/applications/{applicationNumber}
GET    /api/applications/{applicationNumber}/notes  POST   /api/applications/{applicationNumber}/notes
GET    /api/applications/{applicationNumber}/documents
POST   /api/applications/{applicationNumber}/documents
GET    /api/applications/{applicationNumber}/pdf
GET    /api/documents/{documentId}
GET    /api/settings/institution                    PATCH  /api/settings/institution
POST   /api/settings/institution/publish             (institution admin — full profile, {"action":"publish"|"unpublish"})
POST   /api/settings/institution/media                     PATCH  /api/settings/institution/media/{mediaId}
DELETE /api/settings/institution/media/{mediaId}
GET    /api/institutions                            POST   /api/institutions       (platform admin)
GET    /api/institutions/{institutionId}            PATCH  /api/institutions/{institutionId}
                                                       (platform admin — GET reads any profile, PATCH is provisioning-fields-only)
GET    /api/api-clients                             POST   /api/api-clients   (institution admin)
DELETE /api/api-clients/{id}                                                  (either role)
```

Full request/response detail, including which section fields `PATCH /api/settings/institution`
accepts and the media upload contract: [`docs/api/institution-profile.md`](docs/api/institution-profile.md).

---

## Website integration

Pick by where the institution's website code runs.

**No server (static site).** Plain HTML, Astro, Hugo, Jekyll, a Next.js export — anything without a
backend. A static site cannot hold a secret, so it uses the credential-free public endpoints, which
are CORS-enabled and rate limited per visitor IP:

```
POST /api/public/{institutionId}/leads           submit an enquiry
POST /api/public/{institutionId}/applications    submit an application
GET  /api/public/{institutionId}                 name, address, phone, logo for the site chrome
```

```js
const response = await fetch("https://your-domain.com/api/public/INS0001/leads", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ studentName, phone, classInterested }),
});
const { leadNumber } = await response.json();
```

**No code at all.** Link to the hosted pages `/apply/INS0001` and `/apply/INS0001/enquiry`, or drop
in the widget:

```html
<script src="https://your-domain.com/widget.js" data-institution="INS0001"></script>
```

**Has a server.** Call `/api/v1` from the backend with an API key. That adds an audited caller
identity per integration and the ability to read applications back. Never put the secret in browser
JavaScript — anyone could read it and submit as that institution.

### Handing the API to a website builder

The OpenAPI document is written to be given to another developer or coding agent building an
institution's site:

```
https://your-domain.com/api/v1/openapi.json?institution=INS0001
https://your-domain.com/api/v1/openapi.yaml?institution=INS0001
```

With `institution` set, every path in it is concrete (`/api/public/INS0001/leads`, not a template),
so there is nothing to substitute. Its description explains which endpoint set a static site should
use, carries a complete working form example, and states plainly that keys must never ship to the
browser. Endpoints are tagged **Website** (no credentials, browser-safe) and **Server to server**
(API key, backend only), and the browser-safe operations carry `security: []` so tooling does not
prompt for a key that must not exist.

---

## Print and PDF

- `/applications/{applicationNumber}/print` — an A4 portrait document with print CSS, the app chrome
  suppressed. `?autoprint=1` opens the print dialog on load.
- `/api/applications/{applicationNumber}/pdf` — the same document rendered server-side with PDFKit.
  Add `?inline=1` to view instead of download.

Both pull the institution's name, logo, address and contact details from the database, so editing
them under **Settings** changes every future document. Printing and downloading are both recorded in
the application's activity trail.

---

## Security

**Authentication** — bcrypt password hashing (cost 12), HS256 session JWTs in `HttpOnly`,
`SameSite=Lax`, `Secure`-in-production cookies. Sessions are re-checked against the user record on
every request, so deactivating a user or an institution takes effect immediately rather than at token
expiry. Sign-in is limited to 8 attempts per 5 minutes per account+IP, and failures take the same
time whether or not the account exists.

**Authorization** — role checks (`requireUser`, `requireSuperAdmin`, `requireInstitution`,
`requireTenantUser`) and tenant scoping live in one module and are applied in route handlers, not
scattered through pages.

**Tenant isolation** — every query carries a clause from `tenantFilter()`, which can only ever
produce a single `institutionId`. Cross-tenant reads between institutions return `404`, not `403`, so
an identifier cannot be probed for existence. The platform administrator is excluded from tenant data
entirely — see [The platform admin boundary](#the-platform-admin-boundary).

**API credentials** — a random `keyId` plus 288 bits of secret. Only an HMAC-SHA256 of the secret is
stored, compared in constant time; the plaintext is shown once at creation. Keys carry explicit
scopes and can be revoked, which takes effect on the next request. Revoked keys are retained so the
audit trail stays intact.

**Input validation** — every API body and form is parsed with Zod. Unknown keys are dropped, which is
what protects the models from mass assignment. Search terms are regex-escaped before reaching
MongoDB, so a query string can never be interpreted as an operator.

**CSRF** — `SameSite=Lax` cookies plus an `Origin` check on every state-changing dashboard request.

**File uploads** — MIME type and extension must agree, the magic number must match the declared type,
5 MB ceiling, and the stored filename is always generated. Files are written outside `public/` and
served only through an authenticated, tenant-checked route with `nosniff` and a sandboxing CSP.

**Rate limiting** — fixed-window counters in MongoDB with a TTL index, so limits hold across every
server instance rather than per process.

**Error handling** — a single translation layer turns thrown errors into the documented JSON envelope.
Unexpected errors are logged server-side and reported to callers as a generic message; the UI shows
"Something went wrong." with a reference digest.

---

## Interface

Monochrome by design — black, white and grey only, no colour and no gradients.

Because hue is unavailable, status is encoded by **fill weight**: a solid chip for a terminal positive
outcome (Approved, Admitted), a filled chip for work in progress, an outlined chip for something
untouched, and a dashed chip for a terminal negative outcome. The application detail page carries the
same idea into a stepped rail drawn in hairlines, filled to the current stage.

Identifiers — institution IDs, enquiry numbers, application numbers — are the artifacts this product
issues, so they get one consistent typographic treatment (monospace, tabular figures) everywhere they
appear: tables, detail headers, the printed document and the cURL examples.

Printed applications are set in a serif face, because that is what a formal admission document looks
like in the institutions this serves.

Layout: sidebar plus content on desktop, a hamburger sheet on mobile, and every table collapses to
cards below `md`.

---

## Storage adapter

`src/lib/storage` defines a small `StorageAdapter` interface with two implementations, selected at
runtime:

| Condition | Adapter | Where files live |
| --- | --- | --- |
| `DOCUMENTS_BLOB_READ_WRITE_TOKEN` is set | Vercel Blob | The **documents** Blob store, `access: "private"` |
| otherwise | Local disk | `UPLOAD_DIR`, default `.uploads/`, outside `public/` |

Selecting on the token rather than `NODE_ENV` means `vercel dev` and preview deployments use the same
storage as production, while a plain `next dev` works with nothing configured.

Documents are private under both. A Blob URL is not a way in: reads go through
`GET /api/documents/{id}`, which authenticates and checks the tenant first. The Blob adapter passes
`DOCUMENTS_BLOB_READ_WRITE_TOKEN` explicitly on every call rather than relying on the SDK's default
`BLOB_READ_WRITE_TOKEN` var — that default now names the *other* store (see below), so document
operations would silently land in the wrong store if this were left implicit.

`put()` returns the handle to read back with, which is **not** necessarily the key it was given —
Blob returns a URL. `DocumentService` persists what the adapter returns, so a different adapter can
key storage however it likes. `tests/integration/documents.test.ts` covers that round trip.

### Institution media — the public path

Logo, cover and gallery images are the one exception to "storage is always private": a third-party
school website hot-links these directly, so they need URLs that load with no authentication. The
adapter interface gains `putPublic()`/`deletePublic()` for exactly this, and only
`InstitutionService` calls them — `DocumentService` (admission documents) never does.

- **Vercel Blob:** `putPublic()` stores with `access: "public"` and returns a CDN URL. This uses the
  SDK's default `BLOB_READ_WRITE_TOKEN` var, bound to a store provisioned in **public-access** mode —
  a *different* store, and a *different* env var, from the one backing admission documents
  (`DOCUMENTS_BLOB_READ_WRITE_TOKEN`, above). A store's access mode is fixed at creation and Vercel
  provides no way to change it afterward, and a store can serve only one access mode — so this has to
  be two stores, not one store with two write paths. Kept on separate tokens for a second reason
  beyond the access-mode requirement: it also means a bug in the public media path can only ever
  reach the public store, never the one holding admission documents.
- **Local disk:** `putPublic()` writes under a *separate* public root
  (`PUBLIC_UPLOAD_DIR`, default `.uploads-public/`) served by the unauthenticated
  `/api/media/[...key]` route — a distinct directory so a bug in the private path's key-escape
  check could never expose a document through the public route.

**Provisioning both stores** (`vercel blob create-store <name> --access <public|private>`, then bind
each store's token to the project under its own var name — the CLI's own `create-store` auto-connect
only offers the fixed name `BLOB_READ_WRITE_TOKEN`, so the second store's token needs an explicit
`vercel env add` under a name of your choosing, matching whatever this deployment's code reads for
that store). The local-disk adapter (plain `next dev`, neither token set) is unaffected either way.

Egress for institution media scales with **website visitor traffic** rather than admission volume —
see [`docs/architecture/institution-master-identity.md`](docs/architecture/institution-master-identity.md#5-storage-split--public-vs-private-media)
for the cost note.

---

## Deliberately not built

Designed for, but out of scope for this version: application fees and payment gateways, document
verification, seat allocation, student onboarding, SMS/WhatsApp/email notifications, an applicant or
parent portal, admission receipts, webhooks and analytics.

The pieces those will need — a service layer, an activity trail, a document model, versioned APIs and
scoped API clients — are already in place.

---

## Notes for production

- Set a strong `AUTH_SECRET` and keep it stable. Rotating it signs everyone out and invalidates every
  issued API secret.
- Replace the local storage adapter with object storage.
- Add a unique index review pass and consider a compound text index if enquiry volume grows past what
  regex search handles comfortably.
- Mongoose caches compiled models on the global object, so **schema changes need a dev-server restart**
  to take effect.
- After the application deploys, and before or alongside seeding, run the slug backfill once against
  production data:

  ```bash
  npm run backfill:slugs -- --apply
  ```

  This gives every pre-existing institution a `slug` (institutions created from now on already get
  one at creation). It is idempotent — it only writes where `slug` is absent, so re-running it is
  safe and a second run reports `0 institution(s) without a slug`. Run it without `--apply` first for
  a dry-run report of what it would set. Every pre-existing institution's `profileStatus` stays
  `DRAFT` until its own admin publishes — the public profile API will correctly 404 for all of them
  immediately after this step, which is expected, not a bug.
- Ensure both Blob stores are provisioned before institution admins try to upload documents or
  institution media — a public-access store bound to `BLOB_READ_WRITE_TOKEN` and a private-access
  store bound to `DOCUMENTS_BLOB_READ_WRITE_TOKEN` — see
  [Institution media — the public path](#institution-media--the-public-path) above.
