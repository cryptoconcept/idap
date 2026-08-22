import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { authenticateApiClient, type ApiAuthContext } from "@/lib/api/api-auth";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { handleApiError, jsonError } from "@/lib/api/response";
import { API_RATE_LIMIT } from "@/lib/constants";
import type { ApiPermission } from "@/lib/constants";

/**
 * Shared entry point for every `/api/v1` route: authenticate the API client,
 * apply the per-key rate limit, and normalise thrown errors into the documented
 * JSON envelope.
 */
export async function withApiClient(
  request: NextRequest,
  permission: ApiPermission,
  handler: (context: ApiAuthContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const auth = await authenticateApiClient(request, permission);

    const limit = await consumeRateLimit(
      `api:${auth.keyId}`,
      API_RATE_LIMIT.limit,
      API_RATE_LIMIT.windowSeconds,
    );
    const headers = {
      ...rateLimitHeaders(limit),
      ...(limit.allowed ? {} : { "Retry-After": String(limit.retryAfterSeconds) }),
    };

    if (!limit.allowed) {
      return jsonError(
        "RATE_LIMITED",
        `Rate limit exceeded. Maximum ${API_RATE_LIMIT.limit} requests per minute.`,
        { headers },
      );
    }

    const response = await handler(auth);
    for (const [key, value] of Object.entries(rateLimitHeaders(limit))) {
      response.headers.set(key, value);
    }
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}

/** Preflight for the credential-free endpoints a static website calls directly. */
export function publicCorsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-API-KEY,X-API-SECRET",
      "Access-Control-Max-Age": "86400",
    },
  });
}
