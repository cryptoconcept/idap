# I-DAP Phase 1 — Institution Profile V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing `Institution` record into a full institutional master profile, editable by the institute admin and readable over a credential-free public API, without changing any Lead Network behaviour.

**Architecture:** I-DAP is headless. `Institution` stays the single master record — the existing thirteen fields are untouched and canonical, and new material is added as sub-documents and arrays, so no data migration is required. One allow-list projection function is the only path from a document to a public response. Institute admins own their profile; the platform admin may read it but never write it; enquiries and applications remain hard-blocked to the platform admin exactly as they are today.

**Tech Stack:** Next.js 16.3.2 App Router · React 19 · TypeScript 5 · Mongoose 8 · Zod 4 · Tailwind v4 + shadcn/ui · Vitest 3 + mongodb-memory-server · Vercel Blob

**Spec:** `docs/superpowers/specs/2026-08-23-idap-institution-profile-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Never break the Lead Network.** All 214 existing tests must pass **unmodified** at the end of every task. A test that needs editing to pass is a regression, not a stale test.
- **`institutionId` stays `INS0001`.** Format `/^INS\d{4,6}$/`. Nothing derives a new identifier format. `regionCode` is display-only; no reference number is built from it.
- **`active` and `profileStatus` are independent.** `active` governs login and lead capture. `profileStatus` governs publication. Neither reads the other.
- **`tenantFilter()` in `src/lib/tenant/index.ts` is not modified.** It throws for `SUPER_ADMIN` and must continue to.
- **Platform admin: read profiles, never write.** Enforced by a narrower Zod schema on the server, not by a UI that omits fields.
- **The public projection is an allow-list.** A field added to the schema is private until someone deliberately names it. Never a deny-list.
- **`institutionId` is never taken from a request body or query.** Derived from the session on authenticated routes; from the path on public routes, where it selects a `PUBLISHED` record only.
- **Only institution media uses the public storage path.** `DocumentService` never calls `putPublic`.
- **Monochrome design system.** Existing tokens and shadcn components only. No new visual language, no colour.
- **camelCase**, matching the codebase. The brief's `snake_case` is not adopted.
- **Product name is I-DAP** (Institute Digital Appearance Platform).
- **Restart `next dev` after any schema change.** Mongoose caches models on `globalThis` across HMR; schema edits silently do nothing until a restart. This will recur throughout this plan.
- Security tests are verified by mutation: delete the guard, confirm the test fails, restore it. A test that passes without its guard proves nothing.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/lib/profile/completion.ts` | Deterministic completion score + itemised missing list |
| `src/lib/profile/public-projection.ts` | The single allow-list document → public payload |
| `src/lib/profile/facilities.ts` | Suggested facility codes for the picker |
| `src/services/slug.service.ts` | Slug generation, collision handling, reserved words |
| `src/app/api/settings/institution/publish/route.ts` | Publish / unpublish |
| `src/app/api/settings/institution/media/route.ts` | Image upload |
| `src/app/api/settings/institution/media/[mediaId]/route.ts` | Gallery image delete |
| `src/app/api/public/[institutionId]/profile/route.ts` | Public profile by id |
| `src/app/api/public/institutions/[slug]/route.ts` | Public profile by slug |
| `src/app/api/media/[...key]/route.ts` | Local-disk public media serving (dev only) |
| `src/app/(dashboard)/profile/page.tsx` + `layout.tsx` | Profile editor shell |
| `src/components/profile/*` | Eight section forms, completion meter, publish dialog |
| `scripts/backfill-slugs.ts` | Idempotent slug backfill |
| `docs/api/institution-profile.md` | API reference |
| `docs/architecture/institution-master-identity.md` | Data model + architecture |

**Modified**

| File | Change |
|---|---|
| `src/lib/constants.ts` | +5 institution types, profile/management/gender/gallery enums |
| `src/models/Institution.ts` | New sub-documents, arrays, indexes |
| `src/lib/validation/institution.ts` | Section schemas + narrowed platform-admin schema |
| `src/lib/storage/{types,blob,local,index}.ts` | `putPublic` / `deletePublic` |
| `src/services/institution.service.ts` | Profile read/write, publish, media |
| `src/app/api/settings/institution/route.ts` | Add `GET`, widen `PATCH` |
| `src/app/api/institutions/[institutionId]/route.ts` | Profile in `GET`, narrow `PATCH` |
| `src/lib/api/openapi.ts` | Public profile endpoints, title → I-DAP API |
| `src/components/dashboard/nav-config.ts` | Institution Profile nav item, I-DAP title |
| `src/app/layout.tsx`, `src/app/(auth)/login/page.tsx`, `src/components/dashboard/sidebar.tsx` | I-DAP wordmark, `iD` mark |
| `src/app/(dashboard)/dashboard/page.tsx` | Completion + Integration cards |
| `tests/helpers/factories.ts` | Profile-shaped institution factory |

---

## Task 1: Constants and the extended Institution schema

**Files:**
- Modify: `src/lib/constants.ts`
- Modify: `src/models/Institution.ts`
- Test: `tests/unit/institution-model.test.ts` (create)

**Interfaces:**
- Produces: `PROFILE_STATUSES`, `ProfileStatus`, `MANAGEMENT_TYPES`, `ManagementType`, `GENDER_TYPES`, `GenderType`, `GALLERY_STATUSES`, `GalleryStatus`, `GALLERY_MAX_ITEMS`, and the widened `INSTITUTION_TYPES`. Every later task imports these rather than repeating literals.
- Produces: an `Institution` document shape carrying `slug`, `regionCode`, `profileStatus`, `contact`, `geo`, `academic`, `management`, `facilities[]`, `social`, `gallery[]`.

**Do NOT touch** the existing thirteen fields — `institutionId`, `institutionName`, `institutionType`, `address`, `city`, `state`, `pincode`, `contactPerson`, `phone`, `email`, `website`, `logoUrl`, `active`. They are referenced by the PDF generator, `serializeInstitution`, `TenantInstitution` and `getPublicBranding`. Leaving them alone is what makes this a zero-migration change.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/institution-model.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { Institution } from "@/models";
import { GALLERY_MAX_ITEMS, INSTITUTION_TYPES } from "@/lib/constants";

