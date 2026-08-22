import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { POST as issueToken } from "@/app/api/auth/token/route";
import { POST as refreshToken } from "@/app/api/auth/token/refresh/route";
import { POST as login } from "@/app/api/auth/login/route";
import { Institution, User } from "@/models";
import { LOGIN_RATE_LIMIT } from "@/lib/constants";
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

  it("refuses a platform admin even when institutionId is populated", async () => {
    // A real SUPER_ADMIN never carries an institutionId (see the User model
    // comment), so the test above is satisfied either by the role check or
    // by the institutionId check alone — it doesn't prove the role check
    // itself works. Isolate it: give the platform admin an institutionId
    // pointing at an institution that is still active, so the role check is
    // the only guard that can produce the refusal.
    await makeUser("INS0001", "SUPER_ADMIN", "platform@example.test");
    const response = await issueToken(
      post({ email: "platform@example.test", password: "Password!2026", deviceId: "device-1" }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses to issue a token when the institution is inactive", async () => {
    // Same boundary the dashboard login enforces: a deactivated institution's
    // staff must not be able to obtain a mobile session from scratch.
    await Institution.updateOne({ institutionId: "INS0001" }, { $set: { active: false } });

    const response = await issueToken(
      post({ email: "staff@example.test", password: "Password!2026", deviceId: "device-1" }),
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

  it("refuses to refresh once the account has become a platform admin", async () => {
    // A user who held a live refresh token could in principle be promoted to
    // SUPER_ADMIN afterwards. Refresh must re-check the role itself. Deliberately
    // leave institutionId populated and pointing at an institution that is still
    // active, so the only guard that can produce the refusal is the role check
    // — not the institution lookup finding nothing, which would pass even with
    // the role check removed and prove nothing about it.
    const issued = await (
      await issueToken(
        post({ email: "staff@example.test", password: "Password!2026", deviceId: "device-1" }),
      )
    ).json();

    await User.updateOne({ email: "staff@example.test" }, { $set: { role: "SUPER_ADMIN" } });

    const response = await refreshToken(post({ refreshToken: issued.refreshToken }));
    expect(response.status).toBe(401);
  });

  it("refuses to refresh once the institution has become inactive", async () => {
    const issued = await (
      await issueToken(
        post({ email: "staff@example.test", password: "Password!2026", deviceId: "device-1" }),
      )
    ).json();

    await Institution.updateOne({ institutionId: "INS0001" }, { $set: { active: false } });

    const response = await refreshToken(post({ refreshToken: issued.refreshToken }));
    expect(response.status).toBe(401);
  });

  it("shares its sign-in rate-limit bucket with the dashboard login endpoint", async () => {
    // Both endpoints bucket on `login:${ip}:${email}`. Exhausting the budget
    // through the dashboard endpoint must already block the mobile one for
    // the same IP + email, proving the bucket is shared rather than merely
    // present on each endpoint independently.
    const email = "staff@example.test";
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
      await login(post({ email, password: "wrong" }));
    }

    const response = await issueToken(
      post({ email, password: "Password!2026", deviceId: "device-1" }),
    );
    expect(response.status).toBe(429);
  });
});
