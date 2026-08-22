import "server-only";
import { DeviceService } from "./device.service";
import { sendPush, type PushMessage } from "@/lib/push/fcm";

async function dispatch(
  institutionId: string,
  build: (pushToken: string) => PushMessage,
): Promise<void> {
  const devices = await DeviceService.forInstitution(institutionId);
  if (devices.length === 0) return;

  const { deadTokens } = await sendPush(devices.map((device) => build(device.pushToken)));
  await DeviceService.remove(deadTokens);
}

export const NotificationService = {
  async notifyNewApplication(input: {
    institutionId: string;
    applicationNumber: string;
    studentName: string;
    applyingFor: string;
  }) {
    await dispatch(input.institutionId, (pushToken) => ({
      pushToken,
      title: "New application",
      body: `${input.studentName} — ${input.applyingFor}`,
      data: { type: "application", reference: input.applicationNumber },
    }));
  },

  async notifyNewLead(input: {
    institutionId: string;
    leadNumber: string;
    studentName: string;
    classInterested?: string;
  }) {
    await dispatch(input.institutionId, (pushToken) => ({
      pushToken,
      title: "New enquiry",
      body: input.classInterested
        ? `${input.studentName} — ${input.classInterested}`
        : input.studentName,
      data: { type: "lead", reference: input.leadNumber },
    }));
  },
};
