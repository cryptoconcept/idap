import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const PUBLIC_ROOT = resolve(process.env.PUBLIC_UPLOAD_DIR ?? join(process.cwd(), ".uploads-public"));

/**
 * Serves institution media in development, where there is no CDN. Deliberately
 * unauthenticated: these are the same bytes a school's website hot-links in
 * production. Only the public root is reachable; admission documents live in a
 * different tree behind the authenticated document route.
 */
export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/media/[...key]">,
) {
  const { key } = await context.params;
  const relative = key.join("/");

  const target = resolve(PUBLIC_ROOT, relative);
  if (target !== PUBLIC_ROOT && !target.startsWith(PUBLIC_ROOT + sep)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const [body, contentType] = await Promise.all([
      readFile(target),
      readFile(`${target}.content-type`, "utf8").catch(() => "application/octet-stream"),
    ]);
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": contentType.trim(),
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
