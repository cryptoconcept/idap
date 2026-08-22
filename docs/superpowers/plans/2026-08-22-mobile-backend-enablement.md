# Mobile Backend Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the existing API to authenticate a native app with bearer tokens, and push a notification to institution staff the moment an enquiry or application arrives.

**Architecture:** The existing dashboard API gains a second way to authenticate. `requireUser()` accepts either the session cookie it accepts today or an `Authorization: Bearer` access token, so every existing endpoint serves both web and mobile with one implementation. Access tokens are short-lived JWTs distinguished from dashboard sessions by their `aud` claim; refresh tokens are opaque, hashed at rest, single-use and rotated. Push fires from the two service methods every submission already funnels through.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Mongoose 8, `jose`, Vitest 3, Firebase Cloud Messaging HTTP v1.

**Spec:** `docs/superpowers/specs/2026-08-22-mobile-staff-app-design.md`

## Global Constraints

- Every module that touches the database or secrets imports `"server-only"` as its first statement.
- Tenant data is reached only through `tenantFilter(user)`; no new code path may produce an unscoped query.
- `SUPER_ADMIN` must never obtain a mobile token — the platform-admin boundary has no mobile exception.
- Side effects that describe an action (audit, push) are wrapped and swallowed; they must never fail the action itself.
- Secrets are stored as HMAC digests via `hashSecret()` from `src/lib/security/tokens.ts`, never in plaintext, never reversible.
- New Mongoose models follow the existing pattern: `(models.X as Model<XDoc>) ?? model<XDoc>("X", schema)`.
- Tests run with `npm test`. Integration tests use `startTestDatabase(name)` / `stopTestDatabase()` from `tests/helpers/db.ts`.
- **Mongoose schema changes require a dev-server restart** to take effect — the model cache lives on `globalThis` and survives HMR.

---

### Task 1: Refresh token model and service

**Files:**
- Create: `src/models/RefreshToken.ts`
- Modify: `src/models/index.ts`
- Create: `src/services/refresh-token.service.ts`
- Test: `tests/integration/refresh-token.test.ts`

**Interfaces:**
- Consumes: `hashSecret`, `randomToken` from `src/lib/security/tokens.ts`; `connectToDatabase` from `src/lib/db/mongoose.ts`.
- Produces:
  - `RefreshTokenService.issue({ userId, deviceId, familyId? }): Promise<{ token: string; familyId: string }>` — `familyId` is passed only by `rotate`, to keep a chain together
  - `RefreshTokenService.rotate(token: string): Promise<{ token: string; familyId: string; userId: string; deviceId: string } | null>` — returns `null` when the token is unknown, expired, revoked, or already consumed
  - `RefreshTokenService.revokeFamily(familyId: string): Promise<void>`
  - `RefreshTokenService.revokeToken(token: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/refresh-token.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { RefreshToken } from "@/models";

const USER = "6a8880f3446c577c470cd06c";

describe("refresh tokens", () => {
  beforeAll(async () => {
    await startTestDatabase("refreshtokens");
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("issues an opaque token and stores only a hash of it", async () => {
    const { token } = await RefreshTokenService.issue({ userId: USER, deviceId: "device-1" });

    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const stored = await RefreshToken.findOne({}).lean();
    expect(stored?.tokenHash).toBeTruthy();
    expect(stored?.tokenHash).not.toBe(token);
  });

  it("rotates: the old token stops working and a new one is returned", async () => {
    const first = await RefreshTokenService.issue({ userId: USER, deviceId: "device-1" });

    const rotated = await RefreshTokenService.rotate(first.token);
    expect(rotated?.token).toBeTruthy();
    expect(rotated?.token).not.toBe(first.token);
    expect(rotated?.userId).toBe(USER);

    expect(await RefreshTokenService.rotate(first.token)).toBeNull();
  });

  it("keeps the family id across rotations", async () => {
    const first = await RefreshTokenService.issue({ userId: USER, deviceId: "device-1" });
    const second = await RefreshTokenService.rotate(first.token);
    expect(second?.familyId).toBe(first.familyId);
  });

  it("revokes the whole family when a consumed token is presented again", async () => {
    // Reuse means the token was copied. Revoking only the presented token would
    // leave the thief refreshing alongside the real user indefinitely.
    const first = await RefreshTokenService.issue({ userId: USER, deviceId: "device-1" });
    const second = await RefreshTokenService.rotate(first.token);

    expect(await RefreshTokenService.rotate(first.token)).toBeNull();
    expect(await RefreshTokenService.rotate(second!.token)).toBeNull();

    const live = await RefreshToken.countDocuments({ revokedAt: { $exists: false } });
    expect(live).toBe(0);
  });

  it("rejects an unknown token without throwing", async () => {
    expect(await RefreshTokenService.rotate("not-a-real-token")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { token } = await RefreshTokenService.issue({ userId: USER, deviceId: "device-1" });
    await RefreshToken.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await RefreshTokenService.rotate(token)).toBeNull();
  });

  it("revokes a single token on logout", async () => {
    const { token } = await RefreshTokenService.issue({ userId: USER, deviceId: "device-1" });
    expect(await RefreshTokenService.revokeToken(token)).toBe(true);
    expect(await RefreshTokenService.rotate(token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/refresh-token.test.ts`
Expected: FAIL — `Cannot find module '@/services/refresh-token.service'`

- [ ] **Step 3: Create the model**

Create `src/models/RefreshToken.ts`:

```ts
import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * One row per issued refresh token. Tokens are single-use: rotating one marks it
 * consumed and issues its successor in the same family. A family is the chain of
 * tokens belonging to one device login, so a detected reuse can revoke all of it.
 */
const RefreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    familyId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    consumedAt: { type: Date },
    revokedAt: { type: Date },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "refresh_tokens", versionKey: false },
);

// Expired rows are reaped automatically rather than accumulating forever.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshTokenDoc = InferSchemaType<typeof RefreshTokenSchema> & {
  _id: Types.ObjectId;
};

export const RefreshToken: Model<RefreshTokenDoc> =
  (models.RefreshToken as Model<RefreshTokenDoc>) ??
  model<RefreshTokenDoc>("RefreshToken", RefreshTokenSchema);
```

