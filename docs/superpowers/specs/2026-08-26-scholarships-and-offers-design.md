# Scholarships & Offers — Design

**Status:** approved, not yet planned
**Date:** 2026-08-26
**Phase:** 8 (first of three closing the FeesBasket portal gap)

---

## 1. What this is

IDAP records what an institution *charges* (`FeeStructure`) and what it
*achieved* (`Result`). It has no way to record what it *offers* — the
scholarships and discounts that are, in practice, the deciding factor for a
family comparing two schools with similar fees.

This phase adds both:

- **Scholarships** — eligibility-based awards ("Merit Scholarship: 100% tuition
  for the top 10 ranks"). Amount is prose, because that is how institutions
  actually express them.
- **Offers** — time-bound discounts with a structured value ("15% off, book
  before 31 March"), optionally carrying a promo code.

It changes no existing behaviour and breaks no existing row.

### Why now

Two reasons converge.

The **portal gap**: mapping IDAP's dashboard nav against the FeesBasket portal
at `/Users/automicai/Projects/educonnect/src/app/portal/` leaves four genuine
absences — media (videos/brochures), scholarships, discounts/offers, and
analytics. This phase closes the two that are pure institution-owned data;
media and analytics follow as Phases 9 and 10, each with its own spec.

The **connector**: as with Result Enrichment, an adapter cannot push what IDAP
does not hold. Both FeesBasket and PassPercent surface scholarships and offers
on an institution's public listing.

### What deliberately does NOT port from FeesBasket

Three things in FeesBasket's equivalent surface are marketplace mechanics, not
institution data, and are excluded on purpose so their absence is not later
mistaken for an oversight:

1. **`OfferClaim` and `PersonalCoupon`** (`prisma/schema.prisma:225,944`) are
   keyed to a student **user account**. IDAP has no student accounts — it has
   leads and applications, neither of which is an authenticated identity. A
   claim record would have nothing to hang off. **Decision: no claim tracking.**
   An offer's `code` is published as text; IDAP never validates or counts a
   redemption. The institution honours it offline.
2. **`visibility: public | coupon_unlock | premium`** (`schema.prisma:570,932`)
   is pay-to-reveal monetization. IDAP's equivalent is the `DRAFT`/`PUBLISHED`
   gate it already uses for profiles, results and fee structures.
3. **`Offer.active`** coexists with `validFrom`/`validUntil` in FeesBasket, so
   the two can contradict each other (`active: true`, `validUntil` last year).
   IDAP's `status` already carries "is this live". **Decision: no `active`
   field**; expiry is derived at read time (§5.3).

---

## 2. Decisions

**Decision 1 — Two models, not one.** An early reading assumed scholarships and
offers were near-identical and could share a model. Reading FeesBasket's actual
schema disproved it: `Scholarship.amount` is a free-form string
(`schema.prisma:569`) because "100% tuition for ranks 1–10" is not a number,
while `Offer` carries `kind`/`value`/`code`/validity dates. One model would be
mostly-null fields on every row. They share a *pattern*, not a *shape*.

**Decision 2 — Optional academic-unit scope.** Both carry an optional
`academicUnitId`: null means institution-wide, set means one class or course,
with the label derived live from the academic tree exactly as `FeeStructure`
does (`fee-structure.service.ts:56-78`). Renaming a branch retitles every
scholarship beneath it on the next read, with no cascade.

**Decision 3 — Tenant-check the unit id on write.** Both services verify the
referenced unit belongs to the calling institution before accepting it,
mirroring `fee-structure.service.ts:227-233` — scoped `findOne`, `notFound` on
miss, never `FORBIDDEN`. This is the exact gap deliberately deferred as a
known non-fix on Result Enrichment (§13 of that spec); new code has no reason
to repeat it.

**Decision 4 — Separate pages and nav entries.** `/scholarships` and `/offers`,
two nav items, rather than one merged "Benefits" page. Matches FeesBasket's own
split and how IDAP already gives Fees and Results their own homes.

**Decision 5 — Public by default (once published).** Both are marketing content
whose entire purpose is being read. Four new credential-free routes, mirroring
the fee endpoints exactly.

---

## 3. Data model

### 3.1 Constants (`src/lib/constants.ts`)

```ts
export const SCHOLARSHIP_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type ScholarshipStatus = (typeof SCHOLARSHIP_STATUSES)[number];

export const OFFER_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_KINDS = ["PERCENTAGE", "FLAT"] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

export const OFFER_KIND_LABELS: Record<OfferKind, string> = {
  PERCENTAGE: "Percentage off",
  FLAT: "Flat amount off",
};

export const SCHOLARSHIP_MAX_PER_INSTITUTION = 40;
export const OFFER_MAX_PER_INSTITUTION = 40;
```

Status enums are declared separately per model rather than shared, matching how
`RESULT_STATUSES` and `FEE_STRUCTURE_STATUSES` already coexist as distinct
constants with identical members — each model owns its own lifecycle.

### 3.2 `src/models/Scholarship.ts`

```ts
const ScholarshipSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    criteria: { type: String, trim: true },
    /** Free-form: "Up to ₹50,000", "100% tuition". Not a number — see Decision 1. */
    amount: { type: String, trim: true },
    /** Null = institution-wide. No `ref`: nothing populates; the service queries directly. */
    academicUnitId: { type: Schema.Types.ObjectId, index: true },
    status: { type: String, enum: SCHOLARSHIP_STATUSES, default: "DRAFT" },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

ScholarshipSchema.index({ institutionId: 1, createdAt: -1 });
ScholarshipSchema.index({ institutionId: 1, status: 1 });
```

No unique index: an institution may legitimately run two scholarships with the
same name in different years, and there is no academic-year field to key on.

### 3.3 `src/models/Offer.ts`

```ts
const OfferSchema = new Schema(
  {
    institutionId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    kind: { type: String, enum: OFFER_KINDS, required: true },
    /** Percent (0-100) when kind is PERCENTAGE; rupees (>= 0) when FLAT. */
    value: { type: Number, required: true, min: 0 },
    /** Published as text. Never validated or counted — see §1. */
    code: { type: String, trim: true },
    academicUnitId: { type: Schema.Types.ObjectId, index: true },
    validFrom: { type: Date },
    validUntil: { type: Date },
    status: { type: String, enum: OFFER_STATUSES, default: "DRAFT" },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

OfferSchema.index({ institutionId: 1, createdAt: -1 });
OfferSchema.index({ institutionId: 1, status: 1, validUntil: 1 });
```

---

## 4. Validation (`src/lib/validation/scholarship.ts`, `offer.ts`)

Two modules, mirroring `validation/fee-structure.ts`'s split of
create/update/query schemas plus an `assert…Invariants` function.

### 4.1 Schemas

```ts
// scholarship.ts
export const createScholarshipSchema = z.object({
  name: requiredText("Scholarship name", 120),
  criteria: z.string().trim().max(600).optional(),
  amount: z.string().trim().max(80).optional(),
  academicUnitId: objectIdString.optional(),
});
export const updateScholarshipSchema = createScholarshipSchema.partial();
```

```ts
// offer.ts
export const createOfferSchema = z.object({
  title: requiredText("Offer title", 120),
  description: z.string().trim().max(600).optional(),
  kind: z.enum(OFFER_KINDS),
  value: z.number().min(0, "Must be 0 or more"),
  code: z.string().trim().max(40).optional(),
  academicUnitId: objectIdString.optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
});
export const updateOfferSchema = createOfferSchema.partial();
```

`status` is absent from both update schemas, so a PATCH can never smuggle a row
into `PUBLISHED` and skip the publish gate — the same Zod-strips-it mechanism
`updateFeeStructureSchema` uses. Unlike fee structures, `academicUnitId` **is**
patchable: it carries no unique key, so moving a scholarship between units is
harmless.

### 4.2 Invariants

`assertOfferInvariants(input)`:

1. `kind === "PERCENTAGE"` and `value > 100` → *"value: a percentage discount
   cannot exceed 100"*.
2. `validFrom != null && validUntil != null && validUntil < validFrom` →
   *"validUntil: the end date cannot fall before the start date"*.

Both use the `!= null` guard rather than `?? 0` truthiness — the house pattern,
and the one Result Enrichment spent eight fix-rounds establishing.

`assertScholarshipPublishable` / `assertOfferPublishable`: name/title non-empty
(already required at create, re-checked because a PATCH could blank it), and for
an offer, `value > 0` — publishing a "0% off" is meaningless.

---

## 5. Services

`src/services/scholarship.service.ts` and `offer.service.ts`, each a near-copy
of `fee-structure.service.ts`'s structure: `list`, `listPublic`, `get`,
`create`, `update`, `setStatus`, `remove`, all `institutionId`-scoped, all
`ActivityService.record`-logged, `findOwned` → `notFound` on any miss.

Activity entries use `entityType: "SCHOLARSHIP"` and `"OFFER"`. No constant or
enum change is needed for this: `Activity.entityType` is an unconstrained
`String` in the schema (`models/Activity.ts:8`) and a plain `string` in
`ActivityService.record`'s input type — verified, so that no task adds a
speculative enum that nothing enforces.

### 5.1 Label derivation

Both reuse the `withLabels` approach: one batched `AcademicUnit.find` per read,
attaching `classOrCourse` from the unit's current `pathLabel`. Rows with a null
`academicUnitId` get `classOrCourse: undefined` (institution-wide), which the
public projection drops rather than emitting as an empty string.

### 5.2 Tenant check on write

`create` and `update` both resolve a supplied `academicUnitId` through:

```ts
const unit = await AcademicUnit.findOne({ _id: unitObjectId(id), institutionId })
  .select("_id").lean();
if (!unit) throw notFound("Academic unit not found");
```

Per Decision 3. Skipped entirely when the field is absent.

### 5.3 Expiry is derived, never stored

`listPublic` for offers filters `validUntil` at query time:

```ts
{ $or: [{ validUntil: null }, { validUntil: { $gte: new Date() } }] }
```

Two clauses, not three: `{ validUntil: null }` matches an absent field **and**
an explicitly-null one, so a separate `$exists: false` clause is redundant.
Verified empirically against mongodb-memory-server while writing this spec —
a four-document fixture (missing / explicit null / future / past) returns
exactly the first three.

An offer with no `validUntil` never expires. The dashboard list shows expired
offers (the institution needs to see and re-date them); only the public view
drops them. **The projection does not re-check expiry** — unlike `PUBLISHED`,
which the projection re-checks as defence in depth — because a projection that
reads the clock cannot be tested deterministically. The query is the single
enforcement point, and it has its own test (§7).

---

## 6. Routes

### 6.1 Dashboard (INSTITUTION_ADMIN only, CSRF-guarded)

```
GET    /api/settings/scholarships            list
POST   /api/settings/scholarships            create
PATCH  /api/settings/scholarships/[id]       update
DELETE /api/settings/scholarships/[id]       remove
POST   /api/settings/scholarships/[id]/publish   { action: publish|unpublish|archive }
```

Five identical routes for `offers`. Both mirror the existing
`/api/settings/fees/*` surface, including its `publish` sub-route shape.

### 6.2 Public (credential-free, rate-limited, CORS-preflighted)

```
GET /api/public/[institutionId]/scholarships
GET /api/public/[institutionId]/offers
GET /api/public/institutions/[slug]/scholarships
GET /api/public/institutions/[slug]/offers
```

Each a near-copy of `api/public/[institutionId]/fees/route.ts`: IP-keyed rate
limit (never institution-keyed), `Cache-Control: public, max-age=300`,
`null` from the service → 404, and the same visibility gate — an institution
that is inactive or whose profile is not `PUBLISHED` 404s here too, so a
scholarship can never be reachable on an institution whose profile is not.

Added to `/api/v1/openapi.json` and `.yaml`.

---

## 7. Public projection

`src/lib/scholarship/public-projection.ts` and `src/lib/offer/public-projection.ts`,
both allow-lists in the established style — named fields only, never a spread
with deletions, each re-checking `status === "PUBLISHED"` and returning `null`
otherwise.

Exposed for a scholarship: `name`, `criteria`, `amount`, `classOrCourse`,
`publishedAt`.
Exposed for an offer: `title`, `description`, `kind`, `value`, `code`,
`classOrCourse`, `validFrom`, `validUntil`, `publishedAt`.

Never exposed by either: `_id`, `institutionId`, `academicUnitId`, `status`,
`createdAt`, `updatedAt`.

Each gets the "a new schema field is private until deliberately added here"
test that `fee-structure-projection.test.ts` already carries.

---

## 8. UI

Two dashboard pages, each following `/fees`'s three-part shape (list view,
create page, detail/edit page with status actions):

- `/scholarships` — list, `/scholarships/new`, `/scholarships/[id]`
- `/offers` — list, `/offers/new`, `/offers/[id]`

Both forms follow `fee-structure-form.tsx`'s conventions: `react-hook-form` +
`zodResolver`, Radix `Select` driven by `watch`/`setValue` (never `register`),
shared `Button`/`Input`/`Label` primitives, named enum casts on DTO string
fields (`as OfferKind`) — never `as never` on a concrete component.

The academic-unit picker offers effectively-active units only
(`flattenTree` + `inactiveIds`, as `/fees/new` does), plus an explicit
"All classes and courses" option representing null.

Nav (`src/components/dashboard/nav-config.ts`): two new `adminOnly` items,
`Scholarships` (`Award` icon) and `Offers` (`Ticket` icon), placed after
`Fees` in the second group.

---

## 9. Testing

Per model, mirroring the fee-structure suite file-for-file:

1. **Model** — defaults (`status: "DRAFT"`, no `publishedAt`), enum rejection,
   index presence.
2. **Validation** — every invariant in §4.2, each with a passing and a failing
   case; the `> 100` percentage rule; the date-order rule; the `!= null`
   guards proven not to fire on absent bounds.
3. **Service CRUD** — create/read/update/delete, tenant isolation (another
   institution's row is `NOT_FOUND`, never `FORBIDDEN`), malformed id →
   `NOT_FOUND` not a cast error, the §5.2 tenant check rejecting a foreign
   unit id.
4. **Publish lifecycle** — publish stamps `publishedAt`; republish does not
   move it; the publish gate rejects a blank name and a zero-value offer.
5. **Public projection** — allow-list holds; an unpublished row projects
   `null`; a newly-added schema field does not appear.
6. **Public route** — 404 for an unpublished institution; expired offers
   absent while unexpired ones are present (§5.3); rate-limit headers.

---

## 10. Definition of done

- Both models, both validation modules, both services, both projections.
- Ten dashboard routes, four public routes, OpenAPI updated.
- Six UI pages, two nav entries.
- Full suite green; `tsc --noEmit` clean; lint no new warnings beyond the
  seven pre-existing `react-hooks/incompatible-library` ones.
- No new field reaches any public projection without a deliberate allow-list
  entry and its own test.

---

## 11. Known limitations

1. **No claim tracking or code redemption** (§1). An offer's code is text.
2. **No per-student coupons** (§1) — requires student accounts IDAP lacks.
3. **Scholarship `amount` is unstructured**, so it cannot be summed, sorted or
   compared. Deliberate: it matches how institutions express awards, and the
   alternative (kind/value like `Offer`) cannot represent "100% tuition for
   ranks 1–10" without losing the eligibility half.
4. **No scheduled publish** — an offer with a future `validFrom` still has to
   be published by hand. `validFrom` is display metadata, not a trigger.
5. **Expired offers stay `PUBLISHED`** and simply stop appearing publicly. No
   job flips them to `ARCHIVED`; the institution sees them in the dashboard
   list and re-dates or archives them.

---

## 12. What the next phases owe this one

Phase 9 (Media — videos and brochures) and Phase 10 (Analytics) each get their
own spec. Two things this phase establishes that both should reuse rather than
reinvent:

1. The **two-model-one-phase** shape — a shared publish/projection/nav pattern
   applied to genuinely distinct models, rather than forcing one model.
2. The **tenant-check-on-write** helper for `academicUnitId` (§5.2). If a third
   consumer appears in Phase 9, extract it to `src/lib/academic/assert-owned.ts`
   rather than copying it a third time.
