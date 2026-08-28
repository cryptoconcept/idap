# eduFleet Exchange — Partner Vehicle-Listing API Map

**Date: 2026-08-28.** Companion to `docs/integrations/edufleet-api-map.md`,
which covers the credential model and the teacher-job endpoints. That document
is **not modified by this one**; where the two disagree, the corrections are
listed in §9 below.

Scope of this recon: the three partner endpoints eduFleet shipped for
marketplace listings — `POST` and `GET /api/partner/school/listings` and
`PATCH /api/partner/school/listings/{id}` — plus the `MarketplaceListing`
model, its moderation lifecycle, and whether IDAP has anything to push
through them.

Source of truth: `/Users/automicai/edufleet-exchange` (read-only for this
recon — nothing in that repo was modified, no dev server was started, no
database was written). Paths prefixed `web/src/` are eduFleet's; paths
prefixed `src/` are IDAP's, in `/Users/automicai/AEMPlatform`.

---

## 0. The operative question: does IDAP have anything to push?

**No. Not one field of a vehicle listing has a source in IDAP today.**

IDAP has 23 Mongoose models (`src/models/`). None is a vehicle, asset,
inventory, equipment, marketplace, listing, or sale domain. A
case-insensitive repo-wide search for
`vehicle|odometer|seatingCapacity|minibus|transmission|fuelType|modelYear|registrationNumber`
across `src/`, `tests/` and `scripts/` returns exactly **one** production
line, and it is a comment stating the absence:

> `src/lib/connectors/edufleet.ts:110` — *"`listings:write` belongs to
> eduFleet's vehicle API, which IDAP has no surface for."*

The words "asset" and "listing" do occur in `src/`, and all occurrences are
unrelated: `asset` is Achievement's photo/certificate upload kind
(`src/services/achievement.service.ts:130`,
`AchievementAssetKind = "PHOTO" | "CERTIFICATE"`), and `listing` appears only
in prose comments meaning *a remote public profile page*
(`src/lib/connectors/passpercent.ts:362`,
`src/lib/media/feesbasket-mapping.ts:19,88,93,132`). There is no `Vehicle`,
`Listing`, `Asset`, `Inventory`, `Equipment`, or `Product` model anywhere.
There is no `migrations/`, `schemas/`, or `prisma/` directory; schema lives
solely in `src/models/`.

The only number in IDAP that resembles a price is tuition —
`src/models/FeeStructure.ts` and `src/models/Offer.ts:35` (`kind`
`PERCENTAGE`/`FLAT`, `value`) — which prices what a *student pays*, never a
good a school *sells*.

### 0.1 Field-by-field, against `SchoolListingInput`

`SchoolListingInput` is defined at
`web/src/lib/services/partner-school-listings.ts:26-36`.

| eduFleet listing field | Required | Source in IDAP today? |
|---|---|---|
| `externalListingId` | yes | **No** — there is no listing record to assign a stable id to |
| `listingType` | yes | **No** |
| `category` | yes | **No** |
| `title` | yes | **No** — `title` exists on Vacancy/Achievement/Offer, for other domains |
| `description` | yes | **No** |
| `price` | yes | **No** — `FeeStructure`/`Offer` price tuition, not goods |
| `condition` | yes | **No** — no condition/grade concept exists |
| `photos[]` | no | **Pattern only** — `Achievement.ts:34` `photos: [String]` is the closest structural analogue, and its upload plumbing (`src/app/api/settings/achievements/[achievementId]/assets/route.ts`, served via `src/app/api/media/[...key]/route.ts`) could be copied. Nothing is reusable as data. |
| `vehicle.registrationNumber` | yes for vehicles | **No** |
| `vehicle.modelYear` | yes for vehicles | **No** |
| `vehicle.seatingCapacity` | yes for vehicles | **No** |

What *does* exist is institution-level, not per-item, and eduFleet's listing
shape has nowhere to put most of it anyway (§7): city
(`src/models/Institution.ts:137`), district/taluk/state
(`Institution.ts:163-168`), geo (`Institution.ts:24-31,169`), phone
(`Institution.ts:141`), and `media[]` (`Institution.ts:119-129,177`, kinds
`["IMAGE","VIDEO","BROCHURE","PROSPECTUS"]` at `src/lib/constants.ts:155` —
no listing-photo kind).

### 0.2 What building this would actually cost

This is **not a connector task**. It is a new IDAP domain plus a connector,
and the two halves are wildly different in size.

**Half one — the IDAP domain (the large half).** The Vacancy domain is the
right baseline, because it is the most recent green-field domain built for
exactly this purpose:

| Vacancy file | lines |
|---|---|
| `src/models/Vacancy.ts` | 25 |
| `src/lib/validation/vacancy.ts` | 85 |
| `src/services/vacancy.service.ts` | 271 |
| `src/app/api/settings/vacancies/route.ts` | 51 |
| `src/app/api/settings/vacancies/[vacancyId]/route.ts` | 58 |
| `src/components/profile/sections/vacancies-section.tsx` | 763 |
| **production subtotal** | **1,253** |
| `tests/unit/vacancy-model.test.ts` | 46 |
| `tests/unit/vacancy-validation.test.ts` | 185 |
| `tests/integration/vacancy-service.test.ts` | 714 |
| `tests/integration/vacancy-routes.test.ts` | 585 |
| **test subtotal** | **1,530** |
| **total** | **2,783** |

Plus edits to shared files: ~50 lines of enums in `src/lib/constants.ts`
(the vacancy block is `constants.ts:567-616`), one export line in
`src/models/index.ts:23`, and three lines in
`src/components/profile/profile-editor.tsx` (`:39`, `:57`, `:274`).

**2,783 lines is a floor, not an estimate**, for three reasons:

1. Vacancy has **no page of its own** — it is a tab inside the profile
   editor (`profile-editor.tsx:57`). A vehicle listing, with photos and a
   moderation status coming back from a remote platform, would want a real
   page.
2. Vacancy has **no media**. Vehicle listings need per-record photo upload
   and serving; that is additional routes modelled on
   `src/app/api/settings/achievements/[achievementId]/assets/route.ts`.
