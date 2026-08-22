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
