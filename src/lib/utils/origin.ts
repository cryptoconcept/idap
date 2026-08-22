import "server-only";
import { headers } from "next/headers";
import { env } from "@/lib/env";

/**
 * The public origin to print in integration snippets. Derived from the incoming
 * request so snippets are correct behind proxies and in preview deployments,
 * falling back to the configured app URL.
 */
export async function getAppOrigin(): Promise<string> {
  try {
    const headerList = await headers();
    const forwardedHost = headerList.get("x-forwarded-host") ?? headerList.get("host");
    if (forwardedHost) {
      const protocol =
        headerList.get("x-forwarded-proto") ??
        (forwardedHost.startsWith("localhost") || forwardedHost.startsWith("127.0.0.1")
          ? "http"
          : "https");
      return `${protocol}://${forwardedHost}`;
    }
  } catch {
    // Falls through to the configured value.
  }
  return env.APP_URL;
}
