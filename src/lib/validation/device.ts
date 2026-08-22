import { z } from "zod";
import { requiredText } from "./common";

export const registerDeviceSchema = z.object({
  // The same per-installation id sent at token issue, so signing out can find
  // this device's registrations again.
  deviceId: requiredText("Device id", 128),
  pushToken: requiredText("Push token", 512),
  platform: z.enum(["android", "ios"]).default("android"),
});
