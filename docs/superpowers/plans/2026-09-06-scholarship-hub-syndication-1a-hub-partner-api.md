# Scholarship Hub Syndication — Plan 1A: Hub Partner Ingestion API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an idempotent, key-authenticated partner-ingestion API to the Scholarship Hub so a trusted partner platform (IDAP) can provision a provider and upsert/withdraw that provider's scholarship listings machine-to-machine.

**Architecture:** A new `Partner` credential (hashed `sh_pkey_…`) authenticated by a `requirePartner` middleware guards a new `/api/partner/*` module. Partner-owned provider orgs are auto-verified and partner-trusted; partner scholarship writes upsert by a new unique `externalRef` and publish directly through the SAME completeness gate human providers face, while Hub admins retain a moderation hold that a partner write cannot override.

**Tech Stack:** Node ≥24, Express, Mongoose, Zod, the repo's shared `packages/shared` vocabulary, Vitest, the existing `scripts/journeys/*` HTTP walkers.

**Spec:** `/Users/automicai/AEMPlatform/docs/superpowers/specs/2026-09-06-scholarship-hub-syndication-design.md` (this plan implements spec §3, §4.1, §4.3, §6, and the Hub portions of §8, §9, §10, §11). This plan lives in the IDAP repo for continuity, but **all code it produces is in `/Users/automicai/scholarship-hub`.**

## Global Constraints

- All work is in the Scholarship Hub repo `/Users/automicai/scholarship-hub`. Do not touch IDAP, PassPercent, FeesBasket, or eduFleet.
- Partner key format is `sh_pkey_` + 48 hex chars; stored **hashed only**, compared by hash, never logged. A prefix guard must reject any non-`sh_pkey_` token (a user access/refresh token can never authenticate as a partner).
- Provider externalRef = `IDAP:{institutionId}`. Scholarship externalRef = `IDAP:{institutionId}:{scholarshipId}`.
- Scholarship `externalRef` is **unique + sparse** (human-authored listings have none).
- Ownership on every partner endpoint is derived from the authenticated partner + the institution segment of the externalRef — **never** from the request body.
- Partner scholarship publish runs the existing `missingScholarshipFields` gate unchanged; incomplete → HTTP 422 with the missing-field list. It must not weaken the gate human providers pass.
- A partner PUT against an admin-held listing (`moderationHold` / status `suspended`) returns BLOCKED — it must not silently re-publish over the admin.
- Human-provider verification, submit-for-review, and admin-publish flows must remain unchanged and their existing tests green.
- The Hub's public discovery read routes must not change; `externalRef`/`partnerId`/`moderationHold` are internal and never publicly projected.
- Every task ends green: `npm run test -w @scholarship-hub/api` (and `-w @scholarship-hub/shared` where the change is in shared) plus `npm run typecheck`.

---

## File Structure

**Create (Hub repo):**
- `apps/api/src/modules/partner/partner.model.ts` — the `Partner` credential model.
- `apps/api/src/lib/partner-key.ts` — generate/parse/hash `sh_pkey_…` keys (reusing the existing prefix-guard helper).
- `apps/api/src/middleware/partner-auth.ts` — `requirePartner`.
- `apps/api/src/modules/partner/partner.service.ts` — provider upsert, scholarship upsert, withdraw (the only place partner writes touch models).
- `apps/api/src/modules/partner/partner.routes.ts` — the three `/api/partner/*` endpoints.
- `apps/api/src/modules/partner/partner.validation.ts` — Zod bodies for the partner endpoints (or colocated in `packages/shared` if that is where the repo keeps schemas — confirm at implementation).
- `scripts/mint-partner-key.ts` — a one-off CLI to create a Partner row and print its plaintext key once.
- `scripts/journeys/partner.ts` — end-to-end HTTP journey.
- Test files colocated per the repo's convention for each of the above.

**Modify (Hub repo):**
- provider model — add `externalRef` (unique sparse), `partnerId`, `partnerTrusted`.
- scholarship model — add `externalRef` (unique sparse), `partnerId`, `moderationHold`.
- `apps/api/src/modules/router.ts` — mount `/api/partner`.
- `package.json` — add `journey:partner` (and `mint:partner-key` if scripts are exposed there).

---

## Tasks (overview — full bodies below)

1. **Partner model + key utility + mint CLI** — the credential and its hashing, plus a way to create one.
2. **`requirePartner` middleware** — authenticate a partner from the hashed key.
3. **Model field additions** — provider and scholarship gain externalRef/partner ownership + moderation hold, with index behavior tested.
4. **Provider upsert (service + `POST /api/partner/providers`)** — auto-verified, partner-trusted provisioning.
5. **Scholarship idempotent upsert (service + `PUT /api/partner/scholarships/:externalRef`)** — the core: upsert by externalRef, gate, direct publish, moderation-hold → BLOCKED.
6. **Withdraw (service + `DELETE /api/partner/scholarships/:externalRef`)** — idempotent close.
7. **Router mount + `journey:partner`** — wire the module and prove the full arc over real HTTP.

---

All paths below are relative to `/Users/automicai/scholarship-hub`. Run commands with that repo as the working directory.

---

### Task 1: Partner credential — key utility + model

**Files:**
- Create: `apps/api/src/lib/partner-key.ts`
- Create: `apps/api/src/modules/partner/partner.model.ts`
- Test: `apps/api/src/lib/partner-key.test.ts`, `apps/api/src/modules/partner/partner.model.test.ts`

**Interfaces:**
- Produces: `PARTNER_KEY_PREFIX: string`; `generatePartnerKey(): { key: string; keyHash: string }`; `hashPartnerKey(key: string): string`; `hasPartnerKeyPrefix(value: string): boolean`; `PartnerModel`; `interface PartnerDoc`.

- [ ] **Step 1: Write the failing unit test for the key utility**

