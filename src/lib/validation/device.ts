import { z } from "zod";
import { requiredText } from "./common";

export const registerDeviceSchema = z.object({
  pushToken: requiredText("Push token", 512),
  platform: z.enum(["android", "ios"]).default("android"),
});
