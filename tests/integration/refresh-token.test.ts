import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("under concurrent presentation of the same token, never more than one rotation wins and the family ends up fully revoked", async () => {
    // A copied token and a legitimate retry look identical to the server: both
    // present the same live token at the same time. The atomic claim in
    // rotate() guarantees a hard ceiling of one winner — a check-then-act
    // consume (read, then a separate write) would instead let every
    // concurrent caller read "unconsumed" before any of them writes, so all
    // of them would pass and all would mint a successor.
    //
    // The exact count below one is not fixed at exactly one, though: whoever
    // wins the claim still races the losers' family-wide revoke against its
    // own successor insert, and if a loser's revoke lands first, the winner's
    // own post-insert check now catches that and returns null too rather than
    // hand back a token already dead in the database — so an all-null outcome
    // is also correct here, not a bug. What must always hold is the ceiling
    // (at most one live successor ever) and that the family is left fully
    // revoked either way.
    const first = await RefreshTokenService.issue({ userId: USER, deviceId: "device-1" });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => RefreshTokenService.rotate(first.token)),
    );

    const winners = results.filter((result) => result !== null);
    expect(winners.length).toBeLessThanOrEqual(1);

    const live = await RefreshToken.countDocuments({ revokedAt: { $exists: false } });
    expect(live).toBe(0);
  });

  it("closes the window between claiming a token and its successor's insert: a family revoke landing exactly there still leaves no live token", async () => {
    // revokeFamily's updateMany only matches rows that exist when it runs. If a
    // concurrent reuse detection finishes burning the family in the gap between
    // this rotation claiming the old token and its successor actually being
    // inserted, the successor didn't exist yet and would be skipped entirely —
    // a durable, undetected live token in a family the system believes is dead.
    // Constructed directly rather than raced: intercept the successor's insert
    // and run the family-burning revoke immediately before it actually lands,
    // pinning the exact interleaving instead of hoping a Promise.all race
    // reproduces it.
    const first = await RefreshTokenService.issue({ userId: USER, deviceId: "device-1" });

    const originalCreate = RefreshToken.create.bind(RefreshToken);
    const createSpy = vi
      .spyOn(RefreshToken, "create")
      .mockImplementation(async (...args: Parameters<typeof RefreshToken.create>) => {
        await RefreshTokenService.revokeFamily(first.familyId);
        return originalCreate(...args);
      });

    let result: Awaited<ReturnType<typeof RefreshTokenService.rotate>>;
    try {
      result = await RefreshTokenService.rotate(first.token);
    } finally {
      createSpy.mockRestore();
    }

    expect(result).toBeNull();

    const live = await RefreshToken.countDocuments({
      familyId: first.familyId,
      revokedAt: { $exists: false },
    });
    expect(live).toBe(0);
  });
});