`apps/api/src/lib/partner-key.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  PARTNER_KEY_PREFIX,
  generatePartnerKey,
  hashPartnerKey,
  hasPartnerKeyPrefix,
} from './partner-key';

describe('partner-key', () => {
  it('generates a prefixed 48-hex key and a stable sha256 hash', () => {
    const { key, keyHash } = generatePartnerKey();
    expect(key.startsWith(PARTNER_KEY_PREFIX)).toBe(true);
    expect(key).toHaveLength(PARTNER_KEY_PREFIX.length + 48);
    expect(keyHash).toBe(hashPartnerKey(key));
    expect(keyHash).toHaveLength(64); // sha256 hex
  });

  it('hashes deterministically and distinctly', () => {
    const a = generatePartnerKey();
    const b = generatePartnerKey();
    expect(hashPartnerKey(a.key)).toBe(a.keyHash);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  it('accepts only a well-formed partner key (rejects JWTs and wrong lengths)', () => {
    expect(hasPartnerKeyPrefix(generatePartnerKey().key)).toBe(true);
    expect(hasPartnerKeyPrefix('eyJhbGciOiJIUzI1NiJ9.foo.bar')).toBe(false);
    expect(hasPartnerKeyPrefix(PARTNER_KEY_PREFIX + 'short')).toBe(false);
    expect(hasPartnerKeyPrefix('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm run test -w @scholarship-hub/api -- src/lib/partner-key.test.ts`
Expected: FAIL — cannot resolve `./partner-key`.

- [ ] **Step 3: Implement the key utility**

`apps/api/src/lib/partner-key.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';

/** All partner keys carry this prefix so a user JWT can never be mistaken for one. */
export const PARTNER_KEY_PREFIX = 'sh_pkey_';
const KEY_BODY_HEX = 48; // 24 random bytes → 192 bits of entropy

export function generatePartnerKey(): { key: string; keyHash: string } {
  const key = PARTNER_KEY_PREFIX + randomBytes(24).toString('hex');
  return { key, keyHash: hashPartnerKey(key) };
}

/**
 * Deterministic, unsalted sha256 — chosen over bcrypt on purpose: the key is
 * a 192-bit random secret (no dictionary risk), and a deterministic digest is
 * what lets `requirePartner` find the row with one indexed lookup.
 */
export function hashPartnerKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function hasPartnerKeyPrefix(value: string): boolean {
  return value.startsWith(PARTNER_KEY_PREFIX) && value.length === PARTNER_KEY_PREFIX.length + KEY_BODY_HEX;
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm run test -w @scholarship-hub/api -- src/lib/partner-key.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing model test**

`apps/api/src/modules/partner/partner.model.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { PartnerModel } from './partner.model';
import { generatePartnerKey } from '../../lib/partner-key';

describe('PartnerModel', () => {
  it('stores a partner and rejects a duplicate keyHash', async () => {
    const { keyHash } = generatePartnerKey();
    await PartnerModel.create({ name: 'IDAP', keyHash });
    const created = await PartnerModel.findOne({ keyHash }).lean();
    expect(created?.active).toBe(true); // default
    await expect(PartnerModel.create({ name: 'IDAP again', keyHash })).rejects.toMatchObject({ code: 11000 });
  });
});
```

- [ ] **Step 6: Run it — verify it fails**

Run: `npm run test -w @scholarship-hub/api -- src/modules/partner/partner.model.test.ts`
Expected: FAIL — cannot resolve `./partner.model`.

- [ ] **Step 7: Implement the model**

`apps/api/src/modules/partner/partner.model.ts`:
```ts
import { model, Schema, type Types } from 'mongoose';

const partnerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    keyHash: { type: String, required: true, unique: true },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: 'partners' },
);

export const PartnerModel = model('Partner', partnerSchema);

