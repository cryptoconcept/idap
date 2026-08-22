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
