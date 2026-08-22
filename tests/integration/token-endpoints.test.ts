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
