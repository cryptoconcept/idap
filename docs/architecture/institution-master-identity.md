# Institution as master identity

I-DAP (Institute Digital Appearance Platform) is a headless data platform. It owns one
master record per institution and exposes it over an API; it does not render anything
itself. The institution's own website — or any other authorised consumer — reads the API
and does the presenting. This document explains how that record is shaped, guarded, and
served, and records two limitations honestly rather than papering over them.

---

## 1. Master-identity diagram

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

`Institution` (`src/models/Institution.ts`) is already the single master record in this
codebase: `institutionId` is unique, indexed, and carried by every other tenant-scoped
model — `Lead`, `Application`, `Document`, `Note`, `Activity`, `ApiClient`, `Device`,
`RefreshToken`, `RateLimit`. This phase deepens that one record; it does not create a
second institution entity, and no other model gains a duplicate copy of profile data.

**Create once, publish everywhere.** An institution enters its information into the
Profile once. The Lead Network already reads the same record for branding on the hosted
apply pages, `widget.js`, print views and PDFs. The public profile API reads it too. A
future module (results, scholarships, staff recruitment) attaches under the same
`institutionId` namespace rather than asking the school to re-enter anything.

**Layer separation.** The Institution record stores what an institution *is* — never how
that information is *presented*. No template name, no section order, no theme, no colour.
A field that would only make sense to one particular website's layout does not belong
here; that boundary is what keeps I-DAP headless instead of slowly growing into a CMS.

---

## 2. The public projection is an allow-list

`src/lib/profile/public-projection.ts`'s `toPublicProfile()` is the **only** function that
turns an Institution document into a public response. It is written as an allow-list: it
names every field that is permitted to leave. Nothing else does — no route hand-rolls its
own subset, no consumer receives a raw `.lean()` document with a few keys stripped off.