3. Vacancy has **no outbound sync yet** — `src/lib/connectors/edufleet.ts:453-459`
   is still a placeholder returning `{ step: "vacancies", ok: false, detail:
   "eduFleet vacancy push is not implemented yet" }`. So those 2,783 lines
   bought the CRUD half only.

Realistic range for the IDAP half: **3,000–4,000 lines across ~10 new files**,
several weeks of work, including a moderation-status field IDAP does not
currently model for anything.

**Half two — the connector (the small half).** Three endpoints, no
pagination, one mapping function, one status reconciliation. The whole
eduFleet adapter is 473 lines today (`src/lib/connectors/edufleet.ts`) and
covers a four-step consent chain. A listings push is roughly **150–250 lines
plus tests**, and it also needs `SyncSourceData` extended
(`src/lib/connectors/types.ts:80-84` currently carries only `institution`,
`results`, and `readPublicMedia` — no vacancies, no listings) and the
assembly site at `src/services/connection.service.ts:612-616` updated.

**Ratio: the connector is roughly 5–8% of the work.** Anyone framing this as
"we already have the eduFleet connector, we just add listings" has the cost
model backwards.

### 0.3 The re-consent cost nobody has priced

Even with the domain built, IDAP cannot call these endpoints with the grants
it holds. Two independent blockers:

1. `src/lib/connectors/edufleet.ts:116` — `const REQUESTED_SCOPES =
   ["jobs:write"] as const;`. IDAP does not ask for `listings:write`.
2. `web/src/models/Partner.ts:20` — `allowedScopes` defaults to
   `["jobs:write"]`, and `openConnectionRequest` rejects any requested scope
   outside that ceiling (`web/src/lib/services/partner-connections.ts:111-113`).
   An eduFleet **admin** must widen IDAP's `allowedScopes` first
   (`web/src/lib/services/partner-registry.ts:129-144`).

And critically: a grant's scopes are fixed at mint time. The only way an
existing grant gains `listings:write` is to run the **entire four-step
consent chain again** for that school — request, admin match, school
confirm, redeem — after which `web/src/lib/services/partner-connections.ts:462-464`
unions the new scope with the old grant's scopes and revokes the old grant
(`:479-482`). **Every already-connected school must re-consent, individually.**
That is an operational cost, not an engineering one, and it lands on schools.

---

## 1. The three endpoints, exactly

All three are **Contract Two** (per-school grant) only. There is no
platform-key path to listings — `web/src/lib/partner-contract.ts:152-158`
declares only the grant security scheme on both paths.

Common auth for all three (`web/src/lib/partner-auth.ts:114-147`):

- Credential: a **grant token**, prefix `ef_pgrant_`
  (`GRANT_TOKEN_PREFIX`), sent as `Authorization: Bearer <token>` or
  `x-api-key: <token>` (`readBearer`, `partner-auth.ts:53-62`).
- Required scope: **`listings:write`** — `route.ts:9`, `[id]/route.ts:9`.
  A grant holding only `jobs:write` gets `403 insufficient_scope`
  (`partner-auth.ts:135-137`).
- The school is resolved from the grant, never from the request body
  (`partner-auth.ts:138`). The school must be non-suspended and
  `verificationStatus === "approved"`, else `403 school_unavailable`
  (`partner-auth.ts:139-141`).
- Per-minute rate limit is applied to **all three**, including the GET
  (`partner-auth.ts:142-144`).

### 1.1 `POST /api/partner/school/listings`

`web/src/app/api/partner/school/listings/route.ts:8-46`.

Request body (`SchoolListingInput`,
`web/src/lib/services/partner-school-listings.ts:26-36`):

```jsonc
{
  "externalListingId": "IDAP-VEH-1",   // required, trimmed, non-empty
  "listingType": "vehicle",            // required: "vehicle" | "asset"
  "category": "bus",                   // required, must match listingType (§2.3)
  "title": "School bus, 40-seater",    // required
  "description": "Well maintained.",   // required
  "price": 500000,                     // required, rupees, >= 0
  "condition": "good",                 // required: "excellent"|"good"|"fair"
  "photos": ["https://…/bus1.jpg"],    // optional, string[] of URLs
  "vehicle": {                         // required when listingType === "vehicle"
    "registrationNumber": "KA09AB1234",
    "modelYear": 2018,
    "seatingCapacity": 40
  }
}
```

`status` is **not accepted on POST**. Every listing is created `pending`,
hard-coded at `web/src/lib/services/listings.ts:71`.

Success — **201**, body at `route.ts:26-33`:

```json
{ "listingId": "<eduFleet ObjectId>", "externalListingId": "IDAP-VEH-1", "status": "pending" }
```

`revalidatePublicListings()` fires after a successful create
(`route.ts:25`, `web/src/lib/revalidate.ts:26-29`).

| Status | `reason` | Trigger | Citation |
|---|---|---|---|
| 201 | — | Created, always `pending` | `route.ts:32` |
| 400 | `validation_failed` | Body is not valid JSON | `route.ts:15-17` |
| 400 | `validation_failed` | Service-layer refusal (`ValidationError`) — reported as one `details` entry with `field: "body"` | `route.ts:38` |
| 400 | `validation_failed` | Mongoose schema failure — one `details` entry **per offending path** | `route.ts:42-43`, `partner-auth.ts:46-51` |
| 401 | — | Missing token (body carries `hint`) | `partner-auth.ts:116` |
| 401 | — | Wrong prefix, or unknown hash | `partner-auth.ts:117,120` |
| 401 | `revoked` | Grant revoked — the school disconnected | `partner-auth.ts:121` |
| 401 | `partner_revoked` / `partner_inactive` | Partner-level state | `partner-auth.ts:88-89` |
| 403 | `insufficient_scope` | Grant lacks `listings:write` | `partner-auth.ts:135-137` |
| 403 | `school_unavailable` | School suspended or not approved | `partner-auth.ts:139-141` |
| 409 | `duplicate_external_listing` | `externalListingId` already used by this partner; body carries `listingId` | `partner-school-listings.ts:118-125`, `140-161`; `route.ts:36` |
| 429 | `rate_limited` | >60 requests in the current minute | `partner-auth.ts:142-144` |
| 429 | `write_cap_exceeded` | Daily write cap spent; body carries `dailyWriteCap` | `partner-auth.ts:161-163` |
| 429 | `rate_limited` | Write-budget CAS contention ("Write budget contended, retry") | `partner-auth.ts:179-183` |

