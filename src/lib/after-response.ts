import "server-only";
import { after } from "next/server";

/**
 * Runs work once the response has been sent, without making the caller wait
 * for it and without letting it fail the caller.
 *
 * A bare `void promise.catch(...)` is not enough. It suspends at its first
 * `await` and the handler returns immediately afterwards; on Vercel — the
 * deployment target — work still outstanding when the response goes out is not
 * guaranteed to run, so the work and its error log can both vanish. `after()`
 * registers the task with the platform, which keeps the invocation alive until
 * it settles.
 *
 * `after()` reads the request's async context, so it throws outside one. That
 * happens in scripts and tests, where nothing is deferring anything: run the
 * task inline instead, which is also what makes the notification hooks
 * observable from a test that never enters a request scope.
 */
export async function afterResponse(task: () => Promise<unknown>): Promise<void> {
  try {
    after(task);
    return;
  } catch {
    // No request scope to hang the work off.
  }

  await task();
}