describe("Institution profile schema", () => {
  beforeAll(async () => {
    await startTestDatabase("institutionmodel");
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("defaults a new institution to an unpublished profile on a live account", async () => {
    // The two flags are independent: a school runs admissions while its
    // profile is still a draft. Conflating them would take every existing
    // institution offline on the day this ships.
    const created = await Institution.create({
      institutionId: "INS0001",
      institutionName: "Sri Vivekananda School",
      institutionType: "SCHOOL",
    });

    expect(created.profileStatus).toBe("DRAFT");
    expect(created.active).toBe(true);
    expect(created.publishedAt).toBeUndefined();
  });

  it("stores every new profile block", async () => {
    await Institution.create({
      institutionId: "INS0001",
      institutionName: "Sri Vivekananda School",
      institutionType: "SCHOOL",
      slug: "sri-vivekananda-school-hanur",
      regionCode: "KA-MYS",
      legalName: "Sri Vivekananda Education Trust",
      shortName: "SVS Hanur",
      establishedYear: 1994,
      tagline: "Learning without limits",
      description: "A co-educational school in Hanur.",
      contact: { secondaryPhone: "9876543211", whatsapp: "9876543210" },
      district: "Chamarajanagar",
      taluk: "Hanur",
      country: "India",
      geo: { latitude: 12.09, longitude: 77.05 },
      academic: {
        board: "State",
        genderType: "CO_ED",
        medium: ["English", "Kannada"],
        classesOffered: ["1", "2", "3"],
      },
      management: { managementType: "TRUST", principalName: "R. Shashidhar" },
      facilities: [{ code: "LIBRARY", label: "Library", note: "8,000 titles" }],
      social: { instagram: "https://instagram.com/svshanur" },
      gallery: [{ imageUrl: "https://cdn.test/1.jpg", title: "Campus" }],
    });

    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();

    expect(row!.slug).toBe("sri-vivekananda-school-hanur");
    expect(row!.regionCode).toBe("KA-MYS");
    expect(row!.academic!.medium).toEqual(["English", "Kannada"]);
    expect(row!.facilities![0]!.available).toBe(true); // defaults to available
    expect(row!.gallery![0]!.status).toBe("ACTIVE");
    expect(row!.gallery![0]!._id).toBeDefined(); // addressable for delete
  });

  it("accepts an institution with no slug, so un-backfilled records still save", async () => {
    // The unique index is sparse on purpose. A required slug would make every
    // existing institution fail validation the moment its admin pressed Save.
    await Institution.create({
      institutionId: "INS0001",
      institutionName: "No Slug Yet",
      institutionType: "SCHOOL",
    });
    await Institution.create({
      institutionId: "INS0002",
      institutionName: "Also No Slug",
      institutionType: "SCHOOL",
    });

    expect(await Institution.countDocuments({ slug: { $exists: false } })).toBe(2);
  });

  it("rejects a duplicate slug", async () => {
    await Institution.create({
      institutionId: "INS0001",
      institutionName: "A",
      institutionType: "SCHOOL",
      slug: "taken",
    });
    await Institution.syncIndexes();

    await expect(
      Institution.create({
        institutionId: "INS0002",
        institutionName: "B",
        institutionType: "SCHOOL",
        slug: "taken",
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("carries the five new institution types without disturbing the old seven", async () => {
    expect(INSTITUTION_TYPES).toContain("SCHOOL");
    expect(INSTITUTION_TYPES).toContain("POLYTECHNIC");
    expect(INSTITUTION_TYPES).toContain("NURSING_COLLEGE");
    expect(INSTITUTION_TYPES).toHaveLength(12);
    expect(GALLERY_MAX_ITEMS).toBe(60);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/institution-model.test.ts`
Expected: FAIL — `profileStatus`, `slug`, `academic` and the rest do not exist yet, and `INSTITUTION_TYPES` has 7 entries.

- [ ] **Step 3: Extend the constants**

Append to `src/lib/constants.ts`. Add the five new types to the **end** of `INSTITUTION_TYPES` and their labels to `INSTITUTION_TYPE_LABELS` — never rename or reorder the existing seven, because stored records hold those exact strings.

```ts
export const PROFILE_STATUSES = ["DRAFT", "PUBLISHED", "SUSPENDED", "ARCHIVED"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const PROFILE_STATUS_LABELS: Record<ProfileStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  SUSPENDED: "Suspended",
  ARCHIVED: "Archived",
};

export const MANAGEMENT_TYPES = [
  "GOVERNMENT",
  "AIDED",
  "UNAIDED",
  "PRIVATE",
  "TRUST",
  "SOCIETY",
  "MINORITY",
  "AUTONOMOUS",
  "OTHER",
] as const;
export type ManagementType = (typeof MANAGEMENT_TYPES)[number];

export const GENDER_TYPES = ["BOYS", "GIRLS", "CO_ED"] as const;
export type GenderType = (typeof GENDER_TYPES)[number];

export const GENDER_TYPE_LABELS: Record<GenderType, string> = {
  BOYS: "Boys only",
  GIRLS: "Girls only",
  CO_ED: "Co-educational",
};

export const GALLERY_STATUSES = ["ACTIVE", "HIDDEN"] as const;
export type GalleryStatus = (typeof GALLERY_STATUSES)[number];

/** A gallery, not a media platform. Enforced in the service, not only the UI. */
export const GALLERY_MAX_ITEMS = 60;
```

New entries for `INSTITUTION_TYPES`: `"B_ED_COLLEGE"`, `"NURSING_COLLEGE"`, `"POLYTECHNIC"`, `"COACHING_INSTITUTION"`, `"TRAINING_INSTITUTION"`.

New entries for `INSTITUTION_TYPE_LABELS`: `B_ED_COLLEGE: "B.Ed College"`, `NURSING_COLLEGE: "Nursing College"`, `POLYTECHNIC: "Polytechnic"`, `COACHING_INSTITUTION: "Coaching Institution"`, `TRAINING_INSTITUTION: "Training Institution"`.

- [ ] **Step 4: Extend the model**

In `src/models/Institution.ts`, define the sub-schemas above `InstitutionSchema`, then add the fields. Note `GalleryItemSchema` keeps its `_id` — the delete endpoint addresses items by it — while every other sub-schema sets `{ _id: false }`.

```ts
import {
  GALLERY_STATUSES,
  GENDER_TYPES,
  INSTITUTION_TYPES,
  MANAGEMENT_TYPES,
  PROFILE_STATUSES,
} from "@/lib/constants";

const ContactSchema = new Schema(
  {
    secondaryPhone: { type: String, trim: true },
    alternateEmail: { type: String, trim: true, lowercase: true },
    whatsapp: { type: String, trim: true },
  },
  { _id: false },
);

const GeoSchema = new Schema(
  {
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    mapUrl: { type: String, trim: true },
  },
  { _id: false },
);

const AcademicSchema = new Schema(
  {
    board: { type: String, trim: true },
    affiliation: { type: String, trim: true },
    recognition: { type: String, trim: true },
    affiliationNumber: { type: String, trim: true },
    udiseCode: { type: String, trim: true },
    medium: { type: [String], default: undefined },
    genderType: { type: String, enum: GENDER_TYPES },
    currentAcademicYear: { type: String, trim: true },
    classesOffered: { type: [String], default: undefined },
    coursesOffered: { type: [String], default: undefined },
  },
  { _id: false },
);

const ManagementSchema = new Schema(
  {
    managementType: { type: String, enum: MANAGEMENT_TYPES },
    trustName: { type: String, trim: true },
    societyName: { type: String, trim: true },
    managementName: { type: String, trim: true },
    principalName: { type: String, trim: true },
    headDesignation: { type: String, trim: true },
    headEmail: { type: String, trim: true, lowercase: true },
    headPhone: { type: String, trim: true },
  },
  { _id: false },
);

const SocialLinkSchema = new Schema(
  { label: { type: String, trim: true }, url: { type: String, trim: true } },
  { _id: false },
);

const SocialSchema = new Schema(
  {
    facebook: { type: String, trim: true },
    instagram: { type: String, trim: true },
    youtube: { type: String, trim: true },
    linkedin: { type: String, trim: true },
    x: { type: String, trim: true },
    other: { type: [SocialLinkSchema], default: undefined },
  },
  { _id: false },
);

/**
 * Free-form by design: any code with any label is storable, so a new facility
 * type never needs a schema change or a migration.
 */
const FacilitySchema = new Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    label: { type: String, required: true, trim: true },
    available: { type: Boolean, default: true },
    note: { type: String, trim: true },
  },
  { _id: false },
);

/** Keeps its _id — the media delete endpoint addresses items by it. */
const GalleryItemSchema = new Schema({
  imageUrl: { type: String, required: true, trim: true },
  title: { type: String, trim: true },
  description: { type: String, trim: true },
  sortOrder: { type: Number, default: 0 },
  status: { type: String, enum: GALLERY_STATUSES, default: "ACTIVE" },
  uploadedAt: { type: Date, default: Date.now },
});
```

Fields added inside `InstitutionSchema`, after the existing thirteen:

```ts
    // --- identity ---
    slug: { type: String, trim: true, lowercase: true },
    regionCode: { type: String, trim: true, uppercase: true },
    legalName: { type: String, trim: true },
    shortName: { type: String, trim: true },
    coverImageUrl: { type: String, trim: true },
    establishedYear: { type: Number, min: 1800, max: 2200 },
    tagline: { type: String, trim: true },
    description: { type: String, trim: true },
    profileStatus: { type: String, enum: PROFILE_STATUSES, default: "DRAFT", index: true },
    publishedAt: { type: Date },

    // --- contact (primary phone/email/website/contactPerson stay flat above) ---
    contact: { type: ContactSchema, default: undefined },

    // --- address (address/city/state/pincode stay flat above) ---
    addressLine2: { type: String, trim: true },
    locality: { type: String, trim: true },
    area: { type: String, trim: true },
    taluk: { type: String, trim: true },
    district: { type: String, trim: true, index: true },
    country: { type: String, trim: true, default: "India" },
    geo: { type: GeoSchema, default: undefined },

    // --- blocks ---
    academic: { type: AcademicSchema, default: undefined },
    management: { type: ManagementSchema, default: undefined },
    facilities: { type: [FacilitySchema], default: undefined },
    social: { type: SocialSchema, default: undefined },
    gallery: { type: [GalleryItemSchema], default: undefined },
```

Indexes, below the schema definition:

```ts
// Sparse: institutions predating the backfill legitimately have no slug.
InstitutionSchema.index({ slug: 1 }, { unique: true, sparse: true });
InstitutionSchema.index({ institutionType: 1 });
InstitutionSchema.index({ "academic.board": 1 });
InstitutionSchema.index({ city: 1 });
InstitutionSchema.index({ institutionName: "text" });
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/unit/institution-model.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, 219 total. **No existing test file may be edited.** If one fails, the schema change broke something and the schema is what changes, not the test.

- [ ] **Step 7: Commit**

```bash
git add src/lib/constants.ts src/models/Institution.ts tests/unit/institution-model.test.ts
git commit -m "feat: extend the Institution record into a full profile

The existing thirteen fields are untouched and canonical, so no data
migration is needed. Slug is sparse-unique because institutions
predating the backfill legitimately have none."
```

---

## Task 2: Slug service and backfill

**Files:**
- Create: `src/services/slug.service.ts`
- Create: `scripts/backfill-slugs.ts`
- Test: `tests/integration/slug.test.ts` (create)

**Interfaces:**
- Consumes: the `Institution` model from Task 1, including its sparse unique `slug` index.
- Produces:
  - `slugify(input: string): string`
  - `allocateSlug(input: { institutionName: string; locality?: string }): Promise<string>` — returns a slug guaranteed free at the moment of the call.
  - `claimSlug(institutionId: string, base: string): Promise<string>` — writes the slug onto the record, retrying suffixes on a duplicate-key collision. **This is the function Task 7 calls.**
  - `RESERVED_SLUGS: readonly string[]`

**How collisions are resolved.** Not with a read-then-check, which races two schools registering the same name. The unique index *is* the lock: attempt the write, catch MongoDB error `11000`, try the next suffix. Bounded at 50 attempts, then throw.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/slug.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Institution } from "@/models";
import { claimSlug, slugify, RESERVED_SLUGS } from "@/services/slug.service";

describe("slug allocation", () => {
  beforeAll(async () => {
    await startTestDatabase("slugs");
    await Institution.syncIndexes();
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("builds a readable slug from name and locality", () => {
    expect(slugify("Sri Vivekananda School, Hanur")).toBe("sri-vivekananda-school-hanur");
    expect(slugify("  St. Joseph's   PU College  ")).toBe("st-josephs-pu-college");
    expect(slugify("A&B Public School (Main)")).toBe("a-b-public-school-main");
  });

  it("claims the plain slug when it is free", async () => {
    await makeInstitution("INS0001");
    expect(await claimSlug("INS0001", "green-valley-school")).toBe("green-valley-school");
  });

  it("suffixes rather than collides when the name is taken", async () => {
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
    await claimSlug("INS0001", "green-valley-school");

    expect(await claimSlug("INS0002", "green-valley-school")).toBe("green-valley-school-2");
  });

  it("survives two institutions claiming the same base at once", async () => {
    // The unique index is the lock. A read-then-write would hand both the
    // same slug and one of the writes would fail.
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
    await makeInstitution("INS0003");

    const claimed = await Promise.all([
      claimSlug("INS0001", "shared-name"),
      claimSlug("INS0002", "shared-name"),
      claimSlug("INS0003", "shared-name"),
    ]);

    expect(new Set(claimed).size).toBe(3);
    expect(claimed).toContain("shared-name");
  });

  it("refuses a reserved word", async () => {
    await makeInstitution("INS0001");
    const claimed = await claimSlug("INS0001", "admin");
    expect(RESERVED_SLUGS).toContain("admin");
    expect(claimed).not.toBe("admin");
  });

  it("does not move an existing slug when the institution is renamed", async () => {
    // Consumers hold URLs pointing at the slug. Renaming a school must not
    // silently break every one of them.
    await makeInstitution("INS0001");
    const first = await claimSlug("INS0001", "old-name-school");
    const second = await claimSlug("INS0001", "new-name-school");

    expect(second).toBe(first);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/integration/slug.test.ts`
Expected: FAIL — `@/services/slug.service` does not exist.

- [ ] **Step 3: Implement the service**

Create `src/services/slug.service.ts`:

```ts
import "server-only";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution } from "@/models";
import { AppError } from "@/lib/api/errors";

/** Words that would collide with a route or read as a system page. */
export const RESERVED_SLUGS = [
  "api",
  "admin",
  "public",
  "login",
  "logout",
  "institution",
  "institutions",
  "settings",
  "apply",
  "widget",
  "dashboard",
  "profile",
  "media",
] as const;

const MAX_ATTEMPTS = 50;

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90)
    .replace(/-+$/g, "");
}

function isDuplicateKey(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: number }).code === 11000,
  );
}

/**
 * Writes a slug onto an institution, resolving collisions by suffix.
 *
 * The unique index is the lock. Reading first to check availability would hand
 * the same slug to two concurrent callers, so the write itself is the test:
 * attempt, catch 11000, try the next candidate.
 *
 * Idempotent per institution — an institution that already has a slug keeps it,
 * because consumers hold URLs pointing at it.
 */
export async function claimSlug(institutionId: string, base: string): Promise<string> {
  await connectToDatabase();

  const existing = await Institution.findOne({ institutionId }).select("slug").lean();
  if (!existing) throw new AppError("NOT_FOUND", "Institution not found");
  if (existing.slug) return existing.slug;

  let candidate = slugify(base);
  if (!candidate || candidate.length < 4) candidate = `institution-${institutionId.toLowerCase()}`;
  if ((RESERVED_SLUGS as readonly string[]).includes(candidate)) candidate = `${candidate}-2`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const value = attempt === 1 ? candidate : `${candidate}-${attempt}`;
    try {
      const updated = await Institution.findOneAndUpdate(
        { institutionId, slug: { $exists: false } },
        { $set: { slug: value } },
        { new: true },
      ).lean();
      if (updated?.slug) return updated.slug;
      // Lost a race to another writer on the same institution — take theirs.
      const now = await Institution.findOne({ institutionId }).select("slug").lean();
      if (now?.slug) return now.slug;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  throw new AppError("CONFLICT", "Could not allocate a unique slug");
}

/** Convenience wrapper used at creation time. */
export async function allocateSlug(input: {
  institutionId: string;
  institutionName: string;
  locality?: string;
}): Promise<string> {
  const base = [input.institutionName, input.locality].filter(Boolean).join(" ");
  return claimSlug(input.institutionId, base);
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/integration/slug.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Write the backfill script**

Create `scripts/backfill-slugs.ts`. It must be safe to re-run and must only ever write where `slug` is absent — that is what makes it reversible in practice.

```ts
/**
 * Gives every pre-existing institution a slug. Idempotent: only writes where
 * one is absent, so re-running it changes nothing.
 *
 *   npx tsx scripts/backfill-slugs.ts            # report only
 *   npx tsx scripts/backfill-slugs.ts --apply    # write
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import mongoose from "mongoose";
import { Institution } from "../src/models/Institution";
import { claimSlug, slugify } from "../src/services/slug.service";

const APPLY = process.argv.includes("--apply");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  await Institution.syncIndexes();

  const pending = await Institution.find({ slug: { $exists: false } })
    .select("institutionId institutionName locality city")
    .lean();

  console.log(`${pending.length} institution(s) without a slug`);

  for (const row of pending) {
    const base = [row.institutionName, row.locality ?? row.city].filter(Boolean).join(" ");
    if (!APPLY) {
      console.log(`  would set ${row.institutionId} -> ${slugify(base)}`);
      continue;
    }
    const slug = await claimSlug(row.institutionId, base);
    console.log(`  ${row.institutionId} -> ${slug}`);
  }

  if (!APPLY) console.log("\nDry run. Re-run with --apply to write.");
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
```

- [ ] **Step 6: Verify the script is a no-op on a seeded database**

Run: `npx tsx scripts/backfill-slugs.ts`
Expected: reports the institutions in your local database and states it is a dry run. Then run with `--apply`, then run the dry run again — the second dry run must report `0 institution(s) without a slug`. That is the idempotency check.

- [ ] **Step 7: Run the whole suite and commit**

Run: `npm test` — expected PASS, 225 total.

```bash
git add src/services/slug.service.ts scripts/backfill-slugs.ts tests/integration/slug.test.ts
git commit -m "feat: slug allocation with index-backed collision handling

The unique index is the lock. Reading to check availability first would
hand two concurrent callers the same slug. Slugs are stable across a
rename because consumers hold URLs pointing at them."
```

---

## Task 3: Profile completion

**Files:**
- Create: `src/lib/profile/completion.ts`
- Test: `tests/unit/profile-completion.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export type CompletionGroup = { key: string; label: string; weight: number; earned: number; missing: string[] };
  export type ProfileCompletion = { percent: number; groups: CompletionGroup[]; missing: string[] };
  export function calculateCompletion(institution: Record<string, unknown>): ProfileCompletion;
  ```
- Consumed by Task 7 (service), Task 8 (API) and Task 12 (dashboard). All three must call this one function so the number can never disagree between them.

A pure function over a plain object — no database access, no imports from services. That is what makes it trivially testable and impossible to drift.

Weights, summing to exactly 100: identity 15, contact 12, address 12, academic 15, management 10, facilities 10, logo 10, cover 8, social 8.

Within a group, credit is proportional to the fields present. Nothing is rounded up. An empty profile scores 0.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/profile-completion.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { calculateCompletion } from "@/lib/profile/completion";

const EMPTY = { institutionName: "", institutionType: "" };

const FULL = {
  institutionName: "Sri Vivekananda School",
  institutionType: "SCHOOL",
  description: "A co-educational school in Hanur.",
  establishedYear: 1994,
  phone: "9876543210",
  email: "office@svs.test",
  contactPerson: "R. Shashidhar",
  address: "Main Road",
  city: "Hanur",
  district: "Chamarajanagar",
  state: "Karnataka",
  pincode: "571439",
  academic: { board: "State", classesOffered: ["1", "2"] },
  management: { managementType: "TRUST", principalName: "R. Shashidhar" },
  facilities: [
    { code: "LIBRARY", label: "Library" },
    { code: "LAB", label: "Lab" },
    { code: "TRANSPORT", label: "Transport" },
  ],
  logoUrl: "https://cdn.test/logo.png",
  coverImageUrl: "https://cdn.test/cover.jpg",
  social: { instagram: "https://instagram.com/x", facebook: "https://facebook.com/x" },
};

describe("profile completion", () => {
  it("scores an empty profile at zero and names everything missing", () => {
    const result = calculateCompletion(EMPTY);
    expect(result.percent).toBe(0);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it("scores a fully populated profile at one hundred with nothing missing", () => {
    const result = calculateCompletion(FULL);
    expect(result.percent).toBe(100);
    expect(result.missing).toEqual([]);
  });

  it("is deterministic — the same document always scores the same", () => {
    const a = calculateCompletion(FULL);
    const b = calculateCompletion({ ...FULL });
    expect(a.percent).toBe(b.percent);
  });

  it("weights sum to exactly one hundred", () => {
    const total = calculateCompletion(EMPTY).groups.reduce((sum, g) => sum + g.weight, 0);
    expect(total).toBe(100);
  });

  it("gives partial credit inside a group rather than all-or-nothing", () => {
    const half = calculateCompletion({ ...EMPTY, logoUrl: "https://cdn.test/logo.png" });
    expect(half.percent).toBe(10); // the logo group's whole weight, nothing else
  });

  it("requires three facilities before the facilities group is complete", () => {
    const two = calculateCompletion({
      ...EMPTY,
      facilities: [
        { code: "A", label: "A" },
        { code: "B", label: "B" },
      ],
    });
    const three = calculateCompletion({
      ...EMPTY,
      facilities: [
        { code: "A", label: "A" },
        { code: "B", label: "B" },
        { code: "C", label: "C" },
      ],
    });
    expect(two.percent).toBeLessThan(three.percent);
    expect(three.percent).toBe(10);
  });

  it("never reports a percentage above one hundred", () => {
    const overfilled = { ...FULL, facilities: Array.from({ length: 40 }, (_, i) => ({ code: `F${i}`, label: `F${i}` })) };
    expect(calculateCompletion(overfilled).percent).toBe(100);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/profile-completion.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/profile/completion.ts`:

```ts
export type CompletionGroup = {
  key: string;
  label: string;
  weight: number;
  earned: number;
  missing: string[];
};

export type ProfileCompletion = {
  percent: number;
  groups: CompletionGroup[];
  missing: string[];
};

type Doc = Record<string, any>;

const filled = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return true;
};

type Check = { label: string; done: (doc: Doc) => boolean };

type GroupSpec = { key: string; label: string; weight: number; checks: Check[] };

/**
 * The single weight table. Any surface that shows a completion percentage
 * derives it from here, so the dashboard and the API cannot disagree.
 */
const GROUPS: GroupSpec[] = [
  {
    key: "identity",
    label: "Basic information",
    weight: 15,
    checks: [
      { label: "Institution name", done: (d) => filled(d.institutionName) },
      { label: "Institution type", done: (d) => filled(d.institutionType) },
      { label: "Description", done: (d) => filled(d.description) },
      { label: "Year established", done: (d) => filled(d.establishedYear) },
    ],
  },
  {
    key: "contact",
    label: "Contact",
    weight: 12,
    checks: [
      { label: "Phone number", done: (d) => filled(d.phone) },
      { label: "Email address", done: (d) => filled(d.email) },
      { label: "Contact person", done: (d) => filled(d.contactPerson) },
    ],
  },
  {
    key: "address",
    label: "Address",
    weight: 12,
    checks: [
      { label: "Street address", done: (d) => filled(d.address) },
      { label: "City", done: (d) => filled(d.city) },
      { label: "District", done: (d) => filled(d.district) },
      { label: "State", done: (d) => filled(d.state) },
      { label: "Pincode", done: (d) => filled(d.pincode) },
    ],
  },
  {
    key: "academic",
    label: "Academic information",
    weight: 15,
    checks: [
      { label: "Board or affiliation", done: (d) => filled(d.academic?.board) },
      {
        label: "Classes or courses offered",
        done: (d) => filled(d.academic?.classesOffered) || filled(d.academic?.coursesOffered),
      },
    ],
  },
  {
    key: "management",
    label: "Management",
    weight: 10,
    checks: [
      { label: "Management type", done: (d) => filled(d.management?.managementType) },
      { label: "Principal or head", done: (d) => filled(d.management?.principalName) },
    ],
  },
  {
    key: "facilities",
    label: "Facilities",
    weight: 10,
    checks: [{ label: "At least three facilities", done: (d) => (d.facilities?.length ?? 0) >= 3 }],
  },
  {
    key: "logo",
    label: "Logo",
    weight: 10,
    checks: [{ label: "Logo image", done: (d) => filled(d.logoUrl) }],
  },
  {
    key: "cover",
    label: "Cover image",
    weight: 8,
    checks: [{ label: "Cover image", done: (d) => filled(d.coverImageUrl) }],
  },
  {
    key: "social",
    label: "Social links",
    weight: 8,
    checks: [
      {
        label: "At least two social links",
        done: (d) => {
          const s = d.social ?? {};
          const named = ["facebook", "instagram", "youtube", "linkedin", "x"].filter((k) =>
            filled(s[k]),
          ).length;
          return named + (s.other?.length ?? 0) >= 2;
        },
      },
    ],
  },
];

export function calculateCompletion(institution: Doc): ProfileCompletion {
  const doc = institution ?? {};

  const groups: CompletionGroup[] = GROUPS.map((spec) => {
    const missing = spec.checks.filter((check) => !check.done(doc)).map((check) => check.label);
    const done = spec.checks.length - missing.length;
    // Proportional credit, truncated — never rounded up, never padded.
    const earned = Math.floor((done / spec.checks.length) * spec.weight);
    return { key: spec.key, label: spec.label, weight: spec.weight, earned, missing };
  });

  const percent = Math.min(
    100,
    groups.reduce((sum, group) => sum + group.earned, 0),
  );

  return { percent, groups, missing: groups.flatMap((group) => group.missing) };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/profile-completion.test.ts`
Expected: PASS — 7 tests. If "fully populated scores 100" fails by a point or two, that is truncation across groups; adjust the weight table so every group's weight divides evenly by its check count, rather than rounding up in the calculation.

- [ ] **Step 5: Commit**

```bash
git add src/lib/profile/completion.ts tests/unit/profile-completion.test.ts
git commit -m "feat: deterministic profile completion scoring

One weight table, one function. Dashboard and API both read it, so the
number cannot disagree between them."
```

---

## Task 4: The public projection

**Files:**
- Create: `src/lib/profile/public-projection.ts`
- Test: `tests/unit/public-projection.test.ts` (create)

**Interfaces:**
- Produces: `toPublicProfile(institution: Record<string, unknown>): PublicProfile` and the `PublicProfile` type.
- Consumed by Task 10 only. No other caller.

**This is the highest-risk surface in the phase.** It is an allow-list: the function names the fields that may leave, and anything not named stays in. A deny-list would leak every field added to the schema on the day it was added.

The test named "a field added to the schema does not leak" is the one that matters. It is written so that it fails if someone converts the implementation to a spread-and-delete.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/public-projection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toPublicProfile } from "@/lib/profile/public-projection";

const DOC = {
  _id: "6a8880f3446c577c470cd06c",
  institutionId: "INS0001",
  slug: "sri-vivekananda-school-hanur",
  institutionName: "Sri Vivekananda School",
  institutionType: "SCHOOL",
  regionCode: "KA-MYS",
  legalName: "Sri Vivekananda Education Trust",
  tagline: "Learning without limits",
  description: "A co-educational school in Hanur.",
  establishedYear: 1994,
  logoUrl: "https://cdn.test/logo.png",
  coverImageUrl: "https://cdn.test/cover.jpg",
  address: "Main Road",
  city: "Hanur",
  district: "Chamarajanagar",
  state: "Karnataka",
  pincode: "571439",
  country: "India",
  geo: { latitude: 12.09, longitude: 77.05 },
  phone: "9876543210",
  email: "office@svs.test",
  website: "https://svs.test",
  contactPerson: "R. Shashidhar",
  contact: { secondaryPhone: "9876543211", whatsapp: "9876543210" },
  academic: { board: "State", genderType: "CO_ED", classesOffered: ["1", "2"] },
  management: {
    managementType: "TRUST",
    principalName: "R. Shashidhar",
    headDesignation: "Principal",
    headEmail: "principal@svs.test",
    headPhone: "9876543212",
  },
  facilities: [{ code: "LIBRARY", label: "Library", available: true }],
  social: { instagram: "https://instagram.com/svshanur" },
  gallery: [
    { _id: "1", imageUrl: "https://cdn.test/1.jpg", title: "Campus", status: "ACTIVE", sortOrder: 1 },
    { _id: "2", imageUrl: "https://cdn.test/2.jpg", title: "Hidden", status: "HIDDEN", sortOrder: 2 },
  ],

  // --- none of the following may ever appear in the output ---
  active: true,
  profileStatus: "PUBLISHED",
  publishedAt: new Date("2026-08-23"),
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-08-23"),
  __v: 0,
};

describe("public profile projection", () => {
  it("exposes the institution's public identity", () => {
    const out = toPublicProfile(DOC) as Record<string, unknown>;
    expect(out.institutionId).toBe("INS0001");
    expect(out.slug).toBe("sri-vivekananda-school-hanur");
    expect(out.institutionName).toBe("Sri Vivekananda School");
    expect(out.regionCode).toBe("KA-MYS");
  });

  it("never exposes operational or internal fields", () => {
    const out = toPublicProfile(DOC) as Record<string, unknown>;
    for (const key of ["active", "profileStatus", "publishedAt", "createdAt", "updatedAt", "_id", "__v"]) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it("withholds the head's direct email and phone", () => {
    const out = toPublicProfile(DOC) as any;
    expect(out.management.principalName).toBe("R. Shashidhar");
    expect(out.management.headDesignation).toBe("Principal");
    expect(out.management).not.toHaveProperty("headEmail");
    expect(out.management).not.toHaveProperty("headPhone");
  });

  it("omits hidden gallery items", () => {
    const out = toPublicProfile(DOC) as any;
    expect(out.gallery).toHaveLength(1);
    expect(out.gallery[0].title).toBe("Campus");
  });

  it("does not leak a field that was added to the schema but not to the allow-list", () => {
    // The guarantee: private by default. If this fails, someone has replaced
    // the allow-list with a spread, and every future field leaks on the day it
    // is added.
    const out = toPublicProfile({
      ...DOC,
      internalRiskNote: "school is behind on payment",
      subscriptionPlan: "TRIAL",
    }) as Record<string, unknown>;

    expect(out).not.toHaveProperty("internalRiskNote");
    expect(out).not.toHaveProperty("subscriptionPlan");
  });

  it("survives a sparse document without inventing values", () => {
    const out = toPublicProfile({
      institutionId: "INS0002",
      institutionName: "Bare",
      institutionType: "SCHOOL",
      slug: "bare",
    }) as any;

    expect(out.institutionName).toBe("Bare");
    expect(out.facilities).toEqual([]);
    expect(out.gallery).toEqual([]);
    expect(out.academic).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/public-projection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/profile/public-projection.ts`. Build the output object field by field. **Do not** start from a spread of the input and delete keys.

```ts
/**
 * The only path from an Institution document to a public response.
 *
 * This is an allow-list: it names the fields that may leave. A field added to
 * the schema is private until someone deliberately adds it here. Rewriting this
 * as a spread with deletions would leak every future field on the day it was
 * added — a test exists specifically to catch that.
 */

type Doc = Record<string, any>;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const list = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length > 0 ? value.map(String) : undefined;

/** Drops a block entirely when every field in it is absent. */
function compact<T extends Record<string, unknown>>(block: T): T | undefined {
  const kept = Object.entries(block).filter(([, value]) => value !== undefined);
  return kept.length > 0 ? (Object.fromEntries(kept) as T) : undefined;
}

export type PublicProfile = ReturnType<typeof toPublicProfile>;

export function toPublicProfile(institution: Doc) {
  const doc = institution ?? {};

  const geo = compact({
    latitude: num(doc.geo?.latitude),
    longitude: num(doc.geo?.longitude),
    mapUrl: text(doc.geo?.mapUrl),
  });

  const academic = compact({
    board: text(doc.academic?.board),
    affiliation: text(doc.academic?.affiliation),
    recognition: text(doc.academic?.recognition),
    affiliationNumber: text(doc.academic?.affiliationNumber),
    udiseCode: text(doc.academic?.udiseCode),
    medium: list(doc.academic?.medium),
    genderType: text(doc.academic?.genderType),
    currentAcademicYear: text(doc.academic?.currentAcademicYear),
    classesOffered: list(doc.academic?.classesOffered),
    coursesOffered: list(doc.academic?.coursesOffered),
  });

  // Names and designations only. The head's direct line is not public.
  const management = compact({
    managementType: text(doc.management?.managementType),
    trustName: text(doc.management?.trustName),
    societyName: text(doc.management?.societyName),
    managementName: text(doc.management?.managementName),
    principalName: text(doc.management?.principalName),
    headDesignation: text(doc.management?.headDesignation),
  });

  const social = compact({
    facebook: text(doc.social?.facebook),
    instagram: text(doc.social?.instagram),
    youtube: text(doc.social?.youtube),
    linkedin: text(doc.social?.linkedin),
    x: text(doc.social?.x),
    other: Array.isArray(doc.social?.other)
      ? doc.social.other
          .map((entry: Doc) => compact({ label: text(entry?.label), url: text(entry?.url) }))
          .filter(Boolean)
      : undefined,
  });

  return {
    institutionId: String(doc.institutionId),
    slug: text(doc.slug),
    institutionName: String(doc.institutionName ?? ""),
    legalName: text(doc.legalName),
    shortName: text(doc.shortName),
    institutionType: String(doc.institutionType ?? ""),
    regionCode: text(doc.regionCode),
    tagline: text(doc.tagline),
    description: text(doc.description),
    establishedYear: num(doc.establishedYear),
    logoUrl: text(doc.logoUrl),
    coverImageUrl: text(doc.coverImageUrl),

    address: compact({
      addressLine1: text(doc.address),
      addressLine2: text(doc.addressLine2),
      locality: text(doc.locality),
      area: text(doc.area),
      city: text(doc.city),
      taluk: text(doc.taluk),
      district: text(doc.district),
      state: text(doc.state),
      country: text(doc.country),
      pincode: text(doc.pincode),
    }),

    geo,

    contact: compact({
      phone: text(doc.phone),
      secondaryPhone: text(doc.contact?.secondaryPhone),
      whatsapp: text(doc.contact?.whatsapp),
      email: text(doc.email),
      alternateEmail: text(doc.contact?.alternateEmail),
      website: text(doc.website),
      contactPerson: text(doc.contactPerson),
    }),

    academic,
    management,

    facilities: Array.isArray(doc.facilities)
      ? doc.facilities.map((facility: Doc) => ({
          code: String(facility?.code ?? ""),
          label: String(facility?.label ?? ""),
          available: facility?.available !== false,
          note: text(facility?.note),
        }))
      : [],

    social,

    gallery: Array.isArray(doc.gallery)
      ? doc.gallery
          .filter((item: Doc) => item?.status !== "HIDDEN")
          .sort((a: Doc, b: Doc) => (a?.sortOrder ?? 0) - (b?.sortOrder ?? 0))
          .map((item: Doc) => ({
            imageUrl: String(item?.imageUrl ?? ""),
            title: text(item?.title),
            description: text(item?.description),
          }))
      : [],
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/public-projection.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Mutation-check the leak test**

This is the one guard in the phase worth proving. Temporarily replace the body of `toPublicProfile` with `return { ...institution };` and run the test file again.

Expected: the "does not leak a field" test **and** "never exposes operational or internal fields" both FAIL. If they pass, the tests are confounded and must be rewritten before proceeding. Restore the implementation afterwards and re-run to confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/profile/public-projection.ts tests/unit/public-projection.test.ts
git commit -m "feat: allow-list projection for public institution data

Named fields only. A field added to the schema is private until someone
deliberately adds it here, and a mutation-checked test enforces that."
```

---

## Task 5: Validation schemas

**Files:**
- Modify: `src/lib/validation/institution.ts`
- Test: `tests/unit/profile-validation.test.ts` (create)

**Interfaces:**
- Consumes: `optionalText`, `optionalUrlSchema`, `optionalPhoneSchema`, `optionalEmailSchema`, `optionalPincodeSchema` from `src/lib/validation/common.ts`. Do not write new validators for phone, email, URL or pincode — they exist and are already tested.
- Produces:
  - `updateProfileSchema` — everything an institute admin may change.
  - `platformInstitutionPatchSchema` — the **narrow** schema for the platform admin: `institutionName`, `institutionType`, `active`, `regionCode`. Nothing else.
  - `mediaUploadSchema` — `{ kind: "LOGO" | "COVER" | "GALLERY"; title?; description? }`.
  - `galleryItemPatchSchema` — `{ title?; description?; sortOrder?; status? }`.

**The narrowing is the security control.** Per Global Constraints, the platform admin cannot edit profile content, and that is enforced here — by the schema the route parses with — not by a dashboard that happens not to render the fields.

Zod strips unknown keys by default, which is the existing mass-assignment defence. Do not add `.passthrough()` anywhere.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/profile-validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  platformInstitutionPatchSchema,
  updateProfileSchema,
} from "@/lib/validation/institution";

describe("profile validation", () => {
  it("accepts a partial section update", () => {
    const parsed = updateProfileSchema.parse({
      academic: { board: "CBSE", classesOffered: ["1", "2"] },
    });
    expect(parsed.academic?.board).toBe("CBSE");
  });

  it("strips fields the institute admin may not set", () => {
    const parsed = updateProfileSchema.parse({
      institutionName: "New Name",
      institutionId: "INS9999",
      active: false,
      profileStatus: "PUBLISHED",
    }) as Record<string, unknown>;

    expect(parsed.institutionName).toBe("New Name");
    expect(parsed).not.toHaveProperty("institutionId");
    expect(parsed).not.toHaveProperty("active");
    expect(parsed).not.toHaveProperty("profileStatus");
  });

  it("keeps the platform admin out of profile content", () => {
    // The boundary is enforced by this schema, not by the UI.
    const parsed = platformInstitutionPatchSchema.parse({
      institutionName: "Renamed",
      active: false,
      regionCode: "KA-MYS",
      description: "trying to edit the profile",
      academic: { board: "CBSE" },
      logoUrl: "https://cdn.test/other.png",
      gallery: [{ imageUrl: "https://cdn.test/x.jpg" }],
    }) as Record<string, unknown>;

    expect(parsed.institutionName).toBe("Renamed");
    expect(parsed.active).toBe(false);
    expect(parsed.regionCode).toBe("KA-MYS");
    expect(parsed).not.toHaveProperty("description");
    expect(parsed).not.toHaveProperty("academic");
    expect(parsed).not.toHaveProperty("logoUrl");
    expect(parsed).not.toHaveProperty("gallery");
  });

  it("rejects a malformed social URL", () => {
    expect(() => updateProfileSchema.parse({ social: { instagram: "not a url" } })).toThrow();
  });

  it("rejects an impossible established year", () => {
    expect(() => updateProfileSchema.parse({ establishedYear: 1500 })).toThrow();
    expect(() => updateProfileSchema.parse({ establishedYear: 3000 })).toThrow();
  });

  it("rejects out-of-range coordinates", () => {
    expect(() => updateProfileSchema.parse({ geo: { latitude: 200 } })).toThrow();
    expect(() => updateProfileSchema.parse({ geo: { longitude: -900 } })).toThrow();
  });

  it("requires both code and label on a facility", () => {
    expect(() => updateProfileSchema.parse({ facilities: [{ code: "LIBRARY" }] })).toThrow();
    expect(
      updateProfileSchema.parse({ facilities: [{ code: "LIBRARY", label: "Library" }] }).facilities,
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/profile-validation.test.ts`
Expected: FAIL — the two schemas are not exported yet.

- [ ] **Step 3: Extend the validation module**

Append to `src/lib/validation/institution.ts`. Keep `createInstitutionSchema`, `updateInstitutionSchema` and `updateInstitutionProfileSchema` exactly as they are — existing routes and tests depend on them.

```ts
import { GENDER_TYPES, MANAGEMENT_TYPES, GALLERY_STATUSES } from "@/lib/constants";

const CURRENT_YEAR = 2200; // upper bound; lower bound 1800

const contactBlockSchema = z.object({
  secondaryPhone: optionalPhoneSchema,
  alternateEmail: optionalEmailSchema,
  whatsapp: optionalPhoneSchema,
});

const geoSchema = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  mapUrl: optionalUrlSchema,
});

const academicSchema = z.object({
  board: optionalText(80),
  affiliation: optionalText(120),
  recognition: optionalText(120),
  affiliationNumber: optionalText(60),
  udiseCode: optionalText(40),
  medium: z.array(requiredText("Medium", 40)).max(12).optional(),
  genderType: z.enum(GENDER_TYPES).optional(),
  currentAcademicYear: optionalText(20),
  classesOffered: z.array(requiredText("Class", 40)).max(60).optional(),
  coursesOffered: z.array(requiredText("Course", 120)).max(120).optional(),
});

const managementSchema = z.object({
  managementType: z.enum(MANAGEMENT_TYPES).optional(),
  trustName: optionalText(160),
  societyName: optionalText(160),
  managementName: optionalText(160),
  principalName: optionalText(120),
  headDesignation: optionalText(80),
  headEmail: optionalEmailSchema,
  headPhone: optionalPhoneSchema,
});

const facilitySchema = z.object({
  code: requiredText("Facility code", 40),
  label: requiredText("Facility label", 80),
  available: z.boolean().optional(),
  note: optionalText(200),
});

const socialSchema = z.object({
  facebook: optionalUrlSchema,
  instagram: optionalUrlSchema,
  youtube: optionalUrlSchema,
  linkedin: optionalUrlSchema,
  x: optionalUrlSchema,
  other: z
    .array(z.object({ label: requiredText("Label", 40), url: optionalUrlSchema }))
    .max(6)
    .optional(),
});

/** Everything an institute admin may change on their own profile. */
export const updateProfileSchema = z.object({
  institutionName: requiredText("Institution name", 160).optional(),
  legalName: optionalText(200),
  shortName: optionalText(80),
  institutionType: z.enum(INSTITUTION_TYPES).optional(),
  tagline: optionalText(160),
  description: optionalText(4000),
  establishedYear: z.number().int().min(1800).max(CURRENT_YEAR).optional(),

  ...brandingFields,

  addressLine2: optionalText(200),
  locality: optionalText(120),
  area: optionalText(120),
  taluk: optionalText(120),
  district: optionalText(120),
  country: optionalText(80),

  contact: contactBlockSchema.optional(),
  geo: geoSchema.optional(),
  academic: academicSchema.optional(),
  management: managementSchema.optional(),
  facilities: z.array(facilitySchema).max(40).optional(),
  social: socialSchema.optional(),
});

/**
 * The platform admin provisions institutions; they do not author the profile.
 * The boundary lives in this schema so no route can widen it by accident.
 */
export const platformInstitutionPatchSchema = z.object({
  institutionName: requiredText("Institution name", 160).optional(),
  institutionType: z.enum(INSTITUTION_TYPES).optional(),
  regionCode: optionalText(12),
  active: z.boolean().optional(),
});

export const mediaUploadSchema = z.object({
  kind: z.enum(["LOGO", "COVER", "GALLERY"]),
  title: optionalText(120),
  description: optionalText(400),
});

export const galleryItemPatchSchema = z.object({
  title: optionalText(120),
  description: optionalText(400),
  sortOrder: z.number().int().min(0).max(999).optional(),
  status: z.enum(GALLERY_STATUSES).optional(),
});
```

- [ ] **Step 4: Run the test and the suite**

Run: `npx vitest run tests/unit/profile-validation.test.ts` — expected PASS, 7 tests.
Run: `npm test` — expected PASS, 238 total, no existing file edited.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/institution.ts tests/unit/profile-validation.test.ts
git commit -m "feat: profile validation schemas, with the platform admin narrowed

platformInstitutionPatchSchema is the security control that keeps the
platform admin out of profile content. It is not a UI convention."
```

---

## Task 6: The public storage path

**Files:**
- Modify: `src/lib/storage/types.ts`
- Modify: `src/lib/storage/blob.ts`
- Modify: `src/lib/storage/local.ts`
- Create: `src/app/api/media/[...key]/route.ts`
- Test: `tests/unit/storage-public.test.ts` (create)

**Interfaces:**
- Produces, on `StorageAdapter`:
  - `putPublic(input: { key: string; body: Buffer; contentType: string }): Promise<StoredObject>` — the returned `key` is a **directly loadable URL** (Blob: CDN URL; local: `/api/media/<key>`).
  - `deletePublic(key: string): Promise<void>`
- The existing `put`/`get`/`delete` are untouched — admission documents stay private.

**Boundary rule:** only `InstitutionService` (Task 7) calls `putPublic`. `DocumentService` never does. The contract comment in `types.ts` is updated to say both things.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/storage-public.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { localStorageAdapter } from "@/lib/storage/local";

describe("public storage path", () => {
  it("returns a URL-shaped handle that needs no authentication to load", async () => {
    const stored = await localStorageAdapter.putPublic({
      key: "media/INS0001/logo-test.png",
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      contentType: "image/png",
    });

    // The handle is what a third-party website will put in an <img src>.
    expect(stored.key).toBe("/api/media/media/INS0001/logo-test.png");
    await localStorageAdapter.deletePublic("media/INS0001/logo-test.png");
  });

  it("rejects a key that tries to escape the media root", async () => {
    await expect(
      localStorageAdapter.putPublic({
        key: "../../etc/passwd",
        body: Buffer.from("x"),
        contentType: "image/png",
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/storage-public.test.ts`
Expected: FAIL — `putPublic` does not exist.

- [ ] **Step 3: Extend the interface**

In `src/lib/storage/types.ts`, add to `StorageAdapter`:

```ts
  /**
   * Public path — institution media ONLY (logo, cover, gallery). The returned
   * key is a directly loadable URL: third-party websites hot-link it, so it
   * must never require authentication. Admission documents never go through
   * here; DocumentService is forbidden from calling it.
   */
  putPublic(input: { key: string; body: Buffer; contentType: string }): Promise<StoredObject>;
  deletePublic(key: string): Promise<void>;
```

- [ ] **Step 4: Implement both adapters**

`src/lib/storage/blob.ts` — add to `blobStorageAdapter`:

```ts
  async putPublic({ key, body, contentType }) {
    const blob = await put(key, body, {
      access: "public",
      contentType,
      // Public URLs are guessable by design; a random suffix stops enumeration
      // of one institution's media from the URL of another.
      addRandomSuffix: true,
    });
    return { key: blob.url, size: body.byteLength, contentType };
  },

  async deletePublic(key) {
    await del(key).catch(() => undefined);
  },
```

`src/lib/storage/local.ts` — public files live under a distinct root so the private tree can never be reached through the public route:

```ts
const PUBLIC_ROOT = resolve(process.env.PUBLIC_UPLOAD_DIR ?? join(process.cwd(), ".uploads-public"));

function resolvePublicKey(key: string): string {
  const target = resolve(PUBLIC_ROOT, key);
  if (target !== PUBLIC_ROOT && !target.startsWith(PUBLIC_ROOT + sep)) {
    throw new Error("Invalid storage key");
  }
  return target;
}
```

and on the adapter:

```ts
  async putPublic({ key, body, contentType }) {
    const target = resolvePublicKey(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    await writeFile(`${target}${CONTENT_TYPE_SUFFIX}`, contentType, "utf8");
    return { key: `/api/media/${key}`, size: body.byteLength, contentType };
  },

  async deletePublic(key) {
    const target = resolvePublicKey(key.replace(/^\/api\/media\//, ""));
    await Promise.allSettled([unlink(target), unlink(`${target}${CONTENT_TYPE_SUFFIX}`)]);
  },
```

- [ ] **Step 5: The local media route**

Create `src/app/api/media/[...key]/route.ts` — the unauthenticated dev-serving route. It reads **only** from the public root:

```ts
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const PUBLIC_ROOT = resolve(process.env.PUBLIC_UPLOAD_DIR ?? join(process.cwd(), ".uploads-public"));

/**
 * Serves institution media in development, where there is no CDN. Deliberately
 * unauthenticated: these are the same bytes a school's website hot-links in
 * production. Only the public root is reachable; admission documents live in a
 * different tree behind the authenticated document route.
 */
export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/media/[...key]">,
) {
  const { key } = await context.params;
  const relative = key.join("/");

  const target = resolve(PUBLIC_ROOT, relative);
  if (target !== PUBLIC_ROOT && !target.startsWith(PUBLIC_ROOT + sep)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const [body, contentType] = await Promise.all([
      readFile(target),
      readFile(`${target}.content-type`, "utf8").catch(() => "application/octet-stream"),
    ]);
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": contentType.trim(),
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run tests/unit/storage-public.test.ts` — expected PASS, 2 tests.
Run: `npx tsc --noEmit` — the compiler now enforces that **both** adapters implement the widened interface; a missing method on either fails here.
Run: `npm test` — expected PASS, 240 total.

- [ ] **Step 7: Commit**

```bash
git add src/lib/storage src/app/api/media tests/unit/storage-public.test.ts
git commit -m "feat: public storage path for institution media

Separate root, separate methods, separate serving route. Admission
documents keep the private path; only institution media may use this."
```

---

## Task 7: InstitutionService profile methods

**Files:**
- Modify: `src/services/institution.service.ts`
- Create: `src/lib/profile/facilities.ts`
- Test: `tests/integration/institution-profile.test.ts` (create)

**Interfaces:**
- Consumes: `claimSlug`/`allocateSlug` (Task 2), `calculateCompletion` (Task 3), `updateProfileSchema`/`platformInstitutionPatchSchema`/`mediaUploadSchema` (Task 5), `storage.putPublic`/`deletePublic` (Task 6), `GALLERY_MAX_ITEMS` (Task 1).
- Produces, on `InstitutionService`:
  ```ts
  getProfile(institutionId): Promise<{ profile: ProfileDTO; completion: ProfileCompletion }>
  updateProfile(institutionId, patch: z.infer<typeof updateProfileSchema>, actor): Promise<ProfileDTO>
  setProfileStatus(institutionId, status: "PUBLISHED" | "DRAFT", actor): Promise<ProfileDTO>
  addMedia(institutionId, input: { kind; fileName; contentType; bytes: Buffer; title?; description? }, actor): Promise<ProfileDTO>
  removeGalleryItem(institutionId, mediaId: string, actor): Promise<ProfileDTO>
  patchPlatform(institutionId, patch: z.infer<typeof platformInstitutionPatchSchema>, actor): Promise<InstitutionDTO>
  ```
- `ProfileDTO` is the full serialized profile (all sections + `slug`, `profileStatus`, `publishedAt`, `regionCode`). Extend the existing `serialize` — do not fork a second serializer for the same document.
- `create(...)` gains one behaviour: after creating the institution it calls `allocateSlug`. Existing signature unchanged.

Rules the implementation must observe:

1. **Deep-merge is explicit.** A `PATCH` with `academic: { board: "CBSE" }` must not erase `academic.classesOffered`. Build dotted `$set` paths (`"academic.board": "CBSE"`) from the parsed patch rather than `$set`-ing whole sub-documents. Arrays (`facilities`, `social.other`, `medium`, `classesOffered`, `coursesOffered`) replace wholesale — that is the editing model the UI presents.
2. **Media kinds behave differently.** `LOGO`/`COVER` store the new object, `$set` the URL field, then `deletePublic` the previous object (best-effort). `GALLERY` pushes onto the array **only if** `gallery` has fewer than `GALLERY_MAX_ITEMS` entries — enforced with a filtered atomic update (`{ institutionId, $expr: { $lt: [{ $size: { $ifNull: ["$gallery", []] } }, GALLERY_MAX_ITEMS] } }`), not a read-then-push.
3. **Image validation reuses the existing pattern.** 5 MB cap; JPEG/PNG/WebP only; magic-byte sniff copied in shape from `document.service.ts`'s `sniffMatchesDeclaredType` (drop the PDF branch); stored under `media/<institutionId>/<ObjectId>.<ext>` — filename never taken from user input.
4. **Publishing sets `publishedAt` once** (first publish); unpublish leaves it in place as history. `SUSPENDED`/`ARCHIVED` are settable in the DB but no Phase 1 endpoint sets them (platform-admin tooling for that is future work — the enum exists so the projection and public routes already honour it).
5. **Every mutation records an Activity** with the existing `ActivityService.record` shape.

`src/lib/profile/facilities.ts` is a constant list of `{ code, label }` suggestions (LIBRARY, SCIENCE_LAB, COMPUTER_LAB, SMART_CLASSROOM, PLAYGROUND, AUDITORIUM, HOSTEL, TRANSPORT, CAFETERIA, SPORTS, DIGITAL_LEARNING) used by the UI picker. It is a convenience, not a constraint — the schema accepts any code.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/institution-profile.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Institution } from "@/models";
import { InstitutionService } from "@/services/institution.service";
import { updateProfileSchema } from "@/lib/validation/institution";

const ACTOR = { id: "6a8880f3446c577c470cd06c", name: "Test Admin" };

// A real PNG header followed by padding — passes the magic-byte sniff.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

describe("institution profile service", () => {
  beforeAll(async () => {
    await startTestDatabase("institutionprofile");
    await Institution.syncIndexes();
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("updates one section without erasing a sibling field", async () => {
    await makeInstitution("INS0001");
    await InstitutionService.updateProfile(
      "INS0001",
      updateProfileSchema.parse({ academic: { board: "State", classesOffered: ["1", "2"] } }),
      ACTOR,
    );

    // A later patch touching only the board must not wipe classesOffered.
    await InstitutionService.updateProfile(
      "INS0001",
      updateProfileSchema.parse({ academic: { board: "CBSE" } }),
      ACTOR,
    );

    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
    expect(row!.academic!.board).toBe("CBSE");
    expect(row!.academic!.classesOffered).toEqual(["1", "2"]);
  });

  it("returns completion alongside the profile", async () => {
    await makeInstitution("INS0001");
    const { completion } = await InstitutionService.getProfile("INS0001");
    expect(completion.percent).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(completion.missing)).toBe(true);
  });

  it("publishes and records when, then unpublishes without losing the date", async () => {
    await makeInstitution("INS0001");
    const published = await InstitutionService.setProfileStatus("INS0001", "PUBLISHED", ACTOR);
    expect(published.profileStatus).toBe("PUBLISHED");
    expect(published.publishedAt).toBeDefined();

    const draft = await InstitutionService.setProfileStatus("INS0001", "DRAFT", ACTOR);
    expect(draft.profileStatus).toBe("DRAFT");
    expect(draft.publishedAt).toBeDefined(); // history, not state
  });

  it("stores a logo and replaces it on the next upload", async () => {
    await makeInstitution("INS0001");
    const first = await InstitutionService.addMedia(
      "INS0001",
      { kind: "LOGO", fileName: "logo.png", contentType: "image/png", bytes: PNG },
      ACTOR,
    );
    expect(first.logoUrl).toBeTruthy();

    const second = await InstitutionService.addMedia(
      "INS0001",
      { kind: "LOGO", fileName: "logo2.png", contentType: "image/png", bytes: PNG },
      ACTOR,
    );
    expect(second.logoUrl).toBeTruthy();
    expect(second.logoUrl).not.toBe(first.logoUrl);
  });

  it("rejects a fake image regardless of its declared content type", async () => {
    await makeInstitution("INS0001");
    await expect(
      InstitutionService.addMedia(
        "INS0001",
        {
          kind: "GALLERY",
          fileName: "evil.png",
          contentType: "image/png",
          bytes: Buffer.from("#!/bin/sh\nrm -rf /\n"),
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("enforces the gallery cap atomically", async () => {
    await makeInstitution("INS0001", {
      gallery: Array.from({ length: 60 }, (_, i) => ({
        imageUrl: `https://cdn.test/${i}.jpg`,
        status: "ACTIVE",
      })),
    });

    await expect(
      InstitutionService.addMedia(
        "INS0001",
        { kind: "GALLERY", fileName: "one-too-many.png", contentType: "image/png", bytes: PNG },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("removes a gallery item by id", async () => {
    await makeInstitution("INS0001");
    await InstitutionService.addMedia(
      "INS0001",
      { kind: "GALLERY", fileName: "a.png", contentType: "image/png", bytes: PNG, title: "A" },
      ACTOR,
    );
    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
    const mediaId = String(row!.gallery![0]!._id);

    const after = await InstitutionService.removeGalleryItem("INS0001", mediaId, ACTOR);
    expect(after.gallery ?? []).toHaveLength(0);
  });

  it("allocates a slug when an institution is created", async () => {
    const { institution } = await InstitutionService.create(
      { institutionName: "Green Valley Public School", institutionType: "SCHOOL", city: "Mysore" } as never,
      ACTOR,
    );
    const row = await Institution.findOne({ institutionId: institution.institutionId }).lean();
    expect(row!.slug).toMatch(/^green-valley-public-school/);
  });

  it("keeps the platform patch away from profile content", async () => {
    await makeInstitution("INS0001", { description: "original" });
    await InstitutionService.patchPlatform(
      "INS0001",
      { institutionName: "Renamed", regionCode: "KA-MYS", active: false },
      ACTOR,
    );

    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
    expect(row!.institutionName).toBe("Renamed");
    expect(row!.regionCode).toBe("KA-MYS");
    expect(row!.active).toBe(false);
    expect(row!.description).toBe("original");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/integration/institution-profile.test.ts`
Expected: FAIL — none of the new methods exist.

- [ ] **Step 3: Implement**

Work through the methods in the order the tests exercise them. Implementation notes beyond the rules above:

- Dotted-path builder: walk the parsed patch one level deep for the block fields (`contact`, `geo`, `academic`, `management`, `social`); scalars and arrays at the top level `$set` directly. `social.other` replaces wholesale like the other arrays.
- `addMedia` stores first, then updates the record; if the record update fails, best-effort `deletePublic` the stored object so nothing orphans.
- `removeGalleryItem` uses `$pull: { gallery: { _id: new Types.ObjectId(mediaId) } }` after capturing the item's `imageUrl` for `deletePublic`. Local URLs (`/api/media/...`) and Blob URLs both pass straight to `deletePublic` — the adapters own their own URL shapes.
- `patchPlatform` refuses (`notFound`) when the institution does not exist; records "Institution activated"/"deactivated" activity exactly as the existing `update` does. It never touches any field outside its schema — enforced by the schema type, do not widen the parameter type.
- The facilities list module is 15 lines; write it in this task since the service file imports nothing from it (only the UI will).

- [ ] **Step 4: Run the test file, the suite, and typecheck**

Run: `npx vitest run tests/integration/institution-profile.test.ts` — expected PASS, 9 tests.
Run: `npm test` — expected PASS, 249 total.
Run: `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/institution.service.ts src/lib/profile/facilities.ts tests/integration/institution-profile.test.ts
git commit -m "feat: profile read/write, publish, and media on InstitutionService

Section patches merge by dotted path so one section's save never erases
another's fields. The gallery cap is a filtered atomic update, not a
read-then-push."
```

---

## Task 8: Institute-admin API routes

**Files:**
- Modify: `src/app/api/settings/institution/route.ts` (add `GET`, repoint `PATCH`)
- Create: `src/app/api/settings/institution/publish/route.ts`
- Create: `src/app/api/settings/institution/media/route.ts`
- Create: `src/app/api/settings/institution/media/[mediaId]/route.ts`
- Test: `tests/integration/profile-routes.test.ts` (create)

**Interfaces:**
- Consumes: `requireInstitution()` from `@/lib/tenant` (already rejects platform admins and inactive institutions), `assertSameOrigin`, the Task 5 schemas, the Task 7 service methods, `handleApiError`/`jsonSuccess`.
- Produces: the routes themselves. No new exports.

Route behaviours:

- `GET /api/settings/institution` → `{ success, profile, completion }`.
- `PATCH /api/settings/institution` → parses **`updateProfileSchema`** (replacing the old `updateInstitutionProfileSchema` — keep that export for the platform route's history but this route now accepts full sections), calls `updateProfile`, returns `{ success, profile, completion }` (recompute after write so the UI's meter updates on save).
- `POST /api/settings/institution/publish` with body `{ action: "publish" | "unpublish" }` → `setProfileStatus`. One route, explicit body — mirrors how the codebase prefers a small number of explicit endpoints.
- `POST /api/settings/institution/media` → multipart form (`file`, `kind`, optional `title`/`description`), parses `mediaUploadSchema` from the non-file fields, calls `addMedia`.
- `DELETE /api/settings/institution/media/[mediaId]` → `removeGalleryItem`.

All mutating handlers call `assertSameOrigin(request)` first — these are cookie-session routes (the profile editor is dashboard-only; mobile does not edit profiles in Phase 1, so no `viaBearer` plumbing here).

- [ ] **Step 1: Write the failing test**

Create `tests/integration/profile-routes.test.ts`. Follow the established route-test pattern from `tests/integration/bearer-routes.test.ts`: import handlers directly, fake `NextRequest`, stub the session via the `next-headers` stub used across the suite (see how existing tests arrange `getCurrentUser` — mirror it exactly).

Cases (7):

1. `GET` as institution admin returns profile + completion.
2. `PATCH` with `{ academic: { board: "CBSE" } }` returns 200 and the updated block.
3. `PATCH` from a **platform admin session** returns 403 (comes free from `requireInstitution`; assert it anyway — this is the boundary's route-level proof).
4. `PATCH` with no session returns 401.
5. `POST publish` flips status; response carries `profileStatus: "PUBLISHED"`.
6. `POST media` with a valid PNG form and `kind=GALLERY` returns 200 with a gallery entry (build a real `FormData` with a `File`; Node 20's `File` global works under Vitest).
7. Cross-origin `PATCH` (Origin header set to another host) returns 403 — CSRF still enforced.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/integration/profile-routes.test.ts`
Expected: FAIL — `GET` not exported, publish route absent.

- [ ] **Step 3: Implement the routes**

Shape for the main route (`src/app/api/settings/institution/route.ts`):

```ts
export async function GET() {
  try {
    const { institution } = await requireInstitution();
    const { profile, completion } = await InstitutionService.getProfile(institution.institutionId);
    return jsonSuccess({ profile, completion });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    const patch = updateProfileSchema.parse(await request.json().catch(() => ({})));
    await InstitutionService.updateProfile(institution.institutionId, patch, {
      id: user.id,
      name: user.name,
    });
    const { profile, completion } = await InstitutionService.getProfile(institution.institutionId);
    return jsonSuccess({ profile, completion });
  } catch (error) {
    return handleApiError(error);
  }
}
```

The other three follow the same skeleton. The media route reads `request.formData()`, validates the file exists and is under 5 MB before buffering, and passes `Buffer.from(await file.arrayBuffer())` to the service.

- [ ] **Step 4: Run the tests and the suite**

Run: `npx vitest run tests/integration/profile-routes.test.ts` — expected PASS, 7 tests.
Run: `npm test` — expected PASS, 256 total.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/settings/institution tests/integration/profile-routes.test.ts
git commit -m "feat: profile self-service routes for the institute admin

GET/PATCH profile with completion, explicit publish/unpublish, and
multipart media upload. Cookie + CSRF only — the profile editor is a
dashboard surface."
```

---

## Task 9: Platform-admin routes — read widened, write narrowed

**Files:**
- Modify: `src/app/api/institutions/[institutionId]/route.ts`
- Test: `tests/integration/platform-admin-profile.test.ts` (create)

**Interfaces:**
- Consumes: `requireSuperAdmin()`, `platformInstitutionPatchSchema`, `InstitutionService.getProfile` / `patchPlatform`.
- Produces: no new exports.

Changes:

- `GET` now returns `{ institution, profile, completion }` — the platform admin's read-only window (decision 3).
- `PATCH` switches its schema from `updateInstitutionSchema` to **`platformInstitutionPatchSchema`** and its service call to `patchPlatform`. The old schema accepted branding fields (logoUrl, website, address…) — under decision 3 those now belong to the institute admin alone. **This narrows an existing endpoint on purpose; it is the one intentional behaviour change in the phase.** The admin UI's create dialog still works: `POST /api/institutions` (creation with initial branding) is unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/platform-admin-profile.test.ts`. Cases (5):

1. Platform admin `GET` returns the full profile of any institution (create one with profile blocks via the factory, assert `profile.academic` and `completion.percent` present).
2. Platform admin `PATCH` with `{ institutionName, regionCode, active }` succeeds.
3. Platform admin `PATCH` carrying `{ description, academic, logoUrl }` returns 200 **but none of those fields change** — Zod strips them (assert against the DB, not just the response).
4. Institution admin calling this route gets 403 (`requireSuperAdmin` — existing behaviour, keep proven).
5. No session → 401.

- [ ] **Step 2: Run and confirm failure** — case 1 and 3 fail against the current route.

- [ ] **Step 3: Implement** as described. Nothing else in the file changes.

- [ ] **Step 4: Mutation-check case 3**

Temporarily swap the route's schema back to `updateInstitutionSchema` and run the file: case 3 must FAIL (the description would change). Restore, re-run, green. This proves the test detects the boundary, not just the response code.

- [ ] **Step 5: Suite and commit**

Run: `npm test` — expected PASS, 261 total.

```bash
git add src/app/api/institutions tests/integration/platform-admin-profile.test.ts
git commit -m "feat: platform admin reads any profile, writes only provisioning fields

Deliberate narrowing of PATCH /api/institutions/:id — profile content
now belongs to the institute admin alone, enforced by schema."
```

---

## Task 10: Public profile API

**Files:**
- Create: `src/app/api/public/[institutionId]/profile/route.ts`
- Create: `src/app/api/public/institutions/[slug]/route.ts`
- Modify: `src/services/institution.service.ts` (add `getPublicProfile`)
- Test: `tests/integration/public-profile.test.ts` (create)

**Interfaces:**
- Consumes: `toPublicProfile` (Task 4) — the **only** call site; the existing public-route conventions from `src/app/api/public/[institutionId]/route.ts` (CORS headers, `OPTIONS` handler, rate limiting — copy its exact header set).
- Produces: `InstitutionService.getPublicProfile(query: { institutionId?: string; slug?: string })` → `PublicProfile | null`. Returns `null` unless the institution exists, `active` is true, **and** `profileStatus === "PUBLISHED"`.

Route rules:

- Both routes return the identical payload — one lookup key each.
- **`404` for anything not published — never `403`.** A 403 confirms the record exists; a draft profile must be indistinguishable from a nonexistent one.
- `Cache-Control: public, max-age=300`, `Access-Control-Allow-Origin: *`, `OPTIONS` preflight — same as the sibling branding route.
- The slug route normalises to lowercase before lookup.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/public-profile.test.ts`. Cases (7):

1. Published institution by id → 200, payload carries `institutionName`, `facilities`, `slug`.
2. Same institution by slug → 200, identical `institutionId`.
3. `DRAFT` institution → **404** by id and by slug.
4. `active: false` but `PUBLISHED` → 404 (a deactivated account disappears from the public surface).
5. Unknown id / unknown slug → 404.
6. Response never contains `active`, `profileStatus`, or `publishedAt` (assert on raw JSON keys, recursively).
7. Hidden gallery items absent from the payload.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement** `getPublicProfile` with a single `findOne({ ...key, active: true, profileStatus: "PUBLISHED" }).lean()` and `toPublicProfile` on the way out; the two routes are thin wrappers with the shared CORS/caching headers.

- [ ] **Step 4: Mutation-check the status gate**

Remove `profileStatus: "PUBLISHED"` from the query, run the file — case 3 must FAIL. Restore, green. Then remove `active: true` — case 4 must FAIL. Restore, green.

- [ ] **Step 5: Suite and commit**

Run: `npm test` — expected PASS, 268 total.

```bash
git add src/app/api/public src/services/institution.service.ts tests/integration/public-profile.test.ts
git commit -m "feat: credential-free public profile API, by id and by slug

Published-and-active only; anything else is 404, never 403, so a draft
profile is indistinguishable from a nonexistent one."
```

---

## Task 11: OpenAPI + the I-DAP rename

**Files:**
- Modify: `src/lib/api/openapi.ts`
- Modify: `src/app/layout.tsx`, `src/app/(auth)/login/page.tsx`, `src/components/dashboard/sidebar.tsx`, `src/components/dashboard/nav-config.ts`, `src/app/(dashboard)/layout.tsx`
- Modify: `src/app/api/v1/openapi.json/route.ts`, `src/app/api/v1/openapi.yaml/route.ts`, `src/components/integration/api-docs.tsx`
- Test: extend `tests/unit/api-contract.test.ts`? **No — do not touch existing files.** Create `tests/unit/openapi-profile.test.ts`.

**Interfaces:** none produced; presentation and documentation only.

Changes:

1. `buildOpenApiDocument` gains two paths — `GET {publicBase}/profile` and `GET /api/public/institutions/{slug}` — tagged `Website`, `security: []`, with a response schema naming the top-level public fields and a `404` for unpublished institutions. Scoped documents render the concrete institution id and, when the institution has one, its real slug (pass `slug` through `OpenApiOptions`; `getPublicBranding`'s `.select(...)` must add `slug`).
2. Document `info.title`: `Lead Platform API` → `I-DAP API` (scoped: `` `I-DAP API · ${name}` ``).
3. Wordmark: "Lead Platform" → "I-DAP", brand mark `L` → `iD` (three sites: login ×2, sidebar ×1; the mark span stays the same size — `iD` fits). Browser title/template → "I-DAP". Sidebar `navForRole` title → "I-DAP". Mobile header label likewise.
4. Download filenames: `lead-platform-api.openapi.json|yaml` → `idap-api.openapi.json|yaml`; the `openapi-typescript` snippet output name → `idap-api.d.ts`.

- [ ] **Step 1: Write the failing test**

`tests/unit/openapi-profile.test.ts` (4 cases): unscoped document contains `/api/public/{institutionId}/profile` and `/api/public/institutions/{slug}`; scoped document renders the concrete paths (`/api/public/INS0001/profile`, and the slug path with the real slug when provided); both new operations carry `security: []`; `info.title` is `"I-DAP API"` unscoped.

- [ ] **Step 2: Run, confirm failure. Step 3: Implement all four changes. Step 4: Green + `npm test` (272 total) + `npx tsc --noEmit`.**

- [ ] **Step 5: Visual spot-check**

Restart the dev server (schema unchanged in this task, but the rename touches the shell) and confirm: login page shows I-DAP, sidebar shows I-DAP, `curl /api/v1/openapi.json | head` shows the new title.

- [ ] **Step 6: Commit**

```bash
git add -A src tests/unit/openapi-profile.test.ts
git commit -m "feat: public profile endpoints in the OpenAPI document; rename to I-DAP

Every institution's downloadable spec now describes the profile API —
create once, publish everywhere, applied to the documentation itself."
```

---

## Task 12: Dashboard cards and navigation

**Files:**
- Modify: `src/components/dashboard/nav-config.ts` (add Institution Profile item)
- Modify: `src/app/(dashboard)/dashboard/page.tsx` (completion + integration cards)
- Modify: `src/services/dashboard.service.ts` (extend `getStats` return with profile + credential summary)
- Test: `tests/integration/dashboard-profile.test.ts` (create)

**Interfaces:**
- Consumes: `calculateCompletion` (via `InstitutionService.getProfile`), `ApiClient` model (count active credentials + max `lastUsedAt` — check the model for the exact field name before writing the query; if no last-used field exists, show count only and note it in the report).
- Produces: `DashboardService.getStats` return type gains `{ profile: { status: ProfileStatus; completionPercent: number }; integration: { activeCredentials: number; lastUsedAt?: string } }`.

Layout: the institute dashboard gains a row of two cards above the existing stats — **Profile** (completion %, status badge, link to `/profile`) and **Integration** (active credentials, last used, link to `/integration`). Existing enquiry/application cards unchanged. The platform-admin dashboard (`getPlatformStats`) is untouched — recent enquiries/applications lists must not appear there.

Nav: `{ href: "/profile", label: "Institution Profile", icon: Building2 }` inserted **first** in the second `INSTITUTION_NAV` group (above Integration). `SUPER_ADMIN_NAV` unchanged.

- [ ] **Step 1: Failing test** — `getStats` for a tenant returns `profile.completionPercent` as a number and `integration.activeCredentials` counting only `active: true` credentials of **that** institution (create credentials for two institutions; assert cross-tenant count is not included).
- [ ] **Step 2–3: Run, fail, implement.** `getStats` already receives `tenantClause` — reuse it for the ApiClient count. Fetch the institution row once for status + completion.
- [ ] **Step 4: Suite** — `npm test` (274 total), `npx tsc --noEmit`, then a manual look at `http://localhost:3000/dashboard`.
- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/nav-config.ts src/app/\(dashboard\)/dashboard/page.tsx src/services/dashboard.service.ts tests/integration/dashboard-profile.test.ts
git commit -m "feat: profile and integration cards on the institution dashboard"
```

---

## Task 13: The profile editor UI

**Files:**
- Create: `src/app/(dashboard)/profile/page.tsx`
- Create: `src/components/profile/profile-editor.tsx` (client shell: section nav, dirty guard, completion meter)
- Create: `src/components/profile/sections/{basic,contact,address,academic,management,facilities,social,gallery}-section.tsx`
- Create: `src/components/profile/publish-dialog.tsx`
- Create: `src/components/profile/completion-meter.tsx`
- Test: manual + typecheck (UI task; the API beneath it is already covered)

**Interfaces:**
- Consumes: `GET/PATCH /api/settings/institution`, `POST .../publish`, `POST .../media`, `DELETE .../media/:id`; `SUGGESTED_FACILITIES` from `src/lib/profile/facilities.ts`; shadcn components already in `src/components/ui`; `react-hook-form` + `zodResolver` with the **same** `updateProfileSchema` imported client-side (single source of validation).
- Produces: the `/profile` screen.

Design constraints (monochrome, existing patterns — study `src/components/leads` and `src/components/integration` for form and toast idioms before writing):

- Left column: section list with per-section completeness ticks (derived from the `completion.groups` payload — the server's numbers, not a client recalculation). Right: the active section's form. On mobile the section list collapses to a select.
- Each section is its own `react-hook-form` instance with explicit **Save section** button; save PATCHes only that section's fields, then refreshes profile + completion from the response. Dirty state guards section switches (confirm dialog).
- Facilities: suggested list as toggle chips + a free-form add (code auto-derived, uppercased, from the label); note field per facility.
- Gallery: grid of thumbnails, upload button (client-side type/size check before POST), per-item hide/show + delete with confirm. Empty state invites the first upload.
- Header: status badge (`DRAFT`/`PUBLISHED`), completion meter, Publish/Unpublish button opening `publish-dialog` — which lists exactly what goes public (name, address, contact, academics, facilities, gallery) and requires an explicit confirm. Publishing below 100% is allowed; the dialog shows the missing list as information, not a blocker.
- Loading skeletons, error toasts via `sonner`, every image gets `alt` text from its title.

- [ ] **Step 1: Build the shell + basic section end-to-end** (page → GET → form → PATCH → toast → meter updates). Verify in the browser with the seeded institution before writing the other sections.
- [ ] **Step 2: Remaining seven sections**, one commit-worthy pass; reuse the field-row composition the first section established.
- [ ] **Step 3: Publish flow + gallery.**
- [ ] **Step 4: Verify** — `npx tsc --noEmit`, `npm run lint`, `npm test` (unchanged, 274), and a manual walkthrough: edit each section, upload logo + two gallery images, hide one, publish, `curl` the public endpoint and see the changes; unpublish, `curl` again, get 404.
- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/profile src/components/profile
git commit -m "feat: multi-section institution profile editor

Eight sections, each its own form and save; server-computed completion
throughout; publish is an explicit, informed action."
```

---

## Task 14: Documentation, seed, and the final regression gate

**Files:**
- Create: `docs/api/institution-profile.md`
- Create: `docs/architecture/institution-master-identity.md`
- Modify: `README.md` (product name, profile feature, backfill instructions)
- Modify: `scripts/seed.ts` (seeded institutions gain slugs + a few profile fields so dev screens aren't empty)
- Modify: `tests/helpers/factories.ts` — **only additively**: a new `makeProfiledInstitution` helper; `makeInstitution` itself is untouched (existing tests depend on its exact shape)

**Steps:**

- [ ] **Step 1: API doc** — every new endpoint: method, path, auth, request, response, error codes, with `curl` examples using `INS0001`. Public endpoints documented as consumable by any website.
- [ ] **Step 2: Architecture doc** — the master-identity diagram (Institution → Profile/Lead Network → API → consumers), the public/private projection rule, the two-flag status model, the slug contract, and the §7 storage split with its cost note.
- [ ] **Step 3: Seed + backfill** — extend `seed.ts` (idempotent, as it is today); run `npx tsx scripts/backfill-slugs.ts --apply` locally; document the same command as a required production step.
- [ ] **Step 4: The full gate** — in order, all must pass:
  1. `npx tsc --noEmit`
  2. `npm run lint`
  3. `npm test` — every test, none of the original 214 modified
  4. `npm run build`
  5. Manual: log in as institution admin → edit profile → publish → public endpoint serves it; platform admin sees the profile read-only; `bash scripts/acceptance-test.sh` still passes (Lead Network regression).
- [ ] **Step 5: Commit**

```bash
git add docs README.md scripts/seed.ts tests/helpers/factories.ts
git commit -m "docs: institution profile API and master-identity architecture

Phase 1 complete: profile, publish, public API, dashboard, docs."
```

---

## Execution notes

- Tasks 1–7 are strictly sequential (each consumes the previous). Tasks 8, 9, 10 depend on 7 but not on each other. 11 depends on 10; 12 on 7; 13 on 8; 14 last.
- After every task that touches `src/models/`, **restart the dev server** before any manual verification.
- Expected test counts are waypoints, not contracts — a task legitimately adding one more case is fine; a task *reducing* the count is not.
- Production rollout order: deploy → run `backfill-slugs.ts --apply` against Atlas → verify the public endpoint 404s for the (still-draft) institutions. Existing institutions stay DRAFT until their admins publish — that is correct behaviour, not a bug.