**Ordering trap — a rejected POST still burns a write unit.** `spendWrite`
runs at `route.ts:19-20`, *before* `postSchoolListing` at `route.ts:24`. Every
400 and every 409 therefore consumes one of the grant's 100 daily writes. A
connector retrying a malformed payload will exhaust the cap without creating
anything.

### 1.2 `GET /api/partner/school/listings`

`route.ts:49-54`. Same scope. **No `spendWrite`** — reads do not consume the
daily budget, though they do count against the per-minute limiter and
increment `requestCount` (`partner-auth.ts:145`).

Response — **200**, `{ "listings": PartnerListingSummary[] }`, shape at
`partner-school-listings.ts:45-52`, built at `:200-207`:

```jsonc
{
  "listingId": "…",
  "externalListingId": "IDAP-VEH-1",  // "" if the field is somehow absent (:202)
  "title": "School bus, 40-seater",
  "status": "pending",                 // pending|approved|rejected|sold
  "rejectionReason": "…",              // present only when the admin rejected it (:205)
  "publicUrl": "https://…/marketplace/bus/<id>"  // ONLY when status === "approved" (:206)
}
```

Filtered to `{ schoolId, partnerId }` — this partner's own pushes for this
school only, never the school's self-posted listings
(`partner-school-listings.ts:197`).

**Hard limit of 200 rows, sorted `createdAt: -1`, with no pagination and no
cursor** (`:198-199`). A partner past 200 listings for one school silently
loses visibility of the oldest ones. There is no `?page`, `?limit`, or
`?since` parameter anywhere in the route.

### 1.3 `PATCH /api/partner/school/listings/{id}`

`web/src/app/api/partner/school/listings/[id]/route.ts:8-41`.

**`{id}` is the `externalListingId`, not eduFleet's `listingId`.** The route
param is named `id` but is destructured as `externalListingId`
(`[id]/route.ts:11`) and passed straight to `markSchoolListingSold`
(`:28`), which looks it up as `partnerExternalListingId`
(`partner-school-listings.ts:175`). The spec confirms it — the request URL is
`.../api/partner/school/listings/IDAP-VEH-1`
(`[id]/route.spec.ts:53,60`). Note the OpenAPI document names this parameter
only as `id` (`partner-contract.ts:157`), which is how it could be misread.

Request body — the only accepted value in the entire endpoint:

```json
{ "status": "sold" }
```

Anything else is `400` with `field: "status"` and the offending value echoed
in `got` (`[id]/route.ts:19-21`).

Success — **200**: `{ "listingId": "…", "status": "sold" }` (`:30`).

| Status | `reason` | Trigger | Citation |
|---|---|---|---|
| 200 | — | Approved listing marked sold | `[id]/route.ts:30` |
| 400 | `validation_failed` | Body not valid JSON | `[id]/route.ts:16-17` |
| 400 | `validation_failed` | `status` is anything but `"sold"` | `[id]/route.ts:19-21` |
| 400 | `validation_failed` | Stored document fails validation on re-save | `[id]/route.ts:37-38` |
| 401 / 403 | as §1.1 | Same auth chain | `partner-auth.ts:114-147` |
| 404 | `not_found` | No listing with that `externalListingId` for this partner **and** this school | `partner-school-listings.ts:177` |
| 409 | `listing_not_approved` | Listing is `pending`, `rejected`, or already `sold` | `partner-school-listings.ts:182-189` |
| 429 | `rate_limited` / `write_cap_exceeded` | As §1.1 | `partner-auth.ts:142-183` |

**Second ordering trap, and it is asymmetric to POST.** The
`status !== "sold"` check runs *before* `spendWrite` (`:19-21` vs `:23`), so
a malformed body costs nothing — but `404 not_found` and `409
listing_not_approved` both fire *after* `spendWrite` and therefore **do**
burn a write unit. A connector that polls PATCH waiting for approval will
drain the daily cap on 409s.

### 1.4 Bonus surface: `GET /api/partner/school`

Not in the brief, but it is a fourth way to read listings. The school
snapshot route accepts a grant holding **either** scope and appends a
`listings` array — the same `listSchoolListings` output — when the grant
holds `listings:write` (`web/src/app/api/partner/school/route.ts:9,18-20`).
Same 200-row cap applies.

---

## 2. `MarketplaceListing` — every field and every rule

Model: `web/src/models/MarketplaceListing.ts`.

### 2.1 Fields

| Field | Type | Required | Partner-settable | Citation |
|---|---|---|---|---|
| `schoolId` | ObjectId → School, indexed | yes | **No** — derived from the grant | `:8` |
| `listingType` | String enum, indexed | yes | yes | `:9` |
| `category` | String enum | yes | yes | `:10-14` |
| `title` | String, trimmed | yes | yes | `:15` |
| `description` | String | yes | yes | `:16` |
| `price` | Number, `min: 0` | yes | yes | `:17` |
| `condition` | String enum | yes | yes | `:18` |
| `photos` | `[String]`, `default: []` | no | yes | `:19` |
| `vehicle.registrationNumber` | String, trimmed, **uppercased** | yes¹ | yes | `:23` |
| `vehicle.modelYear` | Number, `min: 1980` | yes¹ | yes | `:24` |
| `vehicle.seatingCapacity` | Number, `min: 1` | yes¹ | yes | `:25` |
| `status` | String enum, `default: "pending"`, indexed | — | **No** — hard-coded `"pending"` on create | `:33-38`, `listings.ts:71` |
| `rejectionReason` | String | no | **No** — admin-set only | `:39`, `listings.ts:122` |
| `partnerId` | ObjectId → Partner, indexed | no | **No** — set from the grant | `:44`, `partner-school-listings.ts:138` |
| `partnerExternalListingId` | String, trimmed | no | Indirectly, via `externalListingId` | `:45`, `partner-school-listings.ts:139` |
| `createdAt` / `updatedAt` | Date | auto | no | `:47` (`{ timestamps: true }`) |