export interface PartnerDoc {
  _id: Types.ObjectId;
  name: string;
  keyHash: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 8: Run it — verify it passes**

Run: `npm run test -w @scholarship-hub/api -- src/modules/partner/partner.model.test.ts`
Expected: PASS. (The harness `syncIndexes()` in `beforeAll` builds the unique index because the model self-registers on import.)

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/lib/partner-key.ts apps/api/src/lib/partner-key.test.ts apps/api/src/modules/partner/partner.model.ts apps/api/src/modules/partner/partner.model.test.ts
git commit -m "feat(api): add Partner credential model and sh_pkey key utility"
```

---

### Task 2: `requirePartner` middleware

**Files:**
- Create: `apps/api/src/middleware/partner-auth.ts`
- Test: `apps/api/src/middleware/partner-auth.test.ts`

**Interfaces:**
- Consumes: `hashPartnerKey`, `hasPartnerKeyPrefix` (Task 1); `PartnerModel` (Task 1); `unauthorized` (`../lib/errors`).
- Produces: `interface PartnerAuth { id: string; name: string }`; `interface PartnerLocals { partner: PartnerAuth }`; `requirePartner: RequestHandler`; `partnerKeyFromRequest(req): string | null`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/middleware/partner-auth.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { requirePartner, type PartnerLocals } from './partner-auth';
import { PartnerModel } from '../modules/partner/partner.model';
import { generatePartnerKey } from '../lib/partner-key';
import { AppError } from '../lib/errors';

function ctx(authHeader?: string) {
  const req = { header: (n: string) => (n.toLowerCase() === 'authorization' ? authHeader : undefined) } as unknown as Request;
  const res = { locals: {} } as unknown as Response;
  return { req, res };
}
async function runMiddleware(authHeader?: string) {
  const { req, res } = ctx(authHeader);
  let error: unknown;
  await requirePartner(req, res, (err?: unknown) => { error = err; });
  return { res, error };
}

describe('requirePartner', () => {
  it('sets res.locals.partner for a valid active key', async () => {
    const { key, keyHash } = generatePartnerKey();
    const p = await PartnerModel.create({ name: 'IDAP', keyHash });
    const { res, error } = await runMiddleware(`Bearer ${key}`);
    expect(error).toBeUndefined();
    expect((res.locals as PartnerLocals).partner).toEqual({ id: String(p._id), name: 'IDAP' });
  });

  it('rejects a missing, malformed, unknown, or inactive key with 401', async () => {
    expect((await runMiddleware(undefined)).error).toBeInstanceOf(AppError);
    expect((await runMiddleware('Bearer eyJ.notapartnerkey.x')).error).toBeInstanceOf(AppError);
    expect((await runMiddleware(`Bearer ${generatePartnerKey().key}`)).error).toBeInstanceOf(AppError); // unknown
    const { key, keyHash } = generatePartnerKey();
    await PartnerModel.create({ name: 'Disabled', keyHash, active: false });
    expect((await runMiddleware(`Bearer ${key}`)).error).toBeInstanceOf(AppError);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm run test -w @scholarship-hub/api -- src/middleware/partner-auth.test.ts`
Expected: FAIL — cannot resolve `./partner-auth`.

- [ ] **Step 3: Implement the middleware**

`apps/api/src/middleware/partner-auth.ts`:
```ts
import type { Request, RequestHandler } from 'express';
import { unauthorized } from '../lib/errors';
import { hashPartnerKey, hasPartnerKeyPrefix } from '../lib/partner-key';
import { PartnerModel } from '../modules/partner/partner.model';

export interface PartnerAuth {
  id: string;
  name: string;
}
export interface PartnerLocals {
  partner: PartnerAuth;
}

export function partnerKeyFromRequest(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) return null;
  return value;
}

export const requirePartner: RequestHandler = async (req, res, next) => {
  const key = partnerKeyFromRequest(req);
  // Prefix guard runs before any DB work — a user JWT never reaches the lookup.
  if (!key || !hasPartnerKeyPrefix(key)) {
    next(unauthorized());
    return;
  }
  const partner = await PartnerModel.findOne({ keyHash: hashPartnerKey(key), active: true })
    .select('_id name')
    .lean<{ _id: { toString(): string }; name: string } | null>();
  if (!partner) {
    next(unauthorized());
    return;
  }
  (res.locals as PartnerLocals).partner = { id: String(partner._id), name: partner.name };
  next();
};
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm run test -w @scholarship-hub/api -- src/middleware/partner-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/partner-auth.ts apps/api/src/middleware/partner-auth.test.ts
git commit -m "feat(api): add requirePartner middleware for sh_pkey auth"
```

---

### Task 3: Model field additions (provider + scholarship)

**Files:**
- Modify: `apps/api/src/modules/providers/provider.model.ts` — add `externalRef`, `partnerId`, `partnerTrusted` (schema + `ProviderDoc`).
- Modify: `apps/api/src/modules/scholarships/scholarship.model.ts` — add `externalRef`, `partnerId`, `moderationHold` (schema + `ScholarshipDoc`).
- Test: `apps/api/src/modules/partner/partner.model-fields.test.ts`

**Interfaces:**
- Produces: `Scholarship.externalRef?: string` (unique+sparse), `Scholarship.partnerId?: ObjectId`, `Scholarship.moderationHold?: boolean`; `Provider.externalRef?: string` (unique+sparse), `Provider.partnerId?: ObjectId`, `Provider.partnerTrusted?: boolean`. These are consumed by Tasks 4–6.

- [ ] **Step 1: Write the failing test**

`apps/api/src/modules/partner/partner.model-fields.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { ScholarshipModel } from '../scholarships/scholarship.model';
import { ProviderModel } from '../providers/provider.model';

const ref = () => `IDAP:INS0001:${new Types.ObjectId().toHexString()}`;

describe('partner ownership fields', () => {
  it('allows many listings with no externalRef but rejects a duplicate one', async () => {
    const pid = new Types.ObjectId();
    await ScholarshipModel.create({ providerId: pid, title: 'No Ref One', slug: `nr1-${Date.now()}` });
    await ScholarshipModel.create({ providerId: pid, title: 'No Ref Two', slug: `nr2-${Date.now()}` });
    const dupe = ref();
    await ScholarshipModel.create({ providerId: pid, title: 'Ref One', slug: `r1-${Date.now()}`, externalRef: dupe });
    await expect(
      ScholarshipModel.create({ providerId: pid, title: 'Ref Two', slug: `r2-${Date.now()}`, externalRef: dupe }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('persists provider partner-trust fields and moderationHold defaults false', async () => {
    const prov = await ProviderModel.create({
      name: 'Infinity School', slug: `infinity-${Date.now()}`, type: 'trust',
      externalRef: 'IDAP:INS0001', partnerTrusted: true, verificationStatus: 'verified',
    });
    expect(prov.partnerTrusted).toBe(true);
    const sch = await ScholarshipModel.create({ providerId: prov._id, title: 'Held Grant', slug: `hg-${Date.now()}` });
    expect(sch.moderationHold).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm run test -w @scholarship-hub/api -- src/modules/partner/partner.model-fields.test.ts`
Expected: FAIL — duplicate `externalRef` is accepted (no unique index yet) and/or `partnerTrusted` is not persisted.

- [ ] **Step 3: Add fields to the provider model**

In `apps/api/src/modules/providers/provider.model.ts`, add to the schema body (follow the existing `createdByUserId` / `isGovernment` style):
```ts
    externalRef: { type: String, trim: true },
    partnerId: { type: Schema.Types.ObjectId, ref: 'Partner' },
    partnerTrusted: { type: Boolean, required: true, default: false },
```
Add after the existing `providerSchema.index(...)` lines:
```ts
providerSchema.index({ externalRef: 1 }, { unique: true, sparse: true });
```
Add the matching keys to `interface ProviderDoc`:
```ts
  externalRef?: string;
  partnerId?: Types.ObjectId;
  partnerTrusted: boolean;
```

- [ ] **Step 4: Add fields to the scholarship model**

In `apps/api/src/modules/scholarships/scholarship.model.ts`, add to the schema body (put `moderationHold` beside `cascadeSuspendedAt`):
```ts
    externalRef: { type: String, trim: true },
    partnerId: { type: Schema.Types.ObjectId, ref: 'Partner' },
    moderationHold: { type: Boolean, required: true, default: false },
```
Add after the existing `scholarshipSchema.index(...)` lines:
```ts
scholarshipSchema.index({ externalRef: 1 }, { unique: true, sparse: true });
```
Add the matching keys to `interface ScholarshipDoc`:
```ts
  externalRef?: string;
  partnerId?: Types.ObjectId;
  moderationHold: boolean;
```
Do NOT add these to any public projection or DTO mapper — they are internal (spec §6.5).

- [ ] **Step 5: Run it — verify it passes**

Run: `npm run test -w @scholarship-hub/api -- src/modules/partner/partner.model-fields.test.ts`
Expected: PASS.

- [ ] **Step 6: Guard against a public leak — run the existing projection/detail tests**

Run: `npm run test -w @scholarship-hub/api -- src/modules/scholarships`
Expected: PASS (existing scholarship read/projection tests unchanged — proves the new internal fields did not enter any public shape).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/providers/provider.model.ts apps/api/src/modules/scholarships/scholarship.model.ts apps/api/src/modules/partner/partner.model-fields.test.ts
git commit -m "feat(api): add partner ownership + externalRef + moderationHold to provider/scholarship"
```

---

### Task 4: Provider upsert — service + `POST /api/partner/providers` + router mount

**Files:**
- Create: `apps/api/src/modules/partner/partner.validation.ts`
- Create: `apps/api/src/modules/partner/partner.service.ts`
- Create: `apps/api/src/modules/partner/partner.routes.ts`
- Modify: `apps/api/src/modules/router.ts` — mount `/partner`
- Test: `apps/api/src/modules/partner/partner.providers.test.ts`

**Interfaces:**
- Consumes: `requirePartner`, `PartnerLocals` (Task 2); `validate`, `ValidatedLocals` (`../../middleware/validate`); `ProviderModel` (Task 3); `AppError` (`../../lib/errors`); `PROVIDER_TYPES` (`@scholarship-hub/shared`).
- Produces: `partnerProviderSchema` + `PartnerProviderInput`; `upsertPartnerProvider(partnerId: string, input: PartnerProviderInput): Promise<{ providerId: string }>`; `partnerRoutes` (an Express `Router`, extended in Tasks 5–6); the mounted prefix `/api/partner`.

- [ ] **Step 1: Write the failing integration test**

`apps/api/src/modules/partner/partner.providers.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import request from 'supertest';
import { createApp } from '../../app';
import { startTestServer, stopTestServer } from '../../test/setup';
import { PartnerModel } from './partner.model';
import { ProviderModel } from '../providers/provider.model';
import { generatePartnerKey } from '../../lib/partner-key';

let server: Server;
beforeAll(async () => { server = await startTestServer(createApp()); });
afterAll(async () => { await stopTestServer(server); });

async function makePartner(name = 'IDAP') {
  const { key, keyHash } = generatePartnerKey();
  const p = await PartnerModel.create({ name, keyHash });
  return { key, id: String(p._id) };
}
const auth = (key: string) => `Bearer ${key}`;

describe('POST /api/partner/providers', () => {
  it('provisions an auto-verified, partner-trusted provider and is idempotent by externalRef', async () => {
    const partner = await makePartner();
    const body = { externalRef: 'IDAP:INS0001', name: 'Infinity School of Excellence', city: 'Mysuru', stateCode: 'KA', type: 'trust' };
    const first = await request(server).post('/api/partner/providers').set('Authorization', auth(partner.key)).send(body).expect(200);
    const providerId = (first.body as { providerId: string }).providerId;
    const stored = await ProviderModel.findById(providerId).lean();
    expect(stored?.verificationStatus).toBe('verified');
    expect(stored?.partnerTrusted).toBe(true);
    expect(String(stored?.partnerId)).toBe(partner.id);

    const second = await request(server).post('/api/partner/providers').set('Authorization', auth(partner.key)).send({ ...body, name: 'Infinity School (renamed)' }).expect(200);
    expect((second.body as { providerId: string }).providerId).toBe(providerId); // same row
    expect((await ProviderModel.findById(providerId).lean())?.name).toBe('Infinity School (renamed)');
  });

  it('rejects an unauthenticated or malformed-key request with 401', async () => {
    await request(server).post('/api/partner/providers').send({ externalRef: 'IDAP:INS0001', name: 'X' }).expect(401);
    await request(server).post('/api/partner/providers').set('Authorization', 'Bearer eyJ.not.partner').send({ externalRef: 'IDAP:INS0001', name: 'X' }).expect(401);
  });

  it('rejects a malformed body with 400', async () => {
    const partner = await makePartner();
    await request(server).post('/api/partner/providers').set('Authorization', auth(partner.key)).send({ externalRef: 'nope', name: 'X' }).expect(400);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm run test -w @scholarship-hub/api -- src/modules/partner/partner.providers.test.ts`
Expected: FAIL — `/api/partner/providers` 404 (not mounted).

- [ ] **Step 3: Write the validation schema**

`apps/api/src/modules/partner/partner.validation.ts`:
```ts
import { z } from 'zod';
import { PROVIDER_TYPES } from '@scholarship-hub/shared';

export const partnerProviderSchema = z.object({
  externalRef: z.string().regex(/^IDAP:[A-Za-z0-9]+$/, 'externalRef must be "IDAP:{institutionId}"'),
  name: z.string().trim().min(3).max(200),
  city: z.string().trim().max(120).optional(),
  stateCode: z.string().trim().length(2).optional(),
  type: z.enum(PROVIDER_TYPES).optional(),
});
export type PartnerProviderInput = z.infer<typeof partnerProviderSchema>;

/** externalRef of a scholarship push, validated on the URL param (Task 5/6). */
export const externalRefParams = z.object({
  externalRef: z.string().regex(/^IDAP:[A-Za-z0-9]+:[a-f0-9]{24}$/, 'externalRef must be "IDAP:{institutionId}:{scholarshipId}"'),
});
export type ExternalRefParams = z.infer<typeof externalRefParams>;
```

- [ ] **Step 4: Write the provider-upsert service**

`apps/api/src/modules/partner/partner.service.ts`:
```ts
import { Types } from 'mongoose';
import { ProviderModel } from '../providers/provider.model';
import type { PartnerProviderInput } from './partner.validation';

/** Deterministic, collision-free provider slug from the institution id in the ref. */
function providerSlugFor(externalRef: string): string {
  const institutionId = externalRef.split(':')[1] ?? '';
  return `idap-${institutionId.toLowerCase()}`;
}

export async function upsertPartnerProvider(
  partnerId: string,
  input: PartnerProviderInput,
): Promise<{ providerId: string }> {
  const owner = new Types.ObjectId(partnerId);
  const doc = await ProviderModel.findOneAndUpdate(
    { externalRef: input.externalRef, partnerId: owner },
    {
      $set: {
        name: input.name,
        type: input.type ?? 'trust',
        verificationStatus: 'verified',
        partnerTrusted: true,
        partnerId: owner,
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.stateCode !== undefined ? { stateCode: input.stateCode } : {}),
      },
      $setOnInsert: { externalRef: input.externalRef, slug: providerSlugFor(input.externalRef) },
    },
    { new: true, upsert: true, projection: { _id: 1 } },
  );
  return { providerId: String(doc._id) };
}
```
> Note: if the provider schema has no `city`/`stateCode` paths, drop those two spread lines — confirm against `provider.model.ts` (they are optional to the contract).

- [ ] **Step 5: Write the route module + mount it**

`apps/api/src/modules/partner/partner.routes.ts`:
```ts
import { Router } from 'express';
import { validate, type ValidatedLocals } from '../../middleware/validate';
import { requirePartner, type PartnerLocals } from '../../middleware/partner-auth';
import { partnerProviderSchema, type PartnerProviderInput } from './partner.validation';
import { upsertPartnerProvider } from './partner.service';

export const partnerRoutes = Router();

partnerRoutes.post('/providers', requirePartner, validate({ body: partnerProviderSchema }), async (_req, res) => {
  const { partner } = res.locals as PartnerLocals;
  const { body } = (res.locals as ValidatedLocals<PartnerProviderInput>).input;
  const result = await upsertPartnerProvider(partner.id, body);
  res.status(200).json(result);
});
```
In `apps/api/src/modules/router.ts`, import and mount **before** any catch-all (mirror the `/provider/*` ordering):
```ts
import { partnerRoutes } from './partner/partner.routes';
// ...
apiRouter.use('/partner', partnerRoutes);
```
> Confirm the exact generic arity of `ValidatedLocals` against `middleware/validate.ts`; it is `ValidatedLocals<TBody, TQuery, TParams>`.

- [ ] **Step 6: Run it — verify it passes**

Run: `npm run test -w @scholarship-hub/api -- src/modules/partner/partner.providers.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/partner/partner.validation.ts apps/api/src/modules/partner/partner.service.ts apps/api/src/modules/partner/partner.routes.ts apps/api/src/modules/router.ts apps/api/src/modules/partner/partner.providers.test.ts
git commit -m "feat(api): partner provider provisioning endpoint (POST /api/partner/providers)"
```

---

### Task 5: Scholarship idempotent upsert — service + `PUT /api/partner/scholarships/:externalRef`

**Files:**
- Modify: `apps/api/src/modules/partner/partner.service.ts` — add `upsertPartnerScholarship`
- Modify: `apps/api/src/modules/scholarships/scholarship.write.service.ts` — export `generateScholarshipSlug` (one-line `export`; it already exists)
- Modify: `apps/api/src/modules/partner/partner.routes.ts` — add the PUT route
- Test: `apps/api/src/modules/partner/partner.scholarships.test.ts`

**Interfaces:**
- Consumes: `writableFields`, `generateScholarshipSlug` (`../scholarships/scholarship.write.service`); `missingScholarshipFields` (`@scholarship-hub/shared`); `ScholarshipModel` (Task 3); `ProviderModel`; `scholarshipDraftSchema` + `ScholarshipDraftInput` (`@scholarship-hub/shared`); `externalRefParams` (Task 4).
- Produces: `type ListingPushResult = { kind: 'OK'; hubId: string; slug: string; publicUrl: string; remoteStatus: 'published' } | { kind: 'BLOCKED'; reason: 'MODERATION_HOLD'; hubId: string }`; `upsertPartnerScholarship(partnerId, externalRef, input): Promise<ListingPushResult>`; the `PUT` route.

- [ ] **Step 1: Write the failing integration test**

`apps/api/src/modules/partner/partner.scholarships.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import request from 'supertest';
import { createApp } from '../../app';
import { startTestServer, stopTestServer } from '../../test/setup';
import { PartnerModel } from './partner.model';
import { ScholarshipModel } from '../scholarships/scholarship.model';
import { generatePartnerKey } from '../../lib/partner-key';

let server: Server;
beforeAll(async () => { server = await startTestServer(createApp()); });
afterAll(async () => { await stopTestServer(server); });

async function makePartner() {
  const { key, keyHash } = generatePartnerKey();
  const p = await PartnerModel.create({ name: 'IDAP', keyHash });
  return { key, id: String(p._id) };
}
const auth = (key: string) => `Bearer ${key}`;
const ID = '6a8f1a72017ca1920491b71a';
const REF = `IDAP:INS0001:${ID}`;

async function provisionProvider(key: string) {
  await request(server).post('/api/partner/providers').set('Authorization', auth(key))
    .send({ externalRef: 'IDAP:INS0001', name: 'Infinity School of Excellence', type: 'trust' }).expect(200);
}
function completeListing() {
  const closesAt = new Date(Date.now() + 30 * 864e5).toISOString();
  return {
    title: 'Infinity Merit Scholarship',
    summary: 'A merit award for high achievers.',
    description: 'This scholarship supports high-achieving students of Infinity School. '.repeat(6),
    categories: ['merit'],
    benefits: { amountText: 'Up to ₹50,000' },
    eligibility: { otherCriteria: ['Top 10% of the class'] },
    dates: { closesAt },
    applicationMode: 'platform',
    requiredDocuments: [{ key: 'marksheet', label: 'Latest marksheet', required: true }],
  };
}

describe('PUT /api/partner/scholarships/:externalRef', () => {
  it('publishes directly, upserts by externalRef, and is idempotent', async () => {
    const partner = await makePartner();
    await provisionProvider(partner.key);
    const first = await request(server).put(`/api/partner/scholarships/${REF}`).set('Authorization', auth(partner.key)).send(completeListing()).expect(200);
    const hubId = (first.body as { hubId: string }).hubId;
    let stored = await ScholarshipModel.findById(hubId).lean();
    expect(stored?.status).toBe('published');
    expect(stored?.externalRef).toBe(REF);

    const second = await request(server).put(`/api/partner/scholarships/${REF}`).set('Authorization', auth(partner.key)).send({ ...completeListing(), title: 'Infinity Merit Scholarship (2027)' }).expect(200);
    expect((second.body as { hubId: string }).hubId).toBe(hubId); // same listing
    stored = await ScholarshipModel.findById(hubId).lean();
    expect(stored?.title).toBe('Infinity Merit Scholarship (2027)');
    expect(await ScholarshipModel.countDocuments({ externalRef: REF })).toBe(1);
  });

  it('404s when the provider was not provisioned first', async () => {
    const partner = await makePartner();
    await request(server).put(`/api/partner/scholarships/${REF}`).set('Authorization', auth(partner.key)).send(completeListing()).expect(404);
  });

  it('422s an incomplete listing with the missing-field list', async () => {
    const partner = await makePartner();
    await provisionProvider(partner.key);
    const { dates, requiredDocuments, ...incomplete } = completeListing();
    const res = await request(server).put(`/api/partner/scholarships/${REF}`).set('Authorization', auth(partner.key)).send(incomplete).expect(422);
    expect((res.body as { error: { code: string; missing: unknown[] } }).error.code).toBe('INCOMPLETE');
    expect((res.body as { error: { missing: unknown[] } }).error.missing.length).toBeGreaterThan(0);
  });

  it('returns BLOCKED (409) and does not overwrite a listing on admin moderation hold', async () => {
    const partner = await makePartner();
    await provisionProvider(partner.key);
    const created = await request(server).put(`/api/partner/scholarships/${REF}`).set('Authorization', auth(partner.key)).send(completeListing()).expect(200);
    const hubId = (created.body as { hubId: string }).hubId;
    await ScholarshipModel.updateOne({ _id: hubId }, { $set: { moderationHold: true, title: 'ADMIN EDITED' } });
    await request(server).put(`/api/partner/scholarships/${REF}`).set('Authorization', auth(partner.key)).send({ ...completeListing(), title: 'partner retry' }).expect(409);
    expect((await ScholarshipModel.findById(hubId).lean())?.title).toBe('ADMIN EDITED'); // untouched
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm run test -w @scholarship-hub/api -- src/modules/partner/partner.scholarships.test.ts`
Expected: FAIL — `PUT /api/partner/scholarships/:externalRef` 404.

- [ ] **Step 3: Export the slug generator**

In `apps/api/src/modules/scholarships/scholarship.write.service.ts`, change `async function generateScholarshipSlug` to `export async function generateScholarshipSlug` (no behavior change). Confirm `writableFields` is already exported (it is).

- [ ] **Step 4: Add the scholarship-upsert service**

Append to `apps/api/src/modules/partner/partner.service.ts`:
```ts
import { missingScholarshipFields, type ScholarshipDraftInput } from '@scholarship-hub/shared';
import { ScholarshipModel } from '../scholarships/scholarship.model';
import { writableFields, generateScholarshipSlug } from '../scholarships/scholarship.write.service';
import { AppError, forbidden } from '../../lib/errors';
import { env } from '../../config/env'; // for PUBLIC_WEB_URL; confirm the exact env accessor

export type ListingPushResult =
  | { kind: 'OK'; hubId: string; slug: string; publicUrl: string; remoteStatus: 'published' }
  | { kind: 'BLOCKED'; reason: 'MODERATION_HOLD'; hubId: string };

const providerRefOf = (externalRef: string): string => externalRef.split(':').slice(0, 2).join(':');
const publicUrlFor = (slug: string): string => `${env.PUBLIC_WEB_URL ?? 'https://scholarshiphub.example'}/scholarships/${slug}`;

export async function upsertPartnerScholarship(
  partnerId: string,
  externalRef: string,
  input: ScholarshipDraftInput,
): Promise<ListingPushResult> {
  const owner = new Types.ObjectId(partnerId);

  const provider = await ProviderModel.findOne({ externalRef: providerRefOf(externalRef), partnerId: owner })
    .select('_id').lean<{ _id: Types.ObjectId } | null>();
  if (!provider) throw new AppError(404, 'PROVIDER_NOT_FOUND', 'Provision the provider before pushing a listing.');

  const existing = await ScholarshipModel.findOne({ externalRef })
    .select('_id partnerId moderationHold').lean<{ _id: Types.ObjectId; partnerId?: Types.ObjectId; moderationHold?: boolean } | null>();
  if (existing && String(existing.partnerId) !== partnerId) throw forbidden();
  if (existing?.moderationHold) return { kind: 'BLOCKED', reason: 'MODERATION_HOLD', hubId: String(existing._id) };

  const fields = writableFields(input);
  const gate = missingScholarshipFields({ ...fields, applicationMode: fields.applicationMode ?? 'platform' }, new Date());
  if (gate.length > 0) throw new AppError(422, 'INCOMPLETE', 'Listing is not publishable.', { missing: gate });

  const slug = existing ? undefined : (await generateScholarshipSlug(input.title)).slug;
  const doc = await ScholarshipModel.findOneAndUpdate(
    { externalRef },
    {
      $set: { ...fields, status: 'published', partnerId: owner, providerId: provider._id },
      $setOnInsert: { externalRef, ...(slug ? { slug } : {}) },
    },
    { new: true, upsert: true, projection: { _id: 1, slug: 1 } },
  ).lean<{ _id: Types.ObjectId; slug: string }>();

  return { kind: 'OK', hubId: String(doc._id), slug: doc.slug, publicUrl: publicUrlFor(doc.slug), remoteStatus: 'published' };
}
```
> The `findOneAndUpdate` pre-hook keeps the denormalised `sortClosesAt` in step (the model registers `pre(['findOneAndUpdate', ...])`), so this path — unlike `bulkWrite` — needs no manual `withSortClosesAt`. Confirm the `env.PUBLIC_WEB_URL` accessor name against `apps/api/src/config/env.ts`; if none exists, hardcode the deployed web origin and leave a `// TODO(ops): move to env` — the URL is display-only.

- [ ] **Step 5: Add the PUT route**

In `apps/api/src/modules/partner/partner.routes.ts`, add imports and the route:
```ts
import { scholarshipDraftSchema, type ScholarshipDraftInput } from '@scholarship-hub/shared';
import { externalRefParams, type ExternalRefParams } from './partner.validation';
import { upsertPartnerScholarship } from './partner.service';

partnerRoutes.put('/scholarships/:externalRef', requirePartner,
  validate({ params: externalRefParams, body: scholarshipDraftSchema }),
  async (_req, res) => {
    const { partner } = res.locals as PartnerLocals;
    const { params, body } = (res.locals as ValidatedLocals<ScholarshipDraftInput, unknown, ExternalRefParams>).input;
    const result = await upsertPartnerScholarship(partner.id, params.externalRef, body);
    if (result.kind === 'BLOCKED') {
      res.status(409).json({ error: { code: 'MODERATION_HOLD', message: 'This listing is on administrative hold.' }, hubId: result.hubId });
      return;
    }
    res.status(200).json({ hubId: result.hubId, slug: result.slug, publicUrl: result.publicUrl, remoteStatus: result.remoteStatus });
  });
```

- [ ] **Step 6: Run it — verify it passes**

Run: `npm run test -w @scholarship-hub/api -- src/modules/partner/partner.scholarships.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/partner/partner.service.ts apps/api/src/modules/partner/partner.routes.ts apps/api/src/modules/scholarships/scholarship.write.service.ts apps/api/src/modules/partner/partner.scholarships.test.ts
git commit -m "feat(api): idempotent partner scholarship upsert (PUT /api/partner/scholarships/:ref)"
```

---

### Task 6: Withdraw — service + `DELETE /api/partner/scholarships/:externalRef`

**Files:**
- Modify: `apps/api/src/modules/partner/partner.service.ts` — add `withdrawPartnerScholarship`
- Modify: `apps/api/src/modules/partner/partner.routes.ts` — add the DELETE route
- Test: `apps/api/src/modules/partner/partner.withdraw.test.ts`

**Interfaces:**
- Produces: `type WithdrawResult = { kind: 'OK'; hubId: string; remoteStatus: 'closed' } | { kind: 'NOT_FOUND' }`; `withdrawPartnerScholarship(partnerId, externalRef): Promise<WithdrawResult>`; the `DELETE` route.

- [ ] **Step 1: Write the failing test**

`apps/api/src/modules/partner/partner.withdraw.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import request from 'supertest';
import { createApp } from '../../app';
import { startTestServer, stopTestServer } from '../../test/setup';
import { PartnerModel } from './partner.model';
import { ScholarshipModel } from '../scholarships/scholarship.model';
import { generatePartnerKey } from '../../lib/partner-key';

let server: Server;
beforeAll(async () => { server = await startTestServer(createApp()); });
afterAll(async () => { await stopTestServer(server); });

async function makePartner() {
  const { key, keyHash } = generatePartnerKey();
  await PartnerModel.create({ name: 'IDAP', keyHash });
  return key;
}
const auth = (key: string) => `Bearer ${key}`;
const REF = `IDAP:INS0001:6a8f1a72017ca1920491b71a`;
function completeListing() {
  return {
    title: 'Infinity Merit Scholarship', summary: 'Merit award.',
    description: 'Supports high achievers of Infinity School. '.repeat(6),
    categories: ['merit'], benefits: { amountText: 'Up to ₹50,000' },
    dates: { closesAt: new Date(Date.now() + 30 * 864e5).toISOString() },
    applicationMode: 'platform', requiredDocuments: [{ key: 'marksheet', label: 'Marksheet', required: true }],
  };
}
async function seedListing(key: string) {
  await request(server).post('/api/partner/providers').set('Authorization', auth(key)).send({ externalRef: 'IDAP:INS0001', name: 'Infinity School', type: 'trust' }).expect(200);
  return request(server).put(`/api/partner/scholarships/${REF}`).set('Authorization', auth(key)).send(completeListing()).expect(200);
}

describe('DELETE /api/partner/scholarships/:externalRef', () => {
  it('closes the listing and is idempotent', async () => {
    const key = await makePartner();
    const created = await seedListing(key);
    const hubId = (created.body as { hubId: string }).hubId;
    await request(server).delete(`/api/partner/scholarships/${REF}`).set('Authorization', auth(key)).expect(200);
    expect((await ScholarshipModel.findById(hubId).lean())?.status).toBe('closed');
    await request(server).delete(`/api/partner/scholarships/${REF}`).set('Authorization', auth(key)).expect(200); // idempotent
    expect((await ScholarshipModel.findById(hubId).lean())?.status).toBe('closed');
  });

  it('404s an unknown or non-owned externalRef', async () => {
    const key = await makePartner();
    await request(server).delete(`/api/partner/scholarships/${REF}`).set('Authorization', auth(key)).expect(404);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm run test -w @scholarship-hub/api -- src/modules/partner/partner.withdraw.test.ts`
Expected: FAIL — DELETE route 404 for a listing that WAS seeded (route not defined).

- [ ] **Step 3: Add the withdraw service**

Append to `apps/api/src/modules/partner/partner.service.ts`:
```ts
export type WithdrawResult = { kind: 'OK'; hubId: string; remoteStatus: 'closed' } | { kind: 'NOT_FOUND' };

export async function withdrawPartnerScholarship(partnerId: string, externalRef: string): Promise<WithdrawResult> {
  const owner = new Types.ObjectId(partnerId);
  const doc = await ScholarshipModel.findOneAndUpdate(
    { externalRef, partnerId: owner },
    { $set: { status: 'closed' } },
    { new: true, projection: { _id: 1 } },
  ).lean<{ _id: Types.ObjectId } | null>();
  if (!doc) return { kind: 'NOT_FOUND' };
  return { kind: 'OK', hubId: String(doc._id), remoteStatus: 'closed' };
}
```
> Scoped by `partnerId` so one partner can never close another's (or a human provider's) listing.

- [ ] **Step 4: Add the DELETE route**

In `apps/api/src/modules/partner/partner.routes.ts`, add `withdrawPartnerScholarship` to the import from `./partner.service` and add:
```ts
partnerRoutes.delete('/scholarships/:externalRef', requirePartner,
  validate({ params: externalRefParams }),
  async (_req, res) => {
    const { partner } = res.locals as PartnerLocals;
    const { params } = (res.locals as ValidatedLocals<unknown, unknown, ExternalRefParams>).input;
    const result = await withdrawPartnerScholarship(partner.id, params.externalRef);
    if (result.kind === 'NOT_FOUND') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such listing for this partner.' } });
      return;
    }
    res.status(200).json({ hubId: result.hubId, remoteStatus: result.remoteStatus });
  });
```

- [ ] **Step 5: Run it — verify it passes**

Run: `npm run test -w @scholarship-hub/api -- src/modules/partner/partner.withdraw.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/partner/partner.service.ts apps/api/src/modules/partner/partner.routes.ts apps/api/src/modules/partner/partner.withdraw.test.ts
git commit -m "feat(api): partner listing withdrawal (DELETE /api/partner/scholarships/:ref)"
```

---

### Task 7: Ops key mint + seed demo partner + `journey:partner`

**Files:**
- Create: `scripts/mint-partner-key.ts`
- Modify: the API seed (`apps/api/src/seed/*`) — insert a demo Partner with a well-known key
- Create: `scripts/journeys/partner.ts`
- Modify: `scripts/journeys/all.ts` — add `'partner'` to `JOURNEYS`
- Modify: root `package.json` — add `journey:partner` (and `mint:partner-key`)

**Interfaces:**
- Consumes: everything from Tasks 1–6 over real HTTP; `generatePartnerKey`, `hashPartnerKey`, `PartnerModel`.
- Produces: a demo partner key usable by the journey; a `journey:partner` runner entry.

- [ ] **Step 1: Locate the seed + DB-connection entry points**

Run:
```bash
grep -rn "mongoose.connect\|connectMongo\|createConnection" apps/api/src | head
ls apps/api/src/seed
```
Note the connect helper's module path and the seed's entry file — used in Steps 2–3.

- [ ] **Step 2: Add a demo partner to the seed**

In the seed's main routine (where it creates demo providers), insert a fixed-key partner so the journey can authenticate over HTTP. Use a well-known demo key (the same spirit as the demo passwords):
```ts
import { hashPartnerKey } from '../lib/partner-key';
import { PartnerModel } from '../modules/partner/partner.model';

const DEMO_PARTNER_KEY = 'sh_pkey_' + '0'.repeat(48);
await PartnerModel.updateOne(
  { name: 'IDAP (demo)' },
  { $set: { name: 'IDAP (demo)', keyHash: hashPartnerKey(DEMO_PARTNER_KEY), active: true } },
  { upsert: true },
);
console.log(`  Partner  → IDAP (demo) (key: ${DEMO_PARTNER_KEY})`);
```

- [ ] **Step 3: Write the mint CLI (real key, for non-demo use)**

`scripts/mint-partner-key.ts` (mirror how the seed connects — substitute the connect helper found in Step 1):
```ts
import mongoose from 'mongoose';
import { generatePartnerKey } from '../apps/api/src/lib/partner-key';
import { PartnerModel } from '../apps/api/src/modules/partner/partner.model';
// import { connectMongo, disconnectMongo } from '<path found in Step 1>';

async function main() {
  const name = process.argv[2] ?? 'IDAP';
  await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/scholarship_hub');
  const { key, keyHash } = generatePartnerKey();
  await PartnerModel.create({ name, keyHash });
  console.log(`Partner "${name}" created. Key (shown once):\n\n  ${key}\n`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
```
> Prefer the app's own connect helper (Step 1) over a raw `mongoose.connect` if one exists, so the URI/options match the app.

- [ ] **Step 4: Write the partner journey**

`scripts/journeys/partner.ts` (mirror `scripts/journeys/provider.ts` — HTTP-only, `step()` accumulator, `report()` exit code). The arc:
```ts
export {};
const BASE = (process.env.API_BASE_URL ?? 'http://127.0.0.1:4180').replace(/\/+$/, '');
const KEY = process.env.PARTNER_KEY ?? 'sh_pkey_' + '0'.repeat(48); // demo key from seed
const REF = `IDAP:INS0001:6a8f1a72017ca1920491b71a`;
// helpers: request(method, path, { body?, key? }) sets Authorization: Bearer <key>
// steps (each a step(name, async () => ({ ok, expected, actual }))):
//  1. POST /api/partner/providers  → 200 { providerId }
//  2. PUT  /api/partner/scholarships/{REF} (complete body) → 200 status published, capture slug
//  3. GET  /api/scholarships?… or /api/scholarships/{slug} (public) → the listing is discoverable
//  4. DELETE /api/partner/scholarships/{REF} → 200 closed
//  5. GET public detail again → not in the active/published discovery result
// end: await run(); process.exit(report());
```
Fill in each `step(...)` with the exact request/assertion shape from `provider.ts`. Use the `completeListing()` body from the Task 5 test as the PUT payload.

- [ ] **Step 5: Register the journey**

In `scripts/journeys/all.ts`, add `'partner'` to the `JOURNEYS` array. In root `package.json` `scripts`, add:
```json
"journey:partner": "tsx scripts/journeys/partner.ts",
"mint:partner-key": "tsx scripts/mint-partner-key.ts"
```

- [ ] **Step 6: Run the journey end-to-end**

```bash
# In one shell: seed + run the API
npm run seed -w @scholarship-hub/api -- --reset
npm run dev
# In another shell:
npm run journey:partner
```
Expected: all steps ✅ (provision → publish → discoverable → withdraw → gone). If the API port differs, set `API_BASE_URL`.

- [ ] **Step 7: Full suite + typecheck, then commit**

```bash
npm run typecheck
npm run test -w @scholarship-hub/api
git add scripts/mint-partner-key.ts scripts/journeys/partner.ts scripts/journeys/all.ts package.json apps/api/src/seed
git commit -m "feat: mint-partner-key CLI, demo partner seed, and journey:partner"
```

---

## Self-Review

**Spec coverage (Plan 1A scope = spec §3, §4.1, §4.3, §6, Hub half of §8/§9/§10/§11):**
- §6.1 partner auth → Tasks 1–2. §6.2 endpoints → Tasks 4 (providers), 5 (upsert), 6 (withdraw). §6.3 model changes (externalRef unique sparse, partnerId, moderationHold) → Task 3. §6.4 admin moderation hold → Task 5 (BLOCKED) test. §6.5 public discovery unchanged → Task 3 Step 6. §4.3 idempotency by externalRef → Task 5. §11 security (hashed key, ownership-from-credentials, no PII) → Tasks 1/2/4/5/6. §9 tests + journey → every task + Task 7. **No gaps.**
- **Not in this plan (correct):** all IDAP-side work (spec §5, §7) is Plan 1B; Phase 2 is out entirely.

**Placeholder scan:** the only non-literal spots are three explicit *confirm-at-source* notes (provider `city`/`stateCode` paths; `ValidatedLocals` arity; `env.PUBLIC_WEB_URL` accessor) and one Step-1 discovery (seed/connect paths) — each names the exact file to check and the fallback. No "TBD/handle errors/similar-to".

**Type consistency:** `PartnerLocals`/`PartnerAuth` (Task 2) used verbatim in Tasks 4–6; `ListingPushResult`/`WithdrawResult` defined in Tasks 5/6 and consumed only by their own routes; `externalRefParams`/`ExternalRefParams` defined in Task 4, used in 5/6; `writableFields`/`generateScholarshipSlug`/`missingScholarshipFields` signatures match the reported source. `externalRef` formats consistent throughout (`IDAP:{inst}` for providers, `IDAP:{inst}:{schol}` for scholarships).

