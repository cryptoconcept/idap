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
