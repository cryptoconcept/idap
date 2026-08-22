import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { DeviceService } from "@/services/device.service";
import { registerDeviceSchema } from "@/lib/validation/device";
import { signAccessToken } from "@/lib/auth/session";
import { POST as registerDevice } from "@/app/api/devices/route";
import { Device } from "@/models";
import type { NextRequest } from "next/server";

/** A request as the native app makes it: bearer token, no cookie. */
function bearerRequest(token: string, body: unknown) {
  const url = new URL("http://localhost/api/devices");
  return {
    headers: new Headers({ authorization: `Bearer ${token}`, host: "localhost" }),
    nextUrl: url,
    url: url.toString(),
    json: async () => body,
  } as unknown as NextRequest;
}

async function tokenFor(
  institutionId: string | undefined,
  role: "INSTITUTION_ADMIN" | "SUPER_ADMIN",
  email: string,
) {
  const user = await makeUser(institutionId, role, email);
  return signAccessToken({
    sub: String(user._id),
    role,
    institutionId,
    name: user.name,
    email: user.email,
    v: 0,
  });
}

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
      deviceId: "install-1",
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
      deviceId: "install-1",
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
        deviceId: "install-1",
        institutionId: "INS0001",
        pushToken: "fcm-token-1",
        platform: "android",
      });
    }
    expect(await Device.countDocuments({})).toBe(1);
  });

  it("reassigns the device to the new user and institution when a token changes hands", async () => {
    // A device can change hands between users (and even institutions); FCM keeps
    // handing back the same token. A second registration must overwrite the
    // owner, not just avoid creating a duplicate row — otherwise the old owner
    // stays subscribed to someone else's push notifications.
    const firstUser = await makeUser("INS0001");
    const secondUser = await makeUser("INS0002");

    await DeviceService.register({
      userId: String(firstUser._id),
      deviceId: "install-1",
      institutionId: "INS0001",
      pushToken: "fcm-token-1",
      platform: "android",
    });

    await DeviceService.register({
      userId: String(secondUser._id),
      deviceId: "install-1",
      institutionId: "INS0002",
      pushToken: "fcm-token-1",
      platform: "android",
    });

    expect(await Device.countDocuments({})).toBe(1);
    const device = await Device.findOne({ pushToken: "fcm-token-1" }).lean();
    expect(String(device!.userId)).toBe(String(secondUser._id));
    expect(device!.institutionId).toBe("INS0002");
  });

  it("ignores an institutionId supplied in the request body", async () => {
    // The schema does not accept one, so this is structurally impossible rather
    // than merely unchecked. The test pins that so a future schema edit cannot
    // reintroduce the hole silently.
    const parsed = registerDeviceSchema.parse({
      deviceId: "install-1",
      pushToken: "fcm-token-1",
      platform: "android",
      institutionId: "INS0002",
    }) as Record<string, unknown>;

    expect(parsed.institutionId).toBeUndefined();
  });

  it("drops only the signing-out installation's rows, not the user's other phones", async () => {
    // Sign-out has to unregister the handset it happened on. Wiping every
    // device for the user would silence their other phones; wiping none leaves
    // applicant names arriving on a phone that is signed out.
    const user = await makeUser("INS0001");
    await DeviceService.register({
      userId: String(user._id),
      deviceId: "install-1",
      institutionId: "INS0001",
      pushToken: "fcm-token-1",
      platform: "android",
    });
    // FCM rotates push tokens, so one installation can leave several rows.
    await DeviceService.register({
      userId: String(user._id),
      deviceId: "install-1",
      institutionId: "INS0001",
      pushToken: "fcm-token-1-rotated",
      platform: "android",
    });
    await DeviceService.register({
      userId: String(user._id),
      deviceId: "install-2",
      institutionId: "INS0001",
      pushToken: "fcm-token-2",
      platform: "android",
    });

    await DeviceService.removeForDevice(String(user._id), "install-1");

    const remaining = await Device.find({}).lean();
    expect(remaining.map((row) => row.pushToken)).toEqual(["fcm-token-2"]);
  });

  it("leaves the new owner registered when a signed-out user's handset changed hands", async () => {
    // register() rewrites the row to whoever registered last. The previous
    // owner signing out afterwards must not cancel the current owner's
    // notifications, so the delete is scoped by user as well as installation.
    const firstUser = await makeUser("INS0001");
    const secondUser = await makeUser("INS0002");

    await DeviceService.register({
      userId: String(firstUser._id),
      deviceId: "install-1",
      institutionId: "INS0001",
      pushToken: "fcm-token-1",
      platform: "android",
    });
    await DeviceService.register({
      userId: String(secondUser._id),
      deviceId: "install-1",
      institutionId: "INS0002",
      pushToken: "fcm-token-1",
      platform: "android",
    });

    await DeviceService.removeForDevice(String(firstUser._id), "install-1");

    expect(await Device.countDocuments({})).toBe(1);
  });

  describe("POST /api/devices", () => {
    it("stores the session's institution, not one supplied in the body", async () => {
      // Spec §6 names this: the institutionId on a device comes from the
      // session, never the request. Otherwise a modified client subscribes
      // itself to another institution's applicants — a tenant hole that
      // bypasses tenantFilter() entirely. Asserting Zod strips the key is not
      // the same claim: it says nothing about what the route does with a value
      // that reaches it.
      const token = await tokenFor("INS0001", "INSTITUTION_ADMIN", "staff@example.test");

      const response = await registerDevice(
        bearerRequest(token, {
          deviceId: "install-1",
          pushToken: "fcm-token-1",
          platform: "android",
          institutionId: "INS0002",
        }),
      );

      expect(response.status).toBe(201);
      const stored = await Device.findOne({ pushToken: "fcm-token-1" }).lean();
      expect(stored!.institutionId).toBe("INS0001");
      expect(await DeviceService.forInstitution("INS0002")).toHaveLength(0);
    });

    it("refuses a platform admin even when their institutionId is populated", async () => {
      // The route must reach its tenant through tenantFilter(), which is where
      // the platform-admin refusal lives. Deriving it as
      // `{ institutionId: user.institutionId! }` instead looks identical for
      // ordinary staff and quietly registers a platform admin here. A real
      // SUPER_ADMIN carries no institutionId, so it is populated deliberately:
      // the role check is then the only thing that can produce the refusal.
      const token = await tokenFor("INS0001", "SUPER_ADMIN", "platform@example.test");

      const response = await registerDevice(
        bearerRequest(token, {
          deviceId: "install-1",
          pushToken: "fcm-token-1",
          platform: "android",
        }),
      );

      expect(response.status).toBe(403);
      expect((await response.json()).error.message).toMatch(/cannot access institution data/i);
      expect(await Device.countDocuments({})).toBe(0);
    });

    it("registers the caller's own device", async () => {
      // The control: without it the two refusals above could both be satisfied
      // by a route that never registers anything.
      const token = await tokenFor("INS0001", "INSTITUTION_ADMIN", "staff@example.test");

      const response = await registerDevice(
        bearerRequest(token, {
          deviceId: "install-1",
          pushToken: "fcm-token-1",
          platform: "android",
        }),
      );

      expect(response.status).toBe(201);
      expect(await DeviceService.forInstitution("INS0001")).toHaveLength(1);
    });
  });

  it("removes dead tokens without touching devices not named", async () => {
    // A single-device fixture can't distinguish "removed the named token" from
    // "removed everything" — a `deleteMany({})` bug would pass it just the same.
    // A second, untouched device makes the assertion mean what it says.
    const user = await makeUser("INS0001");
    await DeviceService.register({
      userId: String(user._id),
      deviceId: "install-1",
      institutionId: "INS0001",
      pushToken: "fcm-token-1",
      platform: "android",
    });
    await DeviceService.register({
      userId: String(user._id),
      deviceId: "install-1",
      institutionId: "INS0001",
      pushToken: "fcm-token-2",
      platform: "android",
    });

    await DeviceService.remove(["fcm-token-1"]);

    expect(await Device.countDocuments({})).toBe(1);
    const remaining = await Device.findOne({}).lean();
    expect(remaining!.pushToken).toBe("fcm-token-2");
  });
});
