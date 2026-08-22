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
  /**
   * `sessionVersion` is the user's value at the moment the chain starts. It is
   * required rather than defaulted so a caller cannot silently issue a token
   * that survives the next "sign out everywhere".
   */
  async issue(input: {
    userId: string;
    deviceId: string;
    sessionVersion: number;
    familyId?: string;
  }) {
    await connectToDatabase();
    const token = randomToken(32);
    const familyId = input.familyId ?? randomToken(16);

    await RefreshToken.create({
      userId: new Types.ObjectId(input.userId),
      familyId,
      deviceId: input.deviceId,
      sessionVersion: input.sessionVersion,
      tokenHash: hashSecret(token),
      expiresAt: expiryDate(),
      createdAt: new Date(),
    });

    return { token, familyId, sessionVersion: input.sessionVersion };
  },

  /**
   * Consumes a token and returns its successor. Returns null for anything not
   * usable — unknown, expired, revoked, or already consumed — so callers
   * cannot distinguish the reasons and probe for valid tokens.
   */
  async rotate(token: string) {
    await connectToDatabase();
    const tokenHash = hashSecret(token);

    // The read-and-write that marks a token consumed must be one atomic
    // operation: the filter only matches a row that is still unconsumed,
    // unrevoked, and unexpired, so when the same token is presented
    // concurrently, every caller's write races on that single document and
    // exactly one can match and win. There is no separate read-then-write
    // window in which two callers could both observe "unconsumed" and both
    // go on to mint a successor. (Same idiom as `Counter.findOneAndUpdate`
    // in sequence.service.ts.)
    const claimed = await RefreshToken.findOneAndUpdate(
      {
        tokenHash,
        consumedAt: { $exists: false },
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      },
      { $set: { consumedAt: new Date() } },
    ).lean();

    if (claimed) {
      // The successor inherits the version the chain was issued at, never the
      // user's current one: re-reading it here would let a rotation launder a
      // revoked session back into a live one.
      const next = await RefreshTokenService.issue({
        userId: String(claimed.userId),
        deviceId: claimed.deviceId,
        sessionVersion: claimed.sessionVersion ?? 0,
        familyId: claimed.familyId,
      });

      // revokeFamily's updateMany only matches rows that exist at query time,
      // so a concurrent reuse detection racing this rotation could finish
      // burning the family before the successor row above was inserted, and
      // never touch it. Re-check after the insert: if any sibling in this
      // family is now revoked, the family was (or is being) burned, so finish
      // the job on the just-created successor too rather than hand back a
      // live token from a family the system otherwise believes is dead.
      const familyBurned = await RefreshToken.exists({
        familyId: claimed.familyId,
        revokedAt: { $exists: true },
      });
      if (familyBurned) {
        await RefreshTokenService.revokeFamily(claimed.familyId);
        return null;
      }

      return { ...next, userId: String(claimed.userId), deviceId: claimed.deviceId };
    }

    // The claim didn't match — off the happy path, so a second read here to
    // work out why is fine. It only distinguishes "already consumed" (reuse)
    // from "unknown/expired/revoked" (nothing to detect); it never writes,
    // so it cannot reopen the race the claim above closed.
    const existing = await RefreshToken.findOne({ tokenHash }).lean();
    if (!existing) return null;

    if (existing.consumedAt) {
      // Presenting a consumed token means it was copied: burn the whole chain.
      await RefreshTokenService.revokeFamily(existing.familyId);
    }

    return null;
  },

  async revokeFamily(familyId: string) {
    await connectToDatabase();
    await RefreshToken.updateMany(
      { familyId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
  },

  /**
   * Sign-out. Returns the row's owner and device so the caller can also drop
   * that installation's push registrations, or null when there was nothing live
   * to revoke.
   */
  async revokeToken(token: string): Promise<{ userId: string; deviceId: string } | null> {
    await connectToDatabase();
    const revoked = await RefreshToken.findOneAndUpdate(
      { tokenHash: hashSecret(token), revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    ).lean();
    if (!revoked) return null;
    return { userId: String(revoked.userId), deviceId: revoked.deviceId };
  },
};