**Why an allow-list and not a deny-list.** A deny-list ("send everything except these
sensitive fields") fails safe in the wrong direction: the day a new field is added to the
schema — `academic.internalNotes`, say — a deny-list keeps serving everything it doesn't
already know to exclude, and the new field leaks publicly the moment it ships, with no
code change required to cause the leak. An allow-list fails safe in the *right* direction:
that same new field is private automatically, and stays private until someone opens
`public-projection.ts` and deliberately decides it belongs on the list. The cost is a
small amount of ongoing maintenance (every new profile field needs one line added here to
become public); the benefit is that forgetting to do that maintenance is safe by default
rather than a silent data exposure.

This is treated as the single highest-risk surface in Phase 1 and is tested accordingly
(`tests/unit/public-projection.test.ts`, `tests/integration/public-profile.test.ts`):
`active`, `profileStatus`, `publishedAt`, and internal ids never appear in a public
response under any input; a gallery item with `status: "HIDDEN"` is filtered out rather
than merely flagged; `management.headEmail`/`headPhone` stay private even though the rest
of `management` is public.

`InstitutionService.getPublicProfile()` is the only caller: it gates on
`{ active: true, profileStatus: "PUBLISHED" }` in the same query, so a draft, suspended,
archived, or deactivated institution's document is never even fetched, let alone passed to
the projection.

---

## 3. Two independent status flags

`active` and `profileStatus` govern different things and neither reads the other.

| Flag | Governs | Values | Who changes it |
| --- | --- | --- | --- |
| `active` | Login, session validity, and whether the Lead Network accepts enquiries/applications for this institution | `boolean`, default `true` | Platform admin only, via `PATCH /api/institutions/:institutionId` |
| `profileStatus` | Whether the public profile API serves this institution's data | `DRAFT` \| `PUBLISHED` \| `SUSPENDED` \| `ARCHIVED`, default `DRAFT` | Institute admin only, via `POST /api/settings/institution/publish` |

This independence is deliberate, not an oversight: replacing `active` with a publication
status field, or deriving one from the other, would have taken every pre-existing
institution offline the day this phase shipped — they all default to `profileStatus:
DRAFT`, and a rule like "profile must be published to be active" would have locked out
every school that hadn't yet touched the new profile editor.

The practical consequence: a school in `DRAFT` continues to log in, receive enquiries and
process applications exactly as before. Its public profile simply isn't there yet — the
public endpoints 404 for it, indistinguishably from a nonexistent institution — until its
own admin chooses to publish.

Both flags are combined only at the read boundary (`getPublicProfile`'s query), never
merged into a single derived field, so there is exactly one place either could go wrong
and it is covered by `tests/integration/public-profile.test.ts` ("returns 404 for a
deactivated institution even though it is published").

---

## 4. The slug contract

`slug` is a lookup key, never a primary key — every internal reference remains
`institutionId`. Its job is to let an external consumer address an institution by a
readable name (`infinity-school-of-excellence-mysore`) instead of memorising `INS0001`.

- **Stable.** Generated once, at institution creation, and never changed automatically.
  Renaming an institution does not move its slug — a consumer (a website, a bookmark, a
  search index) may already hold a URL pointing at it, and silently redirecting that would
  be a worse failure mode than an admin-triggered, deliberate slug change (not implemented
  in Phase 1; the field simply doesn't move on its own).
- **Unique, index-backed, sparse.** `InstitutionSchema.index({ slug: 1 }, { unique: true,
  sparse: true })`. Sparse matters: `slug` is not marked `required` on the schema, because
  making it required would fail every un-backfilled pre-existing record's very next save.
  The **service layer** (`claimSlug`) treats a slug as mandatory for anything created from
  now on; the **schema** tolerates its historical absence so the migration in §6 can be
  gradual rather than a hard cutover.
- **Collision handling is write-then-retry, never read-then-write.** `claimSlug()` in
  `src/services/slug.service.ts` attempts `findOneAndUpdate({ institutionId, slug: {
  $exists: false } }, { $set: { slug: candidate } })` directly. If that races against
  another writer claiming the same base name, MongoDB's unique index throws a duplicate-key
  error (code `11000`), which the function catches and retries with the next suffix
  (`-2`, `-3`, …, up to 50 attempts). A read-then-write pattern ("check if the slug is
  free, then write it") has a window between the read and the write where two concurrent
  callers can both see "free" and both write — the unique index is what actually prevents
  the collision; the retry loop is just how the code recovers from that index rejecting
  one of them. `tests/integration/slug.test.ts` proves this under real concurrency: three
  institutions claiming the identical base name in parallel each get a distinct slug.
- **Reserved words are rejected** (`api`, `admin`, `public`, `login`, `institution`,
  `institutions`, `settings`, `apply`, `widget`, `dashboard`, `profile`, `media`) so a
  slug can never collide with a route.
- **Idempotent per institution.** An institution that already has a slug keeps it — calling
  `claimSlug` again is a no-op that returns the existing value, which is what makes both
  `InstitutionService.create()` and the backfill script safe to call unconditionally.

---

## 5. Storage split — public vs private media

Documented in the design spec's §7 and implemented in `src/lib/storage`.

The existing `StorageAdapter` contract is private by design: "objects are always private,
served through an authenticated, tenant-checked route." That is correct for admission
documents and is unchanged for them. Institution media (logo, cover, gallery images) is
different in kind: a third-party school website hot-links these images directly into its
own HTML, and a `<img>` tag cannot present a bearer token. They need a second, explicitly
public path.

```ts
interface StorageAdapter {
  // existing — private, for admission documents. Unchanged.
  put(input): Promise<StoredObject>
  get(key): Promise<...>
  delete(key): Promise<void>

  // new — institution media only.
  putPublic(input): Promise<StoredObject>   // returns a directly-loadable URL
  deletePublic(key): Promise<void>
}
```

- **Vercel Blob adapter** (`src/lib/storage/blob.ts`): `put()` stores with
  `access: "private"` (unchanged), on the **documents** store
  (`DOCUMENTS_BLOB_READ_WRITE_TOKEN`, passed explicitly on every call); `putPublic()`
  stores with `access: "public"` and a random URL suffix (so one institution's media can't
  be enumerated from another's URL) and returns a CDN-served URL, on the **media** store
  (the SDK's default `BLOB_READ_WRITE_TOKEN` var). Two stores, two tokens, deliberately —
  see below.
- **Local adapter** (`src/lib/storage/local.ts`): `put()` writes under `.uploads/`, read
  only through the authenticated document route (unchanged). `putPublic()` writes under a
  *separate* root, `.uploads-public/`, served by the unauthenticated
  `/api/media/[...key]` route — a distinct directory specifically so a bug in the private
  path's key-escape check could never accidentally expose a document through the public
  route, or vice versa.

**Only institution media may call `putPublic`.** This is enforced by which service calls
which method, not by a runtime check: `DocumentService` (admission documents) never
imports or calls `putPublic`/`deletePublic`; only `InstitutionService.addMedia()` does.
`tests/unit/storage-public.test.ts` and `tests/integration/documents.test.ts` cover each
side of that boundary.

**Cost model, recorded deliberately.** Before this phase, storage egress scaled with
enquiry and application volume — a private document is read exactly as many times as an
admin opens it. After this phase, institution media egress scales with **website visitor
traffic**, because every page load of a school's site that renders its logo, cover or
gallery is an unauthenticated read against this storage. A school's admission page going
viral on results day, or simply being a popular school with a lot of daily site traffic,
now has a direct storage cost that a plan priced around admission volume did not
anticipate. This is a cost-shape change worth monitoring after rollout, not a defect.

### Two Blob stores, not one — and why

A Blob store's access mode is fixed at creation; Vercel provides no way to change an
existing store from private to public or back. `putPublic()` calling
`put(key, body, { access: "public", ... })` against a private-access store fails outright
with `Cannot use public access on a private store` — this is not a code defect against the
documented Vercel Blob API, it is what the API is supposed to do.

This project provisions two stores for exactly this reason:

| Store | Access mode | Env var | Holds |
| --- | --- | --- | --- |
| `admissions-documents` | private | `DOCUMENTS_BLOB_READ_WRITE_TOKEN` | Admission documents, read only through the authenticated route |
| `institution-media` | public | `BLOB_READ_WRITE_TOKEN` (the SDK's default) | Logo, cover, gallery — hot-linked by third-party websites |

Separate tokens, not just separate stores under one token, for a second reason beyond the
access-mode requirement: keeping them apart means a bug reachable through the public media
path can only ever touch the public store. It structurally cannot reach a document, however
that bug is shaped, because the document store's token is never in scope for that code
path. `src/lib/storage/blob.ts` passes `DOCUMENTS_BLOB_READ_WRITE_TOKEN` explicitly on every
document-store call rather than relying on the SDK's implicit default — that default now
names the *other* store, so leaving it implicit would silently misroute document operations.

Provisioning: `vercel blob create-store <name> --access <public|private>` creates a store
and attempts to auto-connect it to the project under the fixed name
`BLOB_READ_WRITE_TOKEN`; a second store needs its token added under a different name
explicitly (`vercel env add <NAME> <environment>`), since the auto-connect step cannot
target a name you choose. The local-disk adapter used in plain `next dev` is unaffected —
its "public" root is just a second directory with no access-mode concept.

---

## 6. Migration

No data migration was required to ship this phase — every new field is optional or has a
default, so the existing thirteen flat fields on `Institution` stay exactly as they were,
referenced unchanged by the PDF generator, `serializeInstitution`, `TenantInstitution` and
`getPublicBranding`.

The one thing that *is* migrated is the slug, because it did not exist before this phase
and the service layer treats it as mandatory going forward:

- `scripts/backfill-slugs.ts` finds every institution with no `slug`, derives a base from
  `institutionName` + `locality`/`city`, and calls the same `claimSlug()` the create path
  uses. It only ever writes where `slug` is currently absent, so it is safe to re-run —
  running it again after every institution already has a slug reports `0 institution(s)
  without a slug` and exits.
- It must be invoked through the `backfill:slugs` npm script, not run directly with `tsx`:

  ```bash
  npm run backfill:slugs -- --apply
  ```

  The reason is `slug.service.ts` starting with `import "server-only"`. Under Next's own
  build, the `react-server` package export condition makes that import resolve to a no-op;
  run as a bare Node/tsx script with no export condition set, the same import throws
  immediately. The npm script sets `NODE_OPTIONS=--conditions=react-server` explicitly so
  the standalone script sees the same resolution Next would give it. Omit `--apply` first
  to get a dry-run report of what would be written.
- Existing institutions get `profileStatus: DRAFT` from the schema default with no script
  needed — harmless, since `active` is untouched and login/lead-capture continue exactly
  as before. **This is intentional, not a gap to close**: every pre-existing institution
  stays in `DRAFT` until its own admin makes a deliberate decision to publish. A school
  should not go publicly live because a migration ran.

Production rollout order: deploy the application → run
`npm run backfill:slugs -- --apply` against the production database → verify the public
endpoint 404s for institutions that are still `DRAFT` (all of them, initially — that is
correct, not a bug).

---

## 7. Known limitation: clearing a text field is currently a no-op

`updateProfileSchema`'s optional text fields (`tagline`, `description`, `legalName`, every
address line, every block's optional strings, …) are all built from
`src/lib/validation/common.ts`'s `optionalText()` / `optionalUrlSchema` /
`optionalPhoneSchema` / `optionalEmailSchema` helpers. Each of those trims and normalises
its input, and — as the very last step — transforms an empty string to `undefined`:

```ts
.transform((value) => (value.length === 0 ? undefined : value))
```

`InstitutionService.updateProfile()` then builds its `$set` document by iterating the
parsed patch and skipping every key whose value is `undefined`
(`buildProfileSet()` in `src/services/institution.service.ts`). The two behaviours compose
into a real limitation: **sending an empty string for a text field does not clear it.** It
becomes `undefined` during validation, and `undefined` is then filtered out before the
database write, so the previously-stored value is left exactly as it was. There is
currently no request shape that blanks a previously-set text field — only replacing it
with a new non-empty value works.

This was not discovered and left as a surprise; it is a direct, intentional consequence of
reusing the same `optionalText`-family validators the rest of the codebase already uses
for "this field is optional, and blank input on a *create* should not become a stored
empty string." That behaviour is exactly right for create and for most partial updates. It
stops being right for the one case of "I want to explicitly remove what I typed
here" on an update — and Phase 1 does not yet distinguish those two intents.

A correct fix is a schema/service change, not a documentation-only fact: the profile patch
schema would need a way to represent "clear this field" distinctly from "field not present
in this patch" (for example, accepting `null` as an explicit clear signal, separately from
omitting the key or sending `""`), and `buildProfileSet` would need to turn that signal
into `$unset` rather than skip it. That is future work, not implemented here. Object
fields (`contact`, `geo`, `academic`, `management`, `social`) and arrays (`facilities`,
`gallery`, `social.other`) are unaffected — an array patch always replaces the whole array,
including replacing it with `[]`, and clearing an entire block is possible by omitting it
from future patches (though not by explicitly nulling it today either).