¹ The `vehicle` subdocument is conditionally required: the schema's
`required` is a function returning `this.listingType === "vehicle"`
(`:29-31`). Inside it, all three fields are unconditionally required
(`:23-25`).

**There is no `maxlength` on `title` or `description`, and no upper bound on
`price`.** `price` is a bare `Number` with `min: 0` — no currency field
exists anywhere on the model.

### 2.2 Enums, verbatim

```
VEHICLE_CATEGORIES = ["bus", "van", "minibus"]                                  MarketplaceListing.ts:3
ASSET_CATEGORIES   = ["furniture", "lab", "computers", "sports", "other"]       MarketplaceListing.ts:4
listingType        = ["vehicle", "asset"]                                       MarketplaceListing.ts:9
category           = [...VEHICLE_CATEGORIES, ...ASSET_CATEGORIES]               MarketplaceListing.ts:12
condition          = ["excellent", "good", "fair"]                              MarketplaceListing.ts:18
status             = ["pending", "approved", "rejected", "sold"]                MarketplaceListing.ts:35
PARTNER_SCOPES     = ["jobs:write", "listings:write"]                           Partner.ts:5
```

The published contract mirrors these at `partner-contract.ts:30-33` and pins
them in `partner-contract.spec.ts:69-72`.

Note the `category` enum is a **flat union of both sets** (`:12`) — the schema
alone cannot tell that `"furniture"` is meaningless on a vehicle. That is
what §2.3's cross-check exists for.

### 2.3 The three service-layer validators

All in `web/src/lib/services/partner-school-listings.ts`, and all run
**before** anything reaches Mongoose.

**`assertValidNumbers(price, vehicle)` — `:54-60`.** Throws `ValidationError`
(→ 400) on:
- `price < 0` → *"price cannot be negative"* (`:55`)
- `vehicle.modelYear < 1980` → *"vehicle.modelYear must be 1980 or later"* (`:57`)
- `vehicle.seatingCapacity < 1` → *"vehicle.seatingCapacity must be at least 1"* (`:58`)

These duplicate the schema's `min` constraints deliberately, so the message
is the service's own rather than Mongoose's. It does **not** check that
`price`, `modelYear` or `seatingCapacity` are numbers at all — a string price
falls through to Mongoose's cast error and still surfaces as a 400
(`route.spec.ts:88-95`). It does **not** bound `modelYear` from above: a
`modelYear` of 2999 is accepted. Verified by `partner-school-listings.spec.ts:79-92`.

**`assertCategoryMatchesType(listingType, category)` — `:69-77`.** Rejects any
category not in the set matching the declared type, with the message
`category "X" is not valid for listingType "Y" — expected one of: …`
(`:73-75`). Its stated purpose (`:62-68`) is a security check, not tidiness:
an asset category smuggled in under `listingType: "vehicle"` would otherwise
sail past the Phase-2 asset gate, which keys off `listingType` only. Both
directions are pinned — `furniture` on a vehicle and `bus` on an asset
(`partner-school-listings.spec.ts:101-116`).

**`normalizedPhotos(photos?)` — `:86-93`.** Maps every entry through
`safeHttpUrl` (`web/src/lib/site.ts:11-19`) and throws
`photos contains an invalid URL: "X"` on any null result (`:90`).
`safeHttpUrl` is a **normalizer, not a predicate** (`:79-85`):
- `https://example.com/x.jpg` → unchanged (`site.ts:14`)
- `example.com/x.jpg` → **rewritten to** `https://example.com/x.jpg` (`site.ts:18`)
- `javascript:alert(1)`, `data:…`, or any other scheme → `null` → 400 (`site.ts:17`)
- empty/whitespace string → `null` → 400 (`site.ts:13`)

The **normalized** value is what gets stored, not the partner's raw string —
pinned at `partner-school-listings.spec.ts:134-142`. The `javascript:`
rejection is pinned at `:94-99`.

### 2.4 Rules inherited from `createListing`

`postSchoolListing` deliberately calls the same `createListing` the school's
own dashboard form calls, with the school's own `userId`
(`partner-school-listings.ts:95-102,127-136`), so three more rules apply
identically:

- **`requireApprovedSchool`** (`web/src/lib/authz.ts:50-64`) — the school's
  linked user must have `role === "school"` and the school must have
  `verificationStatus === "approved"`. This is a second, independent check on
  top of `partner-auth.ts:139-141`.
- **The Phase-2 asset gate** (`web/src/lib/services/listings.ts:34-36,49-51`) —
  `listingType: "asset"` is rejected with *"Used-asset listings arrive in
  Phase 2 — vehicles only for now"* unless `process.env.PHASE2_ASSETS ===
  "true"`. Pinned both ways at `partner-school-listings.spec.ts:118-132`
  (on) and `:144-152` (off). **The flag is not set in eduFleet's repo**, so
  today only `bus`, `van`, and `minibus` are pushable.
- **The vehicle triple** (`listings.ts:52-59`) — a vehicle listing missing
  any of `registrationNumber` / `modelYear` / `seatingCapacity` is refused
  before the document is built.

### 2.5 The one rule the model does not enforce

`externalListingId` is required by the service (`:108-109`, *"externalListingId
is required"*), **not** by the schema — `partnerExternalListingId` is optional
at `MarketplaceListing.ts:45`. A listing can legitimately exist with no
external id (every school-posted one does).

---

## 3. The moderation lifecycle

```
                  (partner POST or school form)
                              │
                              ▼
                          pending ───────────► rejected   (admin, reason required)
                              │                    │
                    admin approve                  │  admin approve
                              ▼                    ▼
                          approved ◄───────────────┘
                              │
                  partner PATCH  /  school "Mark sold"
                              ▼
                            sold ──────► (admin approve/reject: see §3.3)
