import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { DocumentService } from "@/services/document.service";
import { handleApiError } from "@/lib/api/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Uploaded documents are private: they are never served statically, and every
 * read is authenticated and scoped to the institution that owns the record.
 * Platform admins are refused here like anywhere else that touches tenant data.
 */
export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/documents/[documentId]">,
) {
  try {
    const { user } = await requireApiUser(request);
    const clause = tenantFilter(user);
    const { documentId } = await context.params;

    const document = await DocumentService.read(clause.institutionId, documentId);

    const disposition =
      request.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";

    return new Response(new Uint8Array(document.body), {
      headers: {
        "Content-Type": document.contentType,
        // Quoted and stripped of characters that could break out of the header.
        "Content-Disposition": `${disposition}; filename="${document.fileName.replace(/["\\\r\n]/g, "")}"`,
        // Never let a stored file be interpreted as something else.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