Add to `src/models/index.ts`:

```ts
export { RefreshToken, type RefreshTokenDoc } from "./RefreshToken";
```

- [ ] **Step 4: Implement the service**

Create `src/services/refresh-token.service.ts`:

```ts
import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { RefreshToken } from "@/models";
import { hashSecret, randomToken } from "@/lib/security/tokens";

const TTL_DAYS = 30;

function expiryDate(): Date {
  return new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
}

export const RefreshTokenService = {
  async issue(input: { userId: string; deviceId: string; familyId?: string }) {
    await connectToDatabase();
    const token = randomToken(32);
    const familyId = input.familyId ?? randomToken(16);

    await RefreshToken.create({
      userId: new Types.ObjectId(input.userId),
      familyId,
      deviceId: input.deviceId,
      tokenHash: hashSecret(token),
      expiresAt: expiryDate(),
      createdAt: new Date(),
    });

    return { token, familyId };
  },

  /**
   * Consumes a token and returns its successor. Returns null for anything not
   * usable — unknown, expired, or revoked — so callers cannot distinguish the
   * reasons and probe for valid tokens.
   */
  async rotate(token: string) {
    await connectToDatabase();
    const existing = await RefreshToken.findOne({ tokenHash: hashSecret(token) }).lean();
    if (!existing) return null;

    if (existing.consumedAt) {
      // Presenting a consumed token means it was copied: burn the whole chain.
      await RefreshTokenService.revokeFamily(existing.familyId);
      return null;
    }

    if (existing.revokedAt) return null;
    if (existing.expiresAt.getTime() <= Date.now()) return null;

    await RefreshToken.updateOne({ _id: existing._id }, { $set: { consumedAt: new Date() } });

    const next = await RefreshTokenService.issue({
      userId: String(existing.userId),
      deviceId: existing.deviceId,
      familyId: existing.familyId,
    });

    return { ...next, userId: String(existing.userId), deviceId: existing.deviceId };
  },

  async revokeFamily(familyId: string) {
    await connectToDatabase();
    await RefreshToken.updateMany(
      { familyId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
  },

  async revokeToken(token: string) {
    await connectToDatabase();
    const result = await RefreshToken.updateOne(
      { tokenHash: hashSecret(token), revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/integration/refresh-token.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 6: Commit**

```bash
git add src/models/RefreshToken.ts src/models/index.ts src/services/refresh-token.service.ts tests/integration/refresh-token.test.ts
git commit -m "feat: refresh tokens with rotation and reuse detection"
```

---

### Task 2: Mobile access tokens

**Files:**
- Modify: `src/lib/auth/session.ts`
- Test: `tests/unit/mobile-session.test.ts`

**Interfaces:**
- Consumes: `SessionPayload`, `signSession`, `verifySessionToken` from `src/lib/auth/session.ts`.
- Produces:
  - `MOBILE_AUDIENCE = "aem-mobile"`
  - `signAccessToken(payload: SessionPayload): Promise<string>`
  - `verifyAccessToken(token: string): Promise<SessionPayload | null>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mobile-session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  signAccessToken,
  signSession,
  verifyAccessToken,
  verifySessionToken,
} from "@/lib/auth/session";

const payload = {
  sub: "6a8880f3446c577c470cd06c",
  role: "INSTITUTION_ADMIN" as const,
  institutionId: "INS0001",
  name: "Institution Admin",
  email: "admin@example.test",
  v: 0,
};