```

### 3.1 What a partner can do at each state

| State | POST | GET | PATCH `{status:"sold"}` | Edit any field | Delete |
|---|---|---|---|---|---|
| — (create) | 201, always `pending` | — | — | — | — |
| `pending` | 409 on the same external id | visible, no `publicUrl` | **409 `listing_not_approved`** | **impossible** | **impossible** |
| `approved` | 409 | visible, `publicUrl` present | **200 → `sold`** | **impossible** | **impossible** |
| `rejected` | 409 | visible with `rejectionReason` | **409 `listing_not_approved`** | **impossible** | **impossible** |
| `sold` | 409 | visible, no `publicUrl` | **409 `listing_not_approved`** | **impossible** | **impossible** |

The `pending` and `rejected` refusals are pinned at
`partner-school-listings.spec.ts:178-198` and
`[id]/route.spec.ts:73-81`. The rationale is explicit at
`partner-school-listings.ts:178-181`: the school's own dashboard only offers
"Mark sold" on an approved listing (`web/src/app/school/page.tsx:503-509`), so
the delegated API must not exceed it.

**There is no edit path and no delete path anywhere in eduFleet** — not for
the partner, not for the school, not for an admin.
`web/src/lib/services/listings.ts` exposes exactly five functions:
`createListing` (`:43`), `listPendingListings` (`:75`), `approveListing`
(`:80`), `rejectListing` (`:110`), `markSold` (`:144`). No `updateListing`,
no `deleteListing`. The school's Server Actions confirm it —
`web/src/lib/actions.ts:13` imports only those, and `:388`, `:415`, `:434`
are the only listing actions.

### 3.2 What is irreversible, from the partner's side

**Everything except the pending→approved→sold happy path.**

- **A rejected listing is a dead end.** The partner cannot fix and resubmit
  it — there is no edit, and re-POSTing the same `externalListingId` returns
  409 (`partner-school-listings.ts:118-125`). The *only* recourse is to POST
  a **new** listing under a **new** `externalListingId`, because the old one
  is permanently burned by the unique index. The rejection reason is
  readable via GET (`:205`), so a connector can at least surface it. **This is
  the single most important operational consequence for a connector design:
  IDAP would need to model "this listing was rejected, mint a fresh external
  id" rather than "retry the push".**
- **`sold` is terminal for the partner.** No endpoint moves a listing out of
  `sold`; PATCH only accepts `"sold"` and only from `approved`.
- **A partner cannot un-publish.** With no delete and no status other than
  `sold`, the only way a partner takes a listing off the public marketplace
  is to mark it sold — which is a factual claim about a transaction, not a
  withdrawal. There is no "withdrawn" or "expired" state in the enum.

### 3.3 What an admin can do, and the gap in it

`approveListing` (`listings.ts:80-108`) and `rejectListing` (`:110-141`)
have **no precondition on the current status**. They set `status` and save.
So an eduFleet admin can move a listing to `approved` or `rejected` from
*any* state — including reviving a `sold` listing back to `approved`.
Rejection always requires a written reason (`:116`), approval clears any
prior `rejectionReason` (`:90`). Both write an audit record (`:92-99`,
`:124-132`) and notify the school's user (`:100-106`, `:133-139`).

**The partner is not notified of either.** `notify` targets
`listing.schoolId.userId` only. There is no webhook, no callback, and no
`?since` filter on the GET. **A connector's only way to learn that a listing
was approved or rejected is to poll `GET /api/partner/school/listings` and
diff.** At 60 req/min and no write cost for reads, polling is feasible — but
it is polling, and the 200-row cap bounds how much history a poll can see.

### 3.4 Moderation applies identically to partner and school listings

`listPendingListings` (`listings.ts:75-78`) queries `{ status: "pending" }`
with no partner filter, so partner-pushed listings sit in the same admin
queue, indistinguishable. The admin decision route treats them identically
(`actions.ts:626-628`).

---

## 4. Ownership, dedupe and attribution

### 4.1 `externalListingId` uniqueness is per-PARTNER, not per-school

This is the finding most likely to bite an IDAP implementation.

The unique index is on `{ partnerId, partnerExternalListingId }`
(`MarketplaceListing.ts:54-63`) — **`schoolId` is not part of the key.** It
is `partial`, filtered to documents where `partnerId` is an ObjectId *and*
`partnerExternalListingId` is a String, so the many school-posted listings
that carry neither are never forced into a single-null collision
(`:57-62`, pinned at `marketplace-listing-partner-fields.spec.ts:32-35`).

The service's pre-check matches the index — `{ partnerId,
partnerExternalListingId }` with **no `schoolId`**
(`partner-school-listings.ts:114-117`).

**Consequence: IDAP must make `externalListingId` unique across all of its
institutions, not per-institution.** An id like `VEH-1` reused for school A
and school B under the same partner registration collides. A safe scheme
would embed IDAP's institutionId, e.g. `IDAP-<institutionId>-VEH-<n>`.

**And the collision is undiagnosable from the second school's grant.** The
409 carries the clashing `listingId` (`:123`, `route.ts:36`), but
`markSchoolListingSold` looks up by `{ schoolId, partnerId,
partnerExternalListingId }` — schoolId **included** (`:172-176`) — so school
B's grant gets `404 not_found` if it tries to PATCH that id. The jobs API
solved exactly this by putting a `contract` field on its 409
(`partner-contract.ts:42`). **The listings 409 has no equivalent
disambiguator** — no `schoolId`, no `contract`, nothing to tell the caller
the clash came from a different school.

### 4.2 What triggers `409 duplicate_external_listing`

Two distinct paths, same response:

1. **Sequential** — the pre-check finds an existing row
   (`partner-school-listings.ts:114-125`). Pinned at
   `partner-school-listings.spec.ts:58-64`.
2. **Concurrent** — two pushes race past the pre-check and MongoDB's unique
   index rejects the second insert with error code `11000`; the service
   catches it, re-reads, and returns the same 409 with the winner's
   `listingId` (`:142-161`). Pinned at `:66-77`.

The race-loser comment (`:149-153`) is worth reading: unlike a job, a listing
that loses the race needs no compensating "close", because it stays a real,
pending, school-owned listing that an admin reviews like any other. **No
orphan risk, but also no cleanup** — the losing document is simply never
partner-attributed.

Note the 409 is thrown by the service *after* `createListing` has already
run in the concurrent path — meaning the document was created and saved
before the partner fields were attached (`:127-141`). The listing exists;
only the partner linkage failed.

### 4.3 The "attribution" fields are not attribution

`partnerId` and `partnerExternalListingId` are documented on the model as
attribution (`MarketplaceListing.ts:40-45`). In practice they serve exactly
two purposes, and neither is user-visible:

1. **Idempotency** — the unique index (§4.1).
2. **Scoping** — restricting `listSchoolListings` (`:197`) and
   `markSchoolListingSold` (`:172-176`) to this partner's own rows.

A repo-wide grep for `partnerId|partnerExternalListingId` filtered to listing
code returns hits only in the model, the partner service, the partner route,
and their specs — **zero hits in any `.tsx` file**. The public marketplace
detail page (`web/src/app/marketplace/[category]/[id]/page.tsx`), the
marketplace index (`web/src/app/marketplace/page.tsx`), the school dashboard
(`web/src/app/school/page.tsx`), and the admin queue never read either field.
**The public page shows the seller school; there is no "posted via IDAP"
badge anywhere.** If attribution matters to IDAP commercially, it does not
exist today.

The model's own comment at `MarketplaceListing.ts:42-43` says the pair is
*"the idempotency key, so a re-push updates rather than duplicates."* **That
comment is wrong.** A re-push does not update — `postSchoolListing` throws
409 (`:118-125`) and there is no update path at all. Flagged again in §9.

### 4.4 There is no claim door, and none is needed

The jobs API has a one-way claim mechanism. Listings do not:

- `claimStatus` is declared **only** on `Job` (`web/src/models/Job.ts:61`).
  `MarketplaceListing` has no `claimStatus`, no `claimToken`, no
  `hiddenPendingReview`.
- `web/src/lib/services/claims.ts` operates exclusively on
  `Job.findOne({ … origin: "aggregated" })` (`:39,63,140,167`). There is no
  listing equivalent, and no `JobClaim` analogue for listings.

**A school does not need to claim a partner-posted listing because it already
owns it outright, from the instant of creation.** `postSchoolListing` calls
`createListing(school.userId.toString(), …)` (`partner-school-listings.ts:127`),
which sets `schoolId` from the school's own verified account
(`listings.ts:47,62`). The school's dashboard queries
`MarketplaceListing.find({ schoolId: school._id })` with **no partner
filter** (`web/src/app/school/page.tsx:108`), so partner-pushed listings
appear alongside self-posted ones, indistinguishably, with the same "Mark
sold" button (`:503-509`) and the same share link (`:505`).

So the answer to "can a school take over or edit a partner-posted listing":

- **Take over — nothing to take over.** The school is already the owner; the
  partner is a delegate acting within the school's own rights
  (`partner-school-listings.ts:95-101`).
- **Edit — no.** Neither party can. There is no update path in eduFleet for
  anyone (§3.1).
- **The school can mark it sold** from its own dashboard, and can
  disconnect the grant at any time, after which the partner's token answers
  `401 revoked` (`partner-auth.ts:121`) while the listing itself remains
  live and school-owned.

---

## 5. Write caps and rate limits on this surface

Two independent layers, both in `web/src/lib/partner-auth.ts`.

**Layer 1 — per-minute burst, in-memory.** 60 requests per credential per
minute (`RATE_LIMIT_PER_MIN = 60`, `:73`), a sliding window in a
process-local `Map` keyed `grant:<grantId>` (`:74-85,142`). Exceeded →
`429 rate_limited` (`:143`). The comment at `:70-72` is explicit that this is
**best-effort burst protection only** under serverless — each instance has
its own map, so the effective ceiling is 60 × (number of warm instances).
**Applies to the GET as well as the writes.**

**Layer 2 — daily write cap, in MongoDB (the enforced one).**
`PartnerGrant.dailyWriteCap`, **default 100**, range 1–5000
(`web/src/models/PartnerGrant.ts:19`). Note this is the *grant* cap, five
times smaller than the platform-key cap of 500 on `Partner`
(`web/src/models/Partner.ts:21`) — a listings connector runs entirely on the
smaller one.

- The day bucket is **IST**, via `dayKeyIST` (`nextWriteBudget`,
  `web/src/lib/partner-token-logic.ts:38-47`); a new day resets `writesToday`
  to 1 on the first write (`:43`).
- Spending is a conditional (CAS) update whose filter includes the current
  counters *and* the credential's liveness, so a revoke landing mid-request
  still blocks the write (`partner-auth.ts:164-178`).
- Cap spent → `429 write_cap_exceeded`, body carries `dailyWriteCap`
  (`:161-163`).
- CAS lost → `429 rate_limited`, message *"Write budget contended, retry"*
  (`:179-183`). A connector must treat these two 429 reasons differently:
  one is retryable immediately, the other not until tomorrow (IST).

**What spends a unit on this surface:**

| Call | Spends? | Citation |
|---|---|---|
| `POST /api/partner/school/listings` — success **or** 400 **or** 409 | **yes** | `route.ts:19-20` runs before `route.ts:24` |
| `GET /api/partner/school/listings` | no | no `spendWrite` in `route.ts:49-54` |
| `GET /api/partner/school` | no | no `spendWrite` in `school/route.ts:8-21` |
| `PATCH` with a non-`"sold"` status | no | rejected at `[id]/route.ts:19-21`, before `:23` |
| `PATCH` returning 404 or 409 | **yes** | `[id]/route.ts:23` runs before `:28` |

**There is no plan/quota gate on listings.** The jobs surface has one — the
free plan's active-job cap, returning `403 upgrade_required`
(`partner-contract.ts:44`). `createListing` (`listings.ts:43-73`) contains no
plan check of any kind, and `upgrade_required` is unreachable from these
three routes. Listing volume is bounded only by the 100/day write cap.

---

## 6. Photos

**URLs, not uploads, not references.** `photos` is `[String]` on the model
(`MarketplaceListing.ts:19`) and `photos?: string[]` on the input
(`partner-school-listings.ts:34`). The published contract says so explicitly:
*"string[] — optional, publicly-reachable image URLs (http/https only, no
upload endpoint)"* (`partner-contract.ts:74`).

**There is no upload path for a partner.** eduFleet does have
`POST /api/upload` (`web/src/app/api/upload/route.ts`), but it is
**session-authenticated** — `auth()` with a 401 for anyone not signed in
(`:8-9`) — and it is not under `/api/partner/`. A grant token cannot reach it.
The size/MIME policy at `:18` (`validateUpload`) therefore guards only the
school's own dashboard upload, **not** partner-supplied URLs.

**Constraints that exist:**

- Scheme must be `http`/`https`, or absent — a bare domain is rewritten to
  `https://` (`site.ts:11-19`, §2.3).
