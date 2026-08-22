import { connectToDatabase } from "@/lib/db/mongoose";
import { RateLimit } from "@/models";

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds at which the current window resets. */
  resetAt: number;
  retryAfterSeconds: number;
};

/**
 * Fixed-window counter backed by MongoDB so the limit holds across every
 * server instance. Each window gets its own document id, and a TTL index
 * reaps expired windows.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000;
  const resetAtMs = windowStart + windowSeconds * 1000;
  const bucketId = `${key}:${windowStart}`;

  const base = {
    limit,
    resetAt: Math.floor(resetAtMs / 1000),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
  };

  try {
    await connectToDatabase();
    const doc = await RateLimit.findOneAndUpdate(
      { _id: bucketId },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(resetAtMs) } },
      { upsert: true, new: true, projection: { count: 1 } },
    ).lean();

    const count = doc?.count ?? 1;
    return { ...base, allowed: count <= limit, remaining: Math.max(0, limit - count) };
  } catch {
    // Availability over strictness: never take the API down because the
    // limiter store is briefly unreachable.
    return { ...base, allowed: true, remaining: limit };
  }
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.resetAt),
  };
}