describe("mobile access tokens", () => {
  it("round-trips a mobile token", async () => {
    const verified = await verifyAccessToken(await signAccessToken(payload));
    expect(verified).toMatchObject(payload);
  });

  it("does not accept a dashboard session as a mobile token", async () => {
    // The audience split is what stops a stolen cookie being replayed at the API.
    expect(await verifyAccessToken(await signSession(payload))).toBeNull();
  });

  it("does not accept a mobile token as a dashboard session", async () => {
    expect(await verifySessionToken(await signAccessToken(payload))).toBeNull();
  });

  it("rejects a tampered mobile token", async () => {
    const token = await signAccessToken(payload);
    const [header, body, signature] = token.split(".");
    const forged = JSON.parse(Buffer.from(body, "base64url").toString());
    forged.institutionId = "INS9999";
    const tampered = [
      header,
      Buffer.from(JSON.stringify(forged)).toString("base64url"),
      signature,
    ].join(".");

    expect(await verifyAccessToken(tampered)).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    for (const bad of ["", "nope", "a.b.c"]) {
      expect(await verifyAccessToken(bad)).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/mobile-session.test.ts`
Expected: FAIL — `signAccessToken is not a function`

- [ ] **Step 3: Implement**

Append to `src/lib/auth/session.ts`:

```ts
/**
 * Mobile access tokens are the same shape as dashboard sessions but carry a
 * different audience. That split is load-bearing: it stops a stolen session
 * cookie being replayed against the mobile API, and vice versa.
 */
export const MOBILE_AUDIENCE = "aem-mobile";
const ACCESS_TOKEN_TTL = "15m";

export async function signAccessToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer("aem-platform")
    .setAudience(MOBILE_AUDIENCE)
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(secretKey());
}

export async function verifyAccessToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: "aem-platform",
      audience: MOBILE_AUDIENCE,
      algorithms: ["HS256"],
    });
    if (typeof payload.sub !== "string" || typeof payload.role !== "string") return null;
    return {
      sub: payload.sub,
      role: payload.role as UserRole,
      institutionId: typeof payload.institutionId === "string" ? payload.institutionId : undefined,
      name: String(payload.name ?? ""),
      email: String(payload.email ?? ""),
      v: Number(payload.v ?? 0),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/mobile-session.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/session.ts tests/unit/mobile-session.test.ts
git commit -m "feat: mobile access tokens with a separate audience"
```

---

### Task 3: Accept bearer tokens on the existing API

**Files:**
- Create: `src/lib/auth/bearer.ts`
- Modify: `src/lib/tenant/index.ts`
- Modify: `src/lib/api/csrf.ts`
- Test: `tests/integration/bearer-auth.test.ts`

**Interfaces:**
- Consumes: `verifyAccessToken` (Task 2); `CurrentUser` from `src/lib/auth/current-user.ts`.
- Produces:
  - `resolveBearerUser(request: NextRequest): Promise<CurrentUser | null>`
  - `requireApiUser(request: NextRequest): Promise<{ user: CurrentUser; viaBearer: boolean }>`
  - `assertSameOrigin(request: NextRequest, options?: { viaBearer?: boolean }): void`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/bearer-auth.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { resolveBearerUser } from "@/lib/auth/bearer";
import { signAccessToken } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/api/csrf";
import { User } from "@/models";
import type { NextRequest } from "next/server";

function request(headers: Record<string, string>) {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

describe("bearer authentication", () => {
  beforeAll(async () => {
    await startTestDatabase("bearerauth");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001");
  });

  async function tokenFor(institutionId?: string, role: "INSTITUTION_ADMIN" | "SUPER_ADMIN" = "INSTITUTION_ADMIN") {
    const user = await makeUser(institutionId, role);
    return {
      user,
      token: await signAccessToken({
        sub: String(user._id),
        role,
        institutionId,
        name: user.name,
        email: user.email,
        v: 0,
      }),
    };
  }

  it("resolves a user from a valid bearer token", async () => {
    const { token } = await tokenFor("INS0001");
    const resolved = await resolveBearerUser(request({ authorization: `Bearer ${token}` }));
    expect(resolved?.institutionId).toBe("INS0001");
  });

  it("returns null when there is no bearer header", async () => {
    expect(await resolveBearerUser(request({}))).toBeNull();
  });

  it("rejects a token whose user has been deactivated", async () => {
    const { user, token } = await tokenFor("INS0001");
    await User.updateOne({ _id: user._id }, { $set: { active: false } });
    expect(await resolveBearerUser(request({ authorization: `Bearer ${token}` }))).toBeNull();
  });

  it("rejects a token whose session version has moved on", async () => {
    // This is how "sign out everywhere" reaches already-issued access tokens.
    const { user, token } = await tokenFor("INS0001");
    await User.updateOne({ _id: user._id }, { $set: { sessionVersion: 1 } });
    expect(await resolveBearerUser(request({ authorization: `Bearer ${token}` }))).toBeNull();
  });
});

describe("CSRF check", () => {
  it("still rejects a cross-origin cookie request", () => {
    expect(() =>
      assertSameOrigin(request({ origin: "https://evil.test", host: "admissions.test" })),
    ).toThrow(/Cross-origin/);
  });

  it("is skipped for bearer requests, which cannot be CSRF'd", () => {
    // A native app sends no meaningful Origin, and bearer tokens are never
    // attached automatically by a browser.
    expect(() =>
      assertSameOrigin(request({ origin: "https://evil.test", host: "admissions.test" }), {
        viaBearer: true,
      }),
    ).not.toThrow();
  });

  it("still allows a same-origin cookie request", () => {
    expect(() =>
      assertSameOrigin(request({ origin: "https://admissions.test", host: "admissions.test" })),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/bearer-auth.test.ts`
Expected: FAIL — `Cannot find module '@/lib/auth/bearer'`

- [ ] **Step 3: Implement bearer resolution**

Create `src/lib/auth/bearer.ts`:

```ts
import "server-only";
import type { NextRequest } from "next/server";
import { connectToDatabase } from "@/lib/db/mongoose";
import { User } from "@/models";
import { verifyAccessToken } from "./session";
import type { CurrentUser } from "./current-user";
import type { UserRole } from "@/lib/constants";

/**
 * Resolves a mobile caller from an Authorization header. Like the cookie path,
 * the user record is re-checked on every request so deactivation and session
 * rotation take effect immediately rather than at token expiry.
 */
export async function resolveBearerUser(request: NextRequest): Promise<CurrentUser | null> {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;

  const payload = await verifyAccessToken(header.slice(7).trim());
  if (!payload) return null;

  await connectToDatabase();
  const user = await User.findById(payload.sub).lean();
  if (!user || !user.active) return null;
  if ((user.sessionVersion ?? 0) !== payload.v) return null;

  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role as UserRole,
    institutionId: user.institutionId ?? undefined,
  };
}
```

- [ ] **Step 4: Make the CSRF check conditional**

Replace the body of `assertSameOrigin` in `src/lib/api/csrf.ts`:

```ts
/**
 * Defence in depth for cookie-authenticated mutations. SameSite=Lax already
 * stops cross-site form posts from carrying the session; this rejects anything
 * whose Origin does not match the host it was sent to.
 *
 * Bearer-authenticated requests skip it. A browser never attaches a bearer token
 * automatically, so those requests cannot be forged cross-site, and a native
 * client has no meaningful Origin to check.
 */
export function assertSameOrigin(
  request: NextRequest,
  options: { viaBearer?: boolean } = {},
): void {
  if (options.viaBearer) return;

  const origin = request.headers.get("origin");
  if (!origin) return; // Same-origin fetches from some clients omit Origin entirely.

  const host = request.headers.get("host");
  try {
    const originHost = new URL(origin).host;
    if (host && originHost === host) return;
  } catch {
    // Fall through to the rejection below.
  }

  throw forbidden("Cross-origin request rejected");
}
```

- [ ] **Step 5: Add the combined guard**

Append to `src/lib/tenant/index.ts`:

```ts
import type { NextRequest } from "next/server";
import { resolveBearerUser } from "@/lib/auth/bearer";

/**
 * The guard every API route uses. Tries the bearer token first so a mobile
 * request is never mistaken for a browser one, then falls back to the cookie.
 * `viaBearer` tells the caller whether the CSRF check applies.
 */
export async function requireApiUser(
  request: NextRequest,
): Promise<{ user: CurrentUser; viaBearer: boolean }> {
  const bearerUser = await resolveBearerUser(request);
  if (bearerUser) return { user: bearerUser, viaBearer: true };

  const cookieUser = await getCurrentUser();
  if (!cookieUser) throw unauthorized();
  return { user: cookieUser, viaBearer: false };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/integration/bearer-auth.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 7: Run the whole suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS — all previously passing tests still pass

- [ ] **Step 8: Commit**

```bash
git add src/lib/auth/bearer.ts src/lib/tenant/index.ts src/lib/api/csrf.ts tests/integration/bearer-auth.test.ts
git commit -m "feat: accept bearer tokens alongside session cookies"
```

---

### Task 4: Token endpoints

**Files:**
- Create: `src/app/api/auth/token/route.ts`
- Create: `src/app/api/auth/token/refresh/route.ts`
- Create: `src/app/api/auth/token/revoke/route.ts`
- Modify: `src/lib/validation/user.ts`
- Test: `tests/integration/token-endpoints.test.ts`

**Interfaces:**
- Consumes: `RefreshTokenService` (Task 1), `signAccessToken` (Task 2), `loginSchema` and `emailSchema` from `src/lib/validation/user.ts`, `verifyPassword`/`fakeVerify` from `src/lib/security/password.ts`, `consumeRateLimit` from `src/lib/security/rate-limit.ts`.
- Produces: HTTP endpoints only. Response shape:
  `{ success: true, accessToken: string, refreshToken: string, expiresIn: 900, user: { id, name, email, institutionId } }`

- [ ] **Step 1: Add the request schema**

Append to `src/lib/validation/user.ts`:

```ts
export const mobileTokenSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required").max(128),
  // Identifies the installation so one device's tokens can be revoked alone.
  deviceId: requiredText("Device id", 128),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(20, "Refresh token is required").max(512),
});
```

- [ ] **Step 2: Write the failing test**

Create `tests/integration/token-endpoints.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { POST as issueToken } from "@/app/api/auth/token/route";
import { POST as refreshToken } from "@/app/api/auth/token/refresh/route";
import type { NextRequest } from "next/server";

function post(body: unknown) {
  return {
    json: async () => body,
    headers: new Headers({ "content-type": "application/json" }),
    nextUrl: new URL("http://localhost/api/auth/token"),
  } as unknown as NextRequest;
}

describe("mobile token endpoints", () => {
  beforeAll(async () => {
    await startTestDatabase("tokenendpoints");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001");
    await makeUser("INS0001", "INSTITUTION_ADMIN", "staff@example.test");
  });

  it("issues both tokens for valid credentials", async () => {
    const response = await issueToken(
      post({ email: "staff@example.test", password: "Password!2026", deviceId: "device-1" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.accessToken).toBeTruthy();
    expect(payload.refreshToken).toBeTruthy();
    expect(payload.user.institutionId).toBe("INS0001");
    // The password hash must never travel to a client.
    expect(JSON.stringify(payload)).not.toContain("passwordHash");
  });

  it("rejects a wrong password with the same message as an unknown account", async () => {
    const response = await issueToken(
      post({ email: "staff@example.test", password: "wrong", deviceId: "device-1" }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toBe("Incorrect email or password");
  });

  it("refuses a platform admin", async () => {
    // The mobile API must not be a way around the platform-admin boundary.
    await makeUser(undefined, "SUPER_ADMIN", "platform@example.test");
    const response = await issueToken(
      post({ email: "platform@example.test", password: "Password!2026", deviceId: "device-1" }),
    );
    expect(response.status).toBe(403);
  });

  it("exchanges a refresh token for a new pair", async () => {
    const issued = await (
      await issueToken(
        post({ email: "staff@example.test", password: "Password!2026", deviceId: "device-1" }),
      )
    ).json();

    const response = await refreshToken(post({ refreshToken: issued.refreshToken }));
    const rotated = await response.json();

    expect(response.status).toBe(200);
    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    expect(rotated.accessToken).toBeTruthy();
  });

  it("refuses a refresh token that has already been used", async () => {
    const issued = await (
      await issueToken(
        post({ email: "staff@example.test", password: "Password!2026", deviceId: "device-1" }),
      )
    ).json();

    await refreshToken(post({ refreshToken: issued.refreshToken }));
    const replay = await refreshToken(post({ refreshToken: issued.refreshToken }));
    expect(replay.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/integration/token-endpoints.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/auth/token/route'`

- [ ] **Step 4: Implement the issue endpoint**

Create `src/app/api/auth/token/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution, User } from "@/models";
import { mobileTokenSchema } from "@/lib/validation/user";
import { fakeVerify, verifyPassword } from "@/lib/security/password";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { LOGIN_RATE_LIMIT } from "@/lib/constants";
import { signAccessToken } from "@/lib/auth/session";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";
import { PLATFORM_ADMIN_DENIED } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const ACCESS_TOKEN_SECONDS = 900;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const credentials = mobileTokenSchema.parse(body);
    const ip = getClientIp(request);

    const limit = await consumeRateLimit(
      `login:${ip}:${credentials.email}`,
      LOGIN_RATE_LIMIT.limit,
      LOGIN_RATE_LIMIT.windowSeconds,
    );
    if (!limit.allowed) {
      return jsonError("RATE_LIMITED", "Too many sign-in attempts. Try again in a few minutes.", {
        headers: rateLimitHeaders(limit),
      });
    }

    await connectToDatabase();
    const user = await User.findOne({ email: credentials.email }).select("+passwordHash").lean();

    if (!user) {
      await fakeVerify();
      return jsonError("UNAUTHORIZED", "Incorrect email or password");
    }

    const valid = await verifyPassword(credentials.password, user.passwordHash);
    if (!valid || !user.active) {
      return jsonError("UNAUTHORIZED", "Incorrect email or password");
    }

    // The app is for institution staff. A platform admin has no tenant data to
    // show, and issuing them a token would be a way around that boundary.
    if (user.role === "SUPER_ADMIN" || !user.institutionId) {
      return jsonError("FORBIDDEN", PLATFORM_ADMIN_DENIED);
    }

    const institution = await Institution.findOne({ institutionId: user.institutionId })
      .select("active")
      .lean();
    if (!institution?.active) {
      return jsonError("FORBIDDEN", "This institution account is currently inactive");
    }

    const accessToken = await signAccessToken({
      sub: String(user._id),
      role: user.role,
      institutionId: user.institutionId,
      name: user.name,
      email: user.email,
      v: user.sessionVersion ?? 0,
    });

    const { token: refreshToken } = await RefreshTokenService.issue({
      userId: String(user._id),
      deviceId: credentials.deviceId,
    });

    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    return jsonSuccess({
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_SECONDS,
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        institutionId: user.institutionId,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: Implement the refresh endpoint**

Create `src/app/api/auth/token/refresh/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { connectToDatabase } from "@/lib/db/mongoose";
import { User } from "@/models";
import { refreshTokenSchema } from "@/lib/validation/user";
import { signAccessToken } from "@/lib/auth/session";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { handleApiError, jsonError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

const ACCESS_TOKEN_SECONDS = 900;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { refreshToken } = refreshTokenSchema.parse(body);

    const rotated = await RefreshTokenService.rotate(refreshToken);
    // Null covers unknown, expired, revoked and reused. The caller is told
    // nothing that would let them tell those apart.
    if (!rotated) return jsonError("UNAUTHORIZED", "Session expired. Please sign in again.");

    await connectToDatabase();
    const user = await User.findById(rotated.userId).lean();
    if (!user || !user.active || user.role === "SUPER_ADMIN" || !user.institutionId) {
      return jsonError("UNAUTHORIZED", "Session expired. Please sign in again.");
    }

    const accessToken = await signAccessToken({
      sub: String(user._id),
      role: user.role,
      institutionId: user.institutionId,
      name: user.name,
      email: user.email,
      v: user.sessionVersion ?? 0,
    });

    return jsonSuccess({
      accessToken,
      refreshToken: rotated.token,
      expiresIn: ACCESS_TOKEN_SECONDS,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 6: Implement the revoke endpoint**

Create `src/app/api/auth/token/revoke/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { refreshTokenSchema } from "@/lib/validation/user";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** Sign-out. Always reports success so a caller cannot probe token validity. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { refreshToken } = refreshTokenSchema.parse(body);
    await RefreshTokenService.revokeToken(refreshToken);
    return jsonSuccess({ message: "Signed out" });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/integration/token-endpoints.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 8: Commit**

```bash
git add src/app/api/auth/token src/lib/validation/user.ts tests/integration/token-endpoints.test.ts
git commit -m "feat: mobile token issue, refresh and revoke endpoints"
```

---

### Task 5: Device registration

**Files:**
- Create: `src/models/Device.ts`
- Modify: `src/models/index.ts`
- Create: `src/services/device.service.ts`
- Create: `src/app/api/devices/route.ts`
- Create: `src/lib/validation/device.ts`
- Test: `tests/integration/devices.test.ts`

**Interfaces:**
- Consumes: `requireApiUser` (Task 3), `tenantFilter` from `src/lib/tenant/index.ts`.
- Produces:
  - `DeviceService.register({ userId, institutionId, pushToken, platform }): Promise<{ id: string }>`
  - `DeviceService.forInstitution(institutionId: string): Promise<{ id: string; pushToken: string }[]>`
  - `DeviceService.remove(pushTokens: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/devices.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { DeviceService } from "@/services/device.service";
import { registerDeviceSchema } from "@/lib/validation/device";
import { Device } from "@/models";

describe("device registration", () => {
  beforeAll(async () => {
    await startTestDatabase("devices");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
  });

  it("registers a device against an institution", async () => {
    const user = await makeUser("INS0001");
    await DeviceService.register({
      userId: String(user._id),
      institutionId: "INS0001",
      pushToken: "fcm-token-1",
      platform: "android",
    });

    const devices = await DeviceService.forInstitution("INS0001");
    expect(devices).toHaveLength(1);
    expect(devices[0].pushToken).toBe("fcm-token-1");
  });

  it("does not return another institution's devices", async () => {
    const user = await makeUser("INS0001");
    await DeviceService.register({
      userId: String(user._id),
      institutionId: "INS0001",
      pushToken: "fcm-token-1",
      platform: "android",
    });

    expect(await DeviceService.forInstitution("INS0002")).toHaveLength(0);
  });

  it("re-registering the same push token updates rather than duplicates", async () => {
    // FCM hands the same token back on every app start.
    const user = await makeUser("INS0001");
    for (let index = 0; index < 3; index += 1) {
      await DeviceService.register({
        userId: String(user._id),
        institutionId: "INS0001",
        pushToken: "fcm-token-1",
        platform: "android",
      });
    }
    expect(await Device.countDocuments({})).toBe(1);
  });

  it("ignores an institutionId supplied in the request body", async () => {
    // The schema does not accept one, so this is structurally impossible rather
    // than merely unchecked. The test pins that so a future schema edit cannot
    // reintroduce the hole silently.
    const parsed = registerDeviceSchema.parse({
      pushToken: "fcm-token-1",
      platform: "android",
      institutionId: "INS0002",
    }) as Record<string, unknown>;

    expect(parsed.institutionId).toBeUndefined();
  });

  it("removes dead tokens", async () => {
    const user = await makeUser("INS0001");
    await DeviceService.register({
      userId: String(user._id),
      institutionId: "INS0001",
      pushToken: "fcm-token-1",
      platform: "android",
    });

    await DeviceService.remove(["fcm-token-1"]);
    expect(await Device.countDocuments({})).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/devices.test.ts`
Expected: FAIL — `Cannot find module '@/services/device.service'`

- [ ] **Step 3: Create the model**

Create `src/models/Device.ts`:

```ts
import { Schema, Types, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * A push destination. `institutionId` is written from the authenticated session,
 * never from a request body — otherwise a modified client could subscribe itself
 * to another institution's submissions.
 */
const DeviceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    institutionId: { type: String, required: true, index: true },
    pushToken: { type: String, required: true, unique: true, index: true },
    platform: { type: String, enum: ["android", "ios"], required: true },
    lastSeenAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "devices", versionKey: false },
);

export type DeviceDoc = InferSchemaType<typeof DeviceSchema> & { _id: Types.ObjectId };

export const Device: Model<DeviceDoc> =
  (models.Device as Model<DeviceDoc>) ?? model<DeviceDoc>("Device", DeviceSchema);
```

Add to `src/models/index.ts`:

```ts
export { Device, type DeviceDoc } from "./Device";
```

- [ ] **Step 4: Implement the service**

Create `src/services/device.service.ts`:

```ts
import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Device } from "@/models";

export const DeviceService = {
  async register(input: {
    userId: string;
    institutionId: string;
    pushToken: string;
    platform: "android" | "ios";
  }) {
    await connectToDatabase();
    // Upsert on the push token: FCM returns the same value on every app start,
    // and a device can change hands between users.
    const device = await Device.findOneAndUpdate(
      { pushToken: input.pushToken },
      {
        $set: {
          userId: new Types.ObjectId(input.userId),
          institutionId: input.institutionId,
          platform: input.platform,
          lastSeenAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true, new: true },
    ).lean();

    return { id: String(device!._id) };
  },

  async forInstitution(institutionId: string) {
    await connectToDatabase();
    const rows = await Device.find({ institutionId }).select("pushToken").lean();
    return rows.map((row) => ({ id: String(row._id), pushToken: row.pushToken }));
  },

  async remove(pushTokens: string[]) {
    if (pushTokens.length === 0) return;
    await connectToDatabase();
    await Device.deleteMany({ pushToken: { $in: pushTokens } });
  },
};
```

- [ ] **Step 5: Add the validation schema and route**

Create `src/lib/validation/device.ts`:

```ts
import { z } from "zod";
import { requiredText } from "./common";

export const registerDeviceSchema = z.object({
  pushToken: requiredText("Push token", 512),
  platform: z.enum(["android", "ios"]).default("android"),
});
```

Create `src/app/api/devices/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { registerDeviceSchema } from "@/lib/validation/device";
import { DeviceService } from "@/services/device.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });

    // Derives the tenant from the session, and refuses a platform admin.
    const clause = tenantFilter(user);

    const body = await request.json().catch(() => ({}));
    const data = registerDeviceSchema.parse(body);

    const device = await DeviceService.register({
      userId: user.id,
      institutionId: clause.institutionId,
      pushToken: data.pushToken,
      platform: data.platform,
    });

    return jsonSuccess({ device }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/integration/devices.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 7: Commit**

```bash
git add src/models/Device.ts src/models/index.ts src/services/device.service.ts src/app/api/devices src/lib/validation/device.ts tests/integration/devices.test.ts
git commit -m "feat: device registration for push notifications"
```

---

### Task 6: Notification service and submission hooks

**Files:**
- Create: `src/lib/push/fcm.ts`
- Create: `src/services/notification.service.ts`
- Modify: `src/services/lead.service.ts`
- Modify: `src/services/application.service.ts`
- Test: `tests/integration/notifications.test.ts`

**Interfaces:**
- Consumes: `DeviceService` (Task 5).
- Produces:
  - `sendPush(messages: PushMessage[]): Promise<{ deadTokens: string[] }>` where
    `PushMessage = { pushToken: string; title: string; body: string; data: Record<string, string> }`
  - `NotificationService.notifyNewApplication({ institutionId, applicationNumber, studentName, applyingFor }): Promise<void>`
  - `NotificationService.notifyNewLead({ institutionId, leadNumber, studentName, classInterested }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/notifications.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { DeviceService } from "@/services/device.service";
import { NotificationService } from "@/services/notification.service";
import { LeadService } from "@/services/lead.service";
import { createLeadSchema } from "@/lib/validation/lead";
import * as fcm from "@/lib/push/fcm";

// `vi.mock` is hoisted and swaps the module before anything imports it. A
// `vi.spyOn` would not work here: ES module namespaces are sealed, and
// notification.service.ts holds a static binding to sendPush.
vi.mock("@/lib/push/fcm", () => ({
  sendPush: vi.fn(async () => ({ deadTokens: [] as string[] })),
}));

const sendPush = vi.mocked(fcm.sendPush);

const leadInput = createLeadSchema.parse({
  studentName: "Rahul Kumar",
  phone: "9876543210",
  classInterested: "Grade 5",
});

describe("notifications", () => {
  beforeAll(async () => {
    await startTestDatabase("notifications");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
    sendPush.mockReset();
    sendPush.mockResolvedValue({ deadTokens: [] });
  });

  async function registerDevice(institutionId: string, pushToken: string) {
    const user = await makeUser(institutionId, "INSTITUTION_ADMIN", `${pushToken}@example.test`);
    await DeviceService.register({
      userId: String(user._id),
      institutionId,
      pushToken,
      platform: "android",
    });
  }

  it("sends only to the receiving institution's devices", async () => {
    await registerDevice("INS0001", "token-a");
    await registerDevice("INS0002", "token-b");

    await NotificationService.notifyNewApplication({
      institutionId: "INS0001",
      applicationNumber: "INS0001-APP-000001",
      studentName: "Rahul Kumar",
      applyingFor: "Grade 5",
    });

    const messages = sendPush.mock.calls[0][0];
    expect(messages.map((m) => m.pushToken)).toEqual(["token-a"]);
  });

  it("includes the student's name and deep-link data", async () => {
    await registerDevice("INS0001", "token-a");

    await NotificationService.notifyNewApplication({
      institutionId: "INS0001",
      applicationNumber: "INS0001-APP-000001",
      studentName: "Rahul Kumar",
      applyingFor: "Grade 5",
    });

    const [message] = sendPush.mock.calls[0][0];
    expect(message.body).toContain("Rahul Kumar");
    expect(message.data).toMatchObject({
      type: "application",
      reference: "INS0001-APP-000001",
    });
  });

  it("prunes tokens FCM reports as dead", async () => {
    await registerDevice("INS0001", "token-a");
    sendPush.mockResolvedValue({ deadTokens: ["token-a"] });

    await NotificationService.notifyNewApplication({
      institutionId: "INS0001",
      applicationNumber: "INS0001-APP-000001",
      studentName: "Rahul Kumar",
      applyingFor: "Grade 5",
    });

    expect(await DeviceService.forInstitution("INS0001")).toHaveLength(0);
  });

  it("does nothing when the institution has no devices", async () => {
    await NotificationService.notifyNewApplication({
      institutionId: "INS0001",
      applicationNumber: "INS0001-APP-000001",
      studentName: "Rahul Kumar",
      applyingFor: "Grade 5",
    });
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("never fails the submission it is reporting", async () => {
    // A family submitting at 11pm must not see an error because FCM is down.
    await registerDevice("INS0001", "token-a");
    sendPush.mockRejectedValue(new Error("FCM unavailable"));

    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "WEBSITE",
    });

    expect(lead.leadNumber).toBe("INS0001-LD000001");
  });

  it("fires on enquiry creation", async () => {
    await registerDevice("INS0001", "token-a");

    await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "API",
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendPush).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/notifications.test.ts`
Expected: FAIL — `Cannot find module '@/lib/push/fcm'`

- [ ] **Step 3: Implement the FCM sender**

Create `src/lib/push/fcm.ts`:

```ts
import "server-only";
import { SignJWT, importPKCS8 } from "jose";

export type PushMessage = {
  pushToken: string;
  title: string;
  body: string;
  data: Record<string, string>;
};

type ServiceAccount = { client_email: string; private_key: string; project_id: string };

function serviceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ServiceAccount;
  } catch {
    console.error("[push] FIREBASE_SERVICE_ACCOUNT is not valid JSON");
    return null;
  }
}

/** Google OAuth access token for the FCM HTTP v1 API. */
async function accessToken(account: ServiceAccount): Promise<string> {
  const key = await importPKCS8(account.private_key.replace(/\\n/g, "\n"), "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(account.client_email)
    .setSubject(account.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("Could not obtain an FCM access token");
  return payload.access_token;
}

/**
 * Sends one message per device and reports tokens FCM no longer recognises so
 * the caller can prune them. A missing service account disables push rather than
 * throwing: the platform stays usable without Firebase configured.
 */
export async function sendPush(messages: PushMessage[]): Promise<{ deadTokens: string[] }> {
  const account = serviceAccount();
  if (!account || messages.length === 0) return { deadTokens: [] };

  const token = await accessToken(account);
  const endpoint = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  const deadTokens: string[] = [];

  await Promise.all(
    messages.map(async (message) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: message.pushToken,
            notification: { title: message.title, body: message.body },
            data: message.data,
            android: { priority: "high" },
          },
        }),
      });

      if (response.status === 404 || response.status === 400) {
        deadTokens.push(message.pushToken);
      }
    }),
  );

  return { deadTokens };
}
```

- [ ] **Step 4: Implement the notification service**

Create `src/services/notification.service.ts`:

```ts
import "server-only";
import { DeviceService } from "./device.service";
import { sendPush, type PushMessage } from "@/lib/push/fcm";

async function dispatch(
  institutionId: string,
  build: (pushToken: string) => PushMessage,
): Promise<void> {
  const devices = await DeviceService.forInstitution(institutionId);
  if (devices.length === 0) return;

  const { deadTokens } = await sendPush(devices.map((device) => build(device.pushToken)));
  await DeviceService.remove(deadTokens);
}

export const NotificationService = {
  async notifyNewApplication(input: {
    institutionId: string;
    applicationNumber: string;
    studentName: string;
    applyingFor: string;
  }) {
    await dispatch(input.institutionId, (pushToken) => ({
      pushToken,
      title: "New application",
      body: `${input.studentName} — ${input.applyingFor}`,
      data: { type: "application", reference: input.applicationNumber },
    }));
  },

  async notifyNewLead(input: {
    institutionId: string;
    leadNumber: string;
    studentName: string;
    classInterested?: string;
  }) {
    await dispatch(input.institutionId, (pushToken) => ({
      pushToken,
      title: "New enquiry",
      body: input.classInterested
        ? `${input.studentName} — ${input.classInterested}`
        : input.studentName,
      data: { type: "lead", reference: input.leadNumber },
    }));
  },
};
```

- [ ] **Step 5: Hook into lead creation**

In `src/services/lead.service.ts`, add the import:

```ts
import { NotificationService } from "./notification.service";
```

and immediately after the `ActivityService.record({...})` call inside `createLead`, add:

```ts
    // Fire-and-forget, exactly like the audit write above: a push failure must
    // never fail the submission it is reporting.
    void NotificationService.notifyNewLead({
      institutionId: input.institutionId,
      leadNumber,
      studentName: input.data.studentName,
      classInterested: input.data.classInterested,
    }).catch((error) => console.error("[push] enquiry notification failed", error));
```

- [ ] **Step 6: Hook into application creation**

In `src/services/application.service.ts`, add the import:

```ts
import { NotificationService } from "./notification.service";
```

and immediately after the `ActivityService.record({...})` call inside `createApplication`, add:

```ts
    void NotificationService.notifyNewApplication({
      institutionId: input.institutionId,
      applicationNumber,
      studentName: studentFullName(data.student),
      applyingFor: data.admission.applyingFor,
    }).catch((error) => console.error("[push] application notification failed", error));
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/integration/notifications.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS — all tests

- [ ] **Step 9: Commit**

```bash
git add src/lib/push src/services/notification.service.ts src/services/lead.service.ts src/services/application.service.ts tests/integration/notifications.test.ts
git commit -m "feat: push notifications on new enquiries and applications"
```

---

### Task 7: Publish the staff API in the OpenAPI document

**Files:**
- Modify: `src/lib/api/openapi.ts`
- Test: `tests/unit/api-contract.test.ts`

**Interfaces:**
- Consumes: `buildOpenApiDocument({ origin, institutionId?, institutionName? })`.
- Produces: three new documented paths — `/api/auth/token`, `/api/auth/token/refresh`, `/api/devices` — tagged `Staff app`, plus a `staffAuth` bearer security scheme.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/api-contract.test.ts`, inside the existing `describe("OpenAPI document", ...)` block:

```ts
  it("documents the staff app endpoints", () => {
    expect(paths(scoped)).toContain("/api/auth/token");
    expect(paths(scoped)).toContain("/api/auth/token/refresh");
    expect(paths(scoped)).toContain("/api/devices");
  });

  it("marks token issue as needing no prior credential", () => {
    const operation = (
      scoped.paths as Record<string, Record<string, { security?: unknown[]; tags?: string[] }>>
    )["/api/auth/token"].post;
    expect(operation.security).toEqual([]);
    expect(operation.tags).toContain("Staff app");
  });

  it("requires the staff bearer scheme on device registration", () => {
    const operation = (
      scoped.paths as Record<string, Record<string, { security?: { staffAuth?: unknown[] }[] }>>
    )["/api/devices"].post;
    expect(operation.security).toEqual([{ staffAuth: [] }]);
  });

  it("declares the staff bearer security scheme", () => {
    const schemes = (
      scoped.components as { securitySchemes: Record<string, unknown> }
    ).securitySchemes;
    expect(schemes).toHaveProperty("staffAuth");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/api-contract.test.ts`
Expected: FAIL — expected paths not present

- [ ] **Step 3: Add the security scheme**

In `src/lib/api/openapi.ts`, inside `components.securitySchemes`, add:

```ts
        staffAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Access token from `POST /api/auth/token`. Expires after 15 minutes; refresh with `POST /api/auth/token/refresh`.",
        },
```

- [ ] **Step 4: Add the tag**

In `src/lib/api/openapi.ts`, append to the `tags` array:

```ts
      {
        name: "Staff app",
        description:
          "Used by the institution staff mobile app. Bearer tokens, obtained with a staff email and password. Not for external integrations.",
      },
```

- [ ] **Step 5: Add the paths**

In `src/lib/api/openapi.ts`, inside the `paths` object, add:

```ts
      "/api/auth/token": {
        post: {
          tags: ["Staff app"],
          summary: "Exchange staff credentials for tokens",
          description:
            "Returns a 15-minute access token and a 30-day refresh token. Refresh tokens are single-use and rotate on every refresh. Platform administrators are refused.",
          operationId: "issueStaffToken",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password", "deviceId"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string" },
                    deviceId: {
                      type: "string",
                      description: "Stable per-installation id, so one device can be signed out alone.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Tokens issued.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", const: true },
                      accessToken: { type: "string" },
                      refreshToken: { type: "string" },
                      expiresIn: { type: "integer", example: 900 },
                    },
                  },
                },
              },
            },
            ...errorResponses([
              "VALIDATION_ERROR",
              "UNAUTHORIZED",
              "FORBIDDEN",
              "RATE_LIMITED",
              "INTERNAL_ERROR",
            ]),
          },
        },
      },

      "/api/auth/token/refresh": {
        post: {
          tags: ["Staff app"],
          summary: "Rotate a refresh token",
          description:
            "Consumes the refresh token and returns a new pair. Presenting an already-used token revokes every token for that device.",
          operationId: "refreshStaffToken",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["refreshToken"],
                  properties: { refreshToken: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "New token pair.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", const: true },
                      accessToken: { type: "string" },
                      refreshToken: { type: "string" },
                      expiresIn: { type: "integer", example: 900 },
                    },
                  },
                },
              },
            },
            ...errorResponses(["VALIDATION_ERROR", "UNAUTHORIZED", "INTERNAL_ERROR"]),
          },
        },
      },

      "/api/devices": {
        post: {
          tags: ["Staff app"],
          summary: "Register this device for push notifications",
          description:
            "The institution is taken from the access token, never from the body. Re-registering the same push token updates the existing record.",
          operationId: "registerDevice",
          security: [{ staffAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["pushToken"],
                  properties: {
                    pushToken: { type: "string" },
                    platform: { type: "string", enum: ["android", "ios"], default: "android" },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Device registered.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", const: true },
                      device: {
                        type: "object",
                        properties: { id: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses([
              "VALIDATION_ERROR",
              "UNAUTHORIZED",
              "FORBIDDEN",
              "INTERNAL_ERROR",
            ]),
          },
        },
      },
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/unit/api-contract.test.ts`
Expected: PASS

- [ ] **Step 7: Verify the document is still schema-valid**

Run: `npm run dev` in one terminal, then:

```bash
curl -s "http://localhost:3000/api/v1/openapi.json?institution=INS0001" -o /tmp/openapi.json
npx --yes @seriousme/openapi-schema-validator /tmp/openapi.json
```

Expected: `valid: true`

- [ ] **Step 8: Full verification**

Run:

```bash
npm test && npx tsc --noEmit && npx eslint . && npx next build
```

Expected: all pass

- [ ] **Step 9: Commit**

```bash
git add src/lib/api/openapi.ts tests/unit/api-contract.test.ts
git commit -m "feat: document the staff app API in the OpenAPI spec"
```

---

## Environment variables added by this plan

| Variable | Required | Purpose |
| --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | no | Firebase service account JSON, as a single-line string. Absent disables push cleanly. |

Set on Vercel with:

```bash
vercel env add FIREBASE_SERVICE_ACCOUNT production
```

---

## What this plan does not cover

The Android app itself — Expo project, screens, secure session storage, deep
links, PDF share, EAS Build, Play submission. That is the second plan, and it
depends only on the endpoints this one delivers.