- Any other scheme, or an empty string, is a 400.

**Constraints that do NOT exist — verified by reading the schema, the service
and the route:**

- **No count limit.** `photos: { type: [String], default: [] }` has no
  `validate` and no cap. 500 URLs is an accepted payload.
- **No size limit** — eduFleet never fetches the image, so it cannot know.
- **No host allowlist**, no extension check, no MIME check, no reachability
  check. Any `https://` string passes.
- **No dimension or aspect-ratio requirement.**

**Only the first 5 photos are ever displayed.** The public detail page uses
`photos[0]` as the hero and `photos.slice(0, 4)` as thumbnails
(`web/src/app/marketplace/[category]/[id]/page.tsx:32,41,45-47`). The
marketplace index and home page use `photos[0]` only
(`web/src/app/marketplace/page.tsx:89`, `web/src/app/page.tsx:161`,
`web/src/app/marketplace/[category]/page.tsx:51`). An empty `photos` array
falls back to `/assets/fleet-bus.jpg`.

See §8.1 for a rendering problem that affects every partner-supplied photo
URL.

---

## 7. What this API would constrain in IDAP's data model

If IDAP built the domain, these are the eduFleet-imposed shapes it would have
to live inside. Listed because they are cheaper to know before a design
session than after one.

**Required fields with no plausible IDAP source (all of them):** every
required field in §0.1. There is no partial mapping to start from — this is
not "we have 6 of 10 fields", it is zero of ten.

