import { runReconciliationPull } from "@/services/scholarship-application-sync.service";
import { jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel signs its own cron requests with this header when CRON_SECRET is
 * set — no session, no CSRF, this is a machine-to-machine endpoint, exactly
 * mirroring `follow-up-reminders`'s own cron route.
 */
export async function GET(request: Request) {
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== expected) {
    return new Response(null, { status: 401 });
  }

  const result = await runReconciliationPull();
  return jsonSuccess(result);
}
