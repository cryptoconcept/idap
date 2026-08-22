import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { DeviceService } from "@/services/device.service";
import { registerDeviceSchema } from "@/lib/validation/device";
import { Device } from "@/models";

describe("device registration", () => {
  beforeAll(async () => {
    await startTestDatabase("devices");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
  });

  it("registers a device against an institution", async () => {
    const user = await makeUser("INS0001");
    await DeviceService.register({
      userId: String(user._id),
      institutionId: "INS0001",
      pushToken: "fcm-token-1",
      platform: "android",
    });

    const devices = await DeviceService.forInstitution("INS0001");
    expect(devices).toHaveLength(1);
    expect(devices[0].pushToken).toBe("fcm-token-1");
  });

  it("does not return another institution's devices", async () => {
    const user = await makeUser("INS0001");
    await DeviceService.register({
      userId: String(user._id),
      institutionId: "INS0001",
      pushToken: "fcm-token-1",
      platform: "android",
    });

    expect(await DeviceService.forInstitution("INS0002")).toHaveLength(0);
  });

  it("re-registering the same push token updates rather than duplicates", async () => {
    // FCM hands the same token back on every app start.
    const user = await makeUser("INS0001");
    for (let index = 0; index < 3; index += 1) {
      await DeviceService.register({
        userId: String(user._id),
        institutionId: "INS0001",
        pushToken: "fcm-token-1",
        platform: "android",
      });
    }
    expect(await Device.countDocuments({})).toBe(1);
  });

  it("ignores an institutionId supplied in the request body", async () => {
    // The schema does not accept one, so this is structurally impossible rather
    // than merely unchecked. The test pins that so a future schema edit cannot
    // reintroduce the hole silently.
    const parsed = registerDeviceSchema.parse({
      pushToken: "fcm-token-1",
      platform: "android",
      institutionId: "INS0002",
    }) as Record<string, unknown>;

    expect(parsed.institutionId).toBeUndefined();
  });

  it("removes dead tokens", async () => {
    const user = await makeUser("INS0001");
    await DeviceService.register({
      userId: String(user._id),
      institutionId: "INS0001",
      pushToken: "fcm-token-1",
      platform: "android",
    });

    await DeviceService.remove(["fcm-token-1"]);
    expect(await Device.countDocuments({})).toBe(0);
  });
});