**`category` is a closed 3-value list for vehicles** — `bus`, `van`,
`minibus` (`MarketplaceListing.ts:3`). There is **no `car`, `truck`,
`tempo`, `auto`, `tractor`, or `other`** on the vehicle side. `"other"`
exists only in `ASSET_CATEGORIES` (`:4`), and putting a car under
`listingType: "asset"` is blocked twice — by `assertCategoryMatchesType`
(`partner-school-listings.ts:69-77`) and by the Phase-2 gate
(`listings.ts:49-51`). **A school selling a staff car has nowhere to put it.**
If IDAP models a general "school vehicle", it will have rows that are
structurally unpushable.

**`condition` is a 3-value optimistic scale** — `excellent`, `good`, `fair`
(`:18`). There is no `poor`, `needs repair`, `for parts`, or `scrap`. IDAP
would have to adopt this exact vocabulary or maintain a lossy mapping; a
"scrap" disposal listing has no honest value.

**The asset half is switched off.** `furniture`, `lab`, `computers`,
`sports`, `other` all 400 unless `PHASE2_ASSETS === "true"`
(`listings.ts:34-36,49-51`), and the flag is not set anywhere in eduFleet's
repo. Building IDAP support for used-asset disposal today produces a domain
with no working destination.

**The vehicle triple is mandatory and narrow.** `registrationNumber`
(uppercased, `:23`), `modelYear` (`>= 1980`, `:24`), `seatingCapacity`
(`>= 1`, `:25`). Consequences worth naming:
- IDAP would need a **vehicle registration number** per listing — data no
  IDAP model holds, and which schools may not have digitized.
- `seatingCapacity >= 1` is required even where it is meaningless (a
  goods-carrying tempo), forcing a fabricated value.
- `modelYear >= 1980` is a hard floor with no upper bound.

**Fields IDAP would be tempted to model and could not push:** make, model,
kilometers/odometer, fuel type, transmission, ownership count, insurance
validity, fitness-certificate expiry, permit type. **None of these exist on
`MarketplaceListing`.** They would have to be flattened into `description`
(free text, no `maxlength`). If IDAP designs a properly normalized vehicle
record, most of it becomes unstructured prose at the boundary.

**No per-listing location and no per-listing contact.** The model has neither.
The public page derives the seller from `schoolId` via `populate`
(`listings.ts:171,180-182`). So an IDAP listing's own location or contact
person has nowhere to go, and a multi-campus institution cannot indicate
*which* campus holds the vehicle.

**No currency, no price bounds.** `price` is a bare `Number` with `min: 0`
(`:17`), documented as rupees (`partner-contract.ts:72`). IDAP must store an
integer rupee amount; anything else is a lossy conversion at push time.

**IDAP must own a moderation-status mirror.** Because listings are
admin-moderated on eduFleet and there are no webhooks (§3.3), IDAP's model
needs its own `pending|approved|rejected|sold` field plus a
`rejectionReason`, kept fresh by polling. **IDAP models nothing like this
today** — `Vacancy.ts:14` has a purely local `status` with
`VACANCY_STATUSES` and no remote-state concept. This is genuinely new
plumbing, not a copied pattern.

**IDAP must mint globally unique external ids**, not per-institution ones
(§4.1), and must **mint a fresh one after every rejection** (§3.2), because
the rejected id is permanently burned. A naive `listingId`-as-`externalListingId`
mapping breaks on the first rejection.

---

## 8. Inferred, not verified

Everything above is read directly from source. This section is not — it is
reasoning from the code, flagged separately so it can be checked before
anyone relies on it.

### 8.1 Partner-supplied photo URLs will probably fail to render

**Evidence.** eduFleet's `web/next.config.ts` is empty — the entire file is
`const nextConfig: NextConfig = { /* config options here */ };`, with **no
`images` key and therefore no `images.remotePatterns`**. The public
marketplace pages render listing photos through `next/image`:
`web/src/app/marketplace/[category]/[id]/page.tsx:41,47`,
`web/src/app/marketplace/page.tsx:89`, `web/src/app/page.tsx:161`. eduFleet
runs Next 16.2.10 (`web/package.json`), whose own documentation states: *"To
safely allow images from remote servers, you need to define a list of
supported URL patterns in `next.config.js`"*
(`web/node_modules/next/dist/docs/01-app/01-getting-started/12-images.md:201`).

**The inference.** A partner-supplied photo URL is **always** absolute and
remote — `safeHttpUrl` guarantees it by prefixing `https://` onto anything
schemeless (`site.ts:18`). With no `remotePatterns` configured, `next/image`
should reject the hostname at render time, breaking the public listing page
for that listing.

