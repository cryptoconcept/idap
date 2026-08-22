import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { POST as issueToken } from "@/app/api/auth/token/route";
import { POST as refreshToken } from "@/app/api/auth/token/refresh/route";
import { POST as revokeToken } from "@/app/api/auth/token/revoke/route";
import { POST as login } from "@/app/api/auth/login/route";
import { Device, Institution, User } from "@/models";
import { DeviceService } from "@/services/device.service";
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

  it("refuses to refresh once the user's session version has been bumped", async () => {
    // "Sign out everywhere" is a sessionVersion bump. It kills access tokens
    // within 15 minutes, but the refresh chain lives 30 days: without pinning
    // the chain to its issuing version, the app refreshes straight back into a
    // working session and the sign-out silently expires instead of holding.
    // The institution stays active and the role stays INSTITUTION_ADMIN, so the
    // version check is the only guard that can produce the refusal.
    const issued = await (
      await issueToken(
        post({ email: "staff@example.test", password: "Password!2026", deviceId: "device-1" }),
      )
    ).json();

    await User.updateOne({ email: "staff@example.test" }, { $inc: { sessionVersion: 1 } });

    const response = await refreshToken(post({ refreshToken: issued.refreshToken }));
    expect(response.status).toBe(401);
    // The same uniform failure as every other refresh rejection: a caller must
    // not be able to tell a revoked session from an unknown token.
    expect((await response.json()).error.message).toBe("Session expired. Please sign in again.");
  });

  it("issues a usable chain to a user who has signed out everywhere before", async () => {
    // The counterpart to the two tests above: the chain is pinned to the
    // version at issue, not to zero. Pinning it to a constant would make every
    // token issued after the first "sign out everywhere" refuse to refresh —
    // a sign-in that silently expires 15 minutes later.
    await User.updateOne({ email: "staff@example.test" }, { $set: { sessionVersion: 2 } });

    const issued = await (
      await issueToken(
        post({ email: "staff@example.test", password: "Password!2026", deviceId: "device-1" }),
      )
    ).json();

    const response = await refreshToken(post({ refreshToken: issued.refreshToken }));
    expect(response.status).toBe(200);
  });

  it("a bumped session version stays dead across the whole chain, not just the next refresh", async () => {
    // Rotating before the bump proves the check reads the chain's pinned
    // version rather than whatever the freshest row happened to be written
    // with — a successor that re-read the user would restore access here.
    const issued = await (
      await issueToken(
        post({ email: "staff@example.test", password: "Password!2026", deviceId: "device-1" }),
      )
    ).json();

    const rotated = await (await refreshToken(post({ refreshToken: issued.refreshToken }))).json();
    expect(rotated.refreshToken).toBeTruthy();

    await User.updateOne({ email: "staff@example.test" }, { $inc: { sessionVersion: 1 } });

    expect((await refreshToken(post({ refreshToken: rotated.refreshToken }))).status).toBe(401);
  });

  it("signing out unregisters that installation's push devices", async () => {
    // The only other path that deletes a Device is FCM dead-token pruning, so
    // without this a signed-out phone keeps receiving notifications — which
    // carry applicant names to the lock screen by design (spec §6) — until the
    // app is uninstalled.
    const user = await User.findOne({ email: "staff@example.test" }).lean();
    const issued = await (
      await issueToken(
        post({ email: "staff@example.test", password: "Password!2026", deviceId: "install-1" }),
      )
    ).json();

    await DeviceService.register({
      userId: String(user!._id),
      institutionId: "INS0001",
      deviceId: "install-1",
      pushToken: "fcm-token-1",
      platform: "android",
    });
    // A second handset belonging to the same person, signed in separately.
    await DeviceService.register({
      userId: String(user!._id),
      institutionId: "INS0001",
      deviceId: "install-2",
      pushToken: "fcm-token-2",
      platform: "android",
    });

    const response = await revokeToken(post({ refreshToken: issued.refreshToken }));
    expect(response.status).toBe(200);

    // Only the handset that signed out; the other phone stays subscribed.
    const remaining = await Device.find({}).lean();
    expect(remaining.map((row) => row.pushToken)).toEqual(["fcm-token-2"]);
  });

  it("still reports success, and unregisters nothing, for a token it does not know", async () => {
    // The endpoint must not become an oracle, and an unknown token names no
    // device — a blanket delete triggered by any string would be worse than
    // the bug this fixes.
    const user = await User.findOne({ email: "staff@example.test" }).lean();
    await DeviceService.register({
      userId: String(user!._id),
      institutionId: "INS0001",
      deviceId: "install-1",
      pushToken: "fcm-token-1",
      platform: "android",
    });

    const response = await revokeToken(
      post({ refreshToken: "not-a-real-token-but-long-enough-to-parse" }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).message).toBe("Signed out");
    expect(await Device.countDocuments({})).toBe(1);
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
