import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { DeviceService } from "@/services/device.service";
import { NotificationService } from "@/services/notification.service";
import { LeadService } from "@/services/lead.service";
import { createLeadSchema } from "@/lib/validation/lead";
import * as fcm from "@/lib/push/fcm";

// `vi.mock` is hoisted and swaps the module before anything imports it. A
// `vi.spyOn` would not work here: ES module namespaces are sealed, and
// notification.service.ts holds a static binding to sendPush.
vi.mock("@/lib/push/fcm", () => ({
  sendPush: vi.fn(async () => ({ deadTokens: [] as string[] })),
}));

const sendPush = vi.mocked(fcm.sendPush);

const leadInput = createLeadSchema.parse({
  studentName: "Rahul Kumar",
  phone: "9876543210",
  classInterested: "Grade 5",
});

describe("notifications", () => {
  beforeAll(async () => {
    await startTestDatabase("notifications");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
    sendPush.mockReset();
    sendPush.mockResolvedValue({ deadTokens: [] });
  });

  async function registerDevice(institutionId: string, pushToken: string) {
    const user = await makeUser(institutionId, "INSTITUTION_ADMIN", `${pushToken}@example.test`);
    await DeviceService.register({
      userId: String(user._id),
      institutionId,
      pushToken,
      platform: "android",
    });
  }

  it("sends only to the receiving institution's devices", async () => {
    await registerDevice("INS0001", "token-a");
    await registerDevice("INS0002", "token-b");

    await NotificationService.notifyNewApplication({
      institutionId: "INS0001",
      applicationNumber: "INS0001-APP-000001",
      studentName: "Rahul Kumar",
      applyingFor: "Grade 5",
    });

    const messages = sendPush.mock.calls[0][0];
    expect(messages.map((m) => m.pushToken)).toEqual(["token-a"]);
  });

  it("includes the student's name and deep-link data", async () => {
    await registerDevice("INS0001", "token-a");

    await NotificationService.notifyNewApplication({
      institutionId: "INS0001",
      applicationNumber: "INS0001-APP-000001",
      studentName: "Rahul Kumar",
      applyingFor: "Grade 5",
    });

    const [message] = sendPush.mock.calls[0][0];
    expect(message.body).toContain("Rahul Kumar");
    expect(message.data).toMatchObject({
      type: "application",
      reference: "INS0001-APP-000001",
    });
  });

  it("prunes tokens FCM reports as dead", async () => {
    await registerDevice("INS0001", "token-a");
    sendPush.mockResolvedValue({ deadTokens: ["token-a"] });

    await NotificationService.notifyNewApplication({
      institutionId: "INS0001",
      applicationNumber: "INS0001-APP-000001",
      studentName: "Rahul Kumar",
      applyingFor: "Grade 5",
    });

    expect(await DeviceService.forInstitution("INS0001")).toHaveLength(0);
  });

  it("does nothing when the institution has no devices", async () => {
    await NotificationService.notifyNewApplication({
      institutionId: "INS0001",
      applicationNumber: "INS0001-APP-000001",
      studentName: "Rahul Kumar",
      applyingFor: "Grade 5",
    });
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("never fails the submission it is reporting", async () => {
    // A family submitting at 11pm must not see an error because FCM is down.
    await registerDevice("INS0001", "token-a");
    sendPush.mockRejectedValue(new Error("FCM unavailable"));

    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "WEBSITE",
    });

    expect(lead.leadNumber).toBe("INS0001-LD000001");
  });

  it("fires on enquiry creation", async () => {
    await registerDevice("INS0001", "token-a");

    await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "API",
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendPush).toHaveBeenCalled();
  });
});