**Why it may not have been noticed.** In dev, uploads go to
`public/uploads` and return a **relative** path (`/uploads/<name>`,
`web/src/lib/services/storage.ts:93-100`), which needs no `remotePatterns`.
Only production (Cloudinary `secure_url` at `:72`, or R2 at `:82-90`) and
partner pushes produce absolute URLs. So this looks like a **pre-existing
eduFleet production gap** that partner photos would hit 100% of the time
rather than a partner-specific bug.

**Not verified** because verifying it means running eduFleet's dev server,
which this recon is forbidden to do. **Ask eduFleet to confirm before IDAP
builds any photo-push path.** If confirmed, either eduFleet adds
`remotePatterns` for IDAP's media host, or IDAP should push no photos at all
(the field is optional and the page falls back to `/assets/fleet-bus.jpg`).

### 8.2 Polling is the only status channel — inferred completeness

I found no webhook, no callback URL field, and no notification path to a
partner: `notify` in both `approveListing` (`listings.ts:100-106`) and
`rejectListing` (`:133-139`) targets `listing.schoolId.userId`, and the
`Partner` model has no callback field. I did not exhaustively audit every
route in eduFleet for an outbound-webhook subsystem, so treat "polling is
the only option" as a strong reading rather than a proof.

### 8.3 The 200-row cap is a guess about intent

`listSchoolListings` hard-limits to 200 (`partner-school-listings.ts:199`)
with no pagination. Whether eduFleet considers 200 a real ceiling on
partner listings per school, or simply has not hit the case, is not stated
anywhere. IDAP should not design for more than 200 live listings per school
without asking.

### 8.4 Not re-verified in this pass

The existing api-map's §8 vehicle/asset detail was written before these
routes shipped. I re-derived §2 and §3 of *this* document from source, so
they supersede it. I did **not** re-verify the job-side claims in the
existing map (§1–§7 there), the connection lifecycle, or the Karnataka
reference data.

---

## 9. Corrections to documents already in the repo

Listed, not applied — `docs/integrations/edufleet-api-map.md` is deliberately
left unmodified.

1. **`edufleet-api-map.md` §0 and §8** state that vehicles have "**No — zero
   API routes of any kind**" and that `grep -rn "MarketplaceListing"
   web/src/app/api` returns nothing. Both are now false; the file's own
   inline correction block (from its line 64) already says so. §8.2's
   ownership/moderation detail was written pre-API and should be read as
   superseded by §3 and §4 here.
2. **`edufleet-api-map.md` §9** says IDAP has 22 models. It now has 23 —
   `src/models/Vacancy.ts` was added since.
3. **`docs/superpowers/specs/2026-08-28-edufleet-vacancies-design.md:46`** —
   *"Vehicles and used items. They have no partner API surface of any kind."*
   No longer true. The conclusion it supports (don't build it) still holds,
   but for the reason in §0 of this document, not that one.

### 9.1 Bugs and traps in eduFleet's own published contract

These are eduFleet's, not IDAP's, and are worth reporting upstream.

1. **`partner-contract.ts:43`, `rules.moderation`** — *"Partner listings are
   published immediately and are publicly visible. A school may claim a
   partner-pushed listing; once claimed or claim-pending, the platform key
   can no longer edit it."* This describes **jobs**, where "listing" means a
   job posting. Read as written by an integrator building against
   marketplace listings it is **exactly backwards**: partner listings are
   *not* published immediately (they start `pending`, `listings.ts:71`), and
   there is no claim mechanism for listings at all (§4.4). It directly
   contradicts `rules.listingLifecycle` two lines later (`:47`), which is
   correct.
2. **`partner-contract.ts:87`, `403 claimed`** — *"A school has claimed this
   listing; a platform key can no longer edit it."* Same wording problem;
   unreachable from any listing route.
3. **`partner-contract.ts:90`, `404 not_found`** — *"No such job or request
   for this partner."* Omits listings, though
   `partner-school-listings.ts:177` emits exactly this reason for a listing.
4. **`MarketplaceListing.ts:42-43`** — the code comment claims the partner
   field pair means *"a re-push updates rather than duplicates."* No update
   path exists; a re-push is a 409 (§4.3).
5. **`partner-contract.ts:157`** names the PATCH path parameter only as
   `id`, where it is in fact the `externalListingId` (§1.3).
6. **`rules.dedupe` (`partner-contract.ts:42`) covers `externalJobId` only.**
   The listing id-space rule — unique per *partner*, spanning all schools
   (§4.1) — is documented nowhere in the published contract.
7. **`revalidate.ts:22-25`** notes that school- and admin-driven listing
   mutations do *not* revalidate the public pages; only partner-driven ones
   do. So an admin approval may not appear on the public marketplace until
   something else triggers a revalidate. Pre-existing, acknowledged in the
   comment, and it means a partner polling for `publicUrl` may see
   `approved` before the page is actually live.

---

## 10. Verdict

**Do not build this now.**

The eduFleet side is real, complete, well-tested, and genuinely usable — three
endpoints, clear error semantics, a delegation model that is a strict subset
of the school's own rights by construction. There is nothing wrong with it.

The problem is entirely on IDAP's side: **there is no data to send.** Not
partial data, not data in the wrong shape — none. A vehicle-listing push
would require IDAP to first build a green-field domain of roughly 3,000–4,000
lines (schema, validation, service, routes, UI, tests, plus a remote-status
mirror it has never needed before), of which the connector is 5–8%. It would
then require an eduFleet admin to widen IDAP's `allowedScopes`, and **every
already-connected school to walk the four-step consent chain a second time**
to add `listings:write` to its grant.

The right sequencing question is not "should we build the listings
connector" — it is **"do IDAP's institutions actually want to sell vehicles
through IDAP at all?"** That is a product question with no engineering
answer, and it must be settled before any of the above is worth costing. If
the answer is yes, the vehicle domain is the project and the connector is a
footnote. If it is no, this document is the reason to close the thread.

Note also that `src/lib/connectors/edufleet.ts:453-459` still has the
**vacancy** push unimplemented. IDAP has both a Vacancy domain *and* a
working job API to push it to, and has not connected them yet. Finishing
that is strictly higher value than starting a domain that has neither.
