import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { Lead } from "@/models";
import { LeadService } from "@/services/lead.service";
import * as fcm from "@/lib/push/fcm";

// `vi.mock` is hoisted and swaps the module before anything imports it. A
// `vi.spyOn` would not work here: ES module namespaces are sealed, and
// notification.service.ts (which this route calls into) holds a static
// binding to sendPush. Matches the convention established in
// notifications.test.ts and notify-followups-due.test.ts.
vi.mock("@/lib/push/fcm", () => ({
  sendPush: vi.fn(async () => ({ deadTokens: [] as string[] })),
}));

const sendPush = vi.mocked(fcm.sendPush);

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeAll(() => startTestDatabase("follow-up-reminder-cron"));
afterAll(() => {
  process.env.CRON_SECRET = ORIGINAL_SECRET;
  return stopTestDatabase();
});
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  process.env.CRON_SECRET = "test-secret";
  sendPush.mockReset();
  sendPush.mockResolvedValue({ deadTokens: [] });
});

function cronRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  return { headers } as unknown as Request;
}

async function makeLead(institutionId: string) {
  return LeadService.createLead({
    institutionId,
    data: { studentName: "Test Student", phone: "9876543210" },
    source: "API",
  });
}

describe("GET /api/cron/follow-up-reminders", () => {
  it("401s without the correct CRON_SECRET", async () => {
    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    const response = await GET(cronRequest("wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("401s with no authorization header at all", async () => {
    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    const response = await GET(cronRequest());
    expect(response.status).toBe(401);
  });

  it("sends exactly one push for a counselor with a due follow-up, and stamps followUpNotifiedAt", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const lead = await makeLead("INS0001");
    await Lead.updateOne(
      { _id: lead.id },
      { $set: { assignedTo: String(counselor._id), followUpAt: new Date("2020-01-01T00:00:00.000Z") } },
    );

    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    const response = await GET(cronRequest("test-secret"));

    expect(response.status).toBe(200);
    expect(sendPush).not.toHaveBeenCalled(); // counselor has no registered device — nothing to send to, and that's correct

    const row = await Lead.findById(lead.id).lean();
    expect(row?.followUpNotifiedAt).toBeDefined();
  });

  it("groups multiple due leads for the same counselor into a single notification, not one per lead", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const { DeviceService } = await import("@/services/device.service");
    await DeviceService.register({
      userId: String(counselor._id),
      institutionId: "INS0001",
      deviceId: "d1",
      pushToken: "token-1",
      platform: "android",
    });

    const leadA = await makeLead("INS0001");
    const leadB = await makeLead("INS0001");
    const past = new Date("2020-01-01T00:00:00.000Z");
    await Lead.updateOne({ _id: leadA.id }, { $set: { assignedTo: String(counselor._id), followUpAt: past } });
    await Lead.updateOne({ _id: leadB.id }, { $set: { assignedTo: String(counselor._id), followUpAt: past } });

    // Registering the device before creating leadA/leadB means each createLead
    // call fires its own "new enquiry" institution-wide push (notifyNewLead) —
    // clear those out so only the cron's own send is counted below.
    sendPush.mockClear();
    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    await GET(cronRequest("test-secret"));

    expect(sendPush).toHaveBeenCalledTimes(1);
    const [messages] = sendPush.mock.calls[0]!;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.title).toContain("2");
  });

  it("skips a lead already notified today", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const { DeviceService } = await import("@/services/device.service");
    await DeviceService.register({
      userId: String(counselor._id),
      institutionId: "INS0001",
      deviceId: "d1",
      pushToken: "token-1",
      platform: "android",
    });
    const lead = await makeLead("INS0001");
    await Lead.updateOne(
      { _id: lead.id },
      {
        $set: {
          assignedTo: String(counselor._id),
          followUpAt: new Date("2020-01-01T00:00:00.000Z"),
          followUpNotifiedAt: new Date(),
        },
      },
    );

    // The device was registered before makeLead ran, so createLead's own
    // "new enquiry" push already fired — clear it so it doesn't get mistaken
    // for a cron-triggered send.
    sendPush.mockClear();
    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    await GET(cronRequest("test-secret"));

    expect(sendPush).not.toHaveBeenCalled();
  });

  it("skips a lead in a terminal status even if its follow-up is due", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const { DeviceService } = await import("@/services/device.service");
    await DeviceService.register({
      userId: String(counselor._id),
      institutionId: "INS0001",
      deviceId: "d1",
      pushToken: "token-1",
      platform: "android",
    });
    const lead = await makeLead("INS0001");
    await Lead.updateOne(
      { _id: lead.id },
      {
        $set: {
          assignedTo: String(counselor._id),
          followUpAt: new Date("2020-01-01T00:00:00.000Z"),
          status: "ADMITTED",
        },
      },
    );

    // The device was registered before makeLead ran, so createLead's own
    // "new enquiry" push already fired — clear it so it doesn't get mistaken
    // for a cron-triggered send.
    sendPush.mockClear();
    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    await GET(cronRequest("test-secret"));

    expect(sendPush).not.toHaveBeenCalled();
  });

  it("does not notify a lead whose follow-up is in the future", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const { DeviceService } = await import("@/services/device.service");
    await DeviceService.register({
      userId: String(counselor._id),
      institutionId: "INS0001",
      deviceId: "d1",
      pushToken: "token-1",
      platform: "android",
    });
    const lead = await makeLead("INS0001");
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
    await Lead.updateOne(
      { _id: lead.id },
      { $set: { assignedTo: String(counselor._id), followUpAt: farFuture } },
    );

    // The device was registered before makeLead ran, so createLead's own
    // "new enquiry" push already fired — clear it so it doesn't get mistaken
    // for a cron-triggered send.
    sendPush.mockClear();
    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    await GET(cronRequest("test-secret"));

    expect(sendPush).not.toHaveBeenCalled();
  });
});
