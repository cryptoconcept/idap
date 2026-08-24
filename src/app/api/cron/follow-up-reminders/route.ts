import { connectToDatabase } from "@/lib/db/mongoose";
import { Lead } from "@/models";
import { NotificationService } from "@/services/notification.service";
import { jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function startOfTodayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Vercel signs its own cron requests with this header when CRON_SECRET is
 * set — no session, no CSRF, this is a machine-to-machine endpoint.
 */
export async function GET(request: Request) {
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== expected) {
    return new Response(null, { status: 401 });
  }

  await connectToDatabase();

  const due = await Lead.find({
    followUpAt: { $lte: startOfTodayUTC() },
    followUpNotifiedAt: null,
    status: { $nin: ["ADMITTED", "REJECTED"] },
    assignedTo: { $ne: null },
  })
    .select("assignedTo institutionId")
    .lean();

  const byCounselor = new Map<string, { institutionId: string; leadIds: string[] }>();
  for (const lead of due) {
    const key = String(lead.assignedTo);
    const entry = byCounselor.get(key) ?? { institutionId: lead.institutionId, leadIds: [] };
    entry.leadIds.push(String(lead._id));
    byCounselor.set(key, entry);
  }

  for (const [counselorId, entry] of byCounselor) {
    await NotificationService.notifyFollowUpsDue({
      userId: counselorId,
      institutionId: entry.institutionId,
      count: entry.leadIds.length,
    });
  }

  if (due.length > 0) {
    await Lead.updateMany(
      { _id: { $in: due.map((lead) => lead._id) } },
      { $set: { followUpNotifiedAt: new Date() } },
    );
  }

  return jsonSuccess({ notified: byCounselor.size, leads: due.length });
}
