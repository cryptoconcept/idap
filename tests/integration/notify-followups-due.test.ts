import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { DeviceService } from "@/services/device.service";
import { NotificationService } from "@/services/notification.service";
import * as fcm from "@/lib/push/fcm";

// `vi.mock` is hoisted and swaps the module before anything imports it. A
// `vi.spyOn` would not work here: ES module namespaces are sealed, and
// notification.service.ts holds a static binding to sendPush. Matches the
// convention established in notifications.test.ts.
vi.mock("@/lib/push/fcm", () => ({
  sendPush: vi.fn(async () => ({ deadTokens: [] as string[] })),
}));

const sendPush = vi.mocked(fcm.sendPush);

beforeAll(() => startTestDatabase("notify-followups-due"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  sendPush.mockReset();
  sendPush.mockResolvedValue({ deadTokens: [] });
});

describe("DeviceService.forUser", () => {
  it("returns only the given user's devices", async () => {
    const counselorA = await makeUser("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const counselorB = await makeUser("INS0001", "COUNSELOR", "b@infinityschool.edu.in");

    await DeviceService.register({
      userId: String(counselorA._id),
      institutionId: "INS0001",
      deviceId: "device-a",
      pushToken: "token-a",
      platform: "android",
    });
    await DeviceService.register({
      userId: String(counselorB._id),
      institutionId: "INS0001",
      deviceId: "device-b",
      pushToken: "token-b",
      platform: "android",
    });

    const devices = await DeviceService.forUser(String(counselorA._id));
    expect(devices.map((d) => d.pushToken)).toEqual(["token-a"]);
  });
});

describe("NotificationService.notifyFollowUpsDue", () => {
  it("sends exactly one push naming the count, to the given user's devices only", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    await DeviceService.register({
      userId: String(counselor._id),
      institutionId: "INS0001",
      deviceId: "device-1",
      pushToken: "token-1",
      platform: "android",
    });

    await NotificationService.notifyFollowUpsDue({
      userId: String(counselor._id),
      count: 3,
    });

    expect(sendPush).toHaveBeenCalledTimes(1);
    const [messages] = sendPush.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0].pushToken).toBe("token-1");
    expect(messages[0].title).toContain("3");
  });

  it("does nothing when the user has no registered devices", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");

    await NotificationService.notifyFollowUpsDue({
      userId: String(counselor._id),
      count: 1,
    });

    expect(sendPush).not.toHaveBeenCalled();
  });
});
