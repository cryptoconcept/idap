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
