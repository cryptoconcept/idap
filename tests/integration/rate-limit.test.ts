import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";

describe("rate limiting", () => {
  beforeAll(async () => {
    await startTestDatabase("ratelimit");
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("allows exactly the configured number of requests, then blocks", async () => {
    const results = [];
    for (let index = 0; index < 6; index += 1) {
      results.push(await consumeRateLimit("key-a", 5, 60));
    }

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results[5].allowed).toBe(false);
    expect(results[5].retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts down the remaining allowance", async () => {
    expect((await consumeRateLimit("key-b", 3, 60)).remaining).toBe(2);
    expect((await consumeRateLimit("key-b", 3, 60)).remaining).toBe(1);
    expect((await consumeRateLimit("key-b", 3, 60)).remaining).toBe(0);
  });

  it("keeps separate buckets from interfering", async () => {
    for (let index = 0; index < 5; index += 1) await consumeRateLimit("key-c", 5, 60);
    expect((await consumeRateLimit("key-c", 5, 60)).allowed).toBe(false);
    // A different API key, or a different visitor IP, is unaffected.
    expect((await consumeRateLimit("key-d", 5, 60)).allowed).toBe(true);
  });

  it("counts concurrent requests exactly once each", async () => {
    // A read-then-write limiter would undercount here and let the burst through.
    const results = await Promise.all(
      Array.from({ length: 30 }, () => consumeRateLimit("key-e", 10, 60)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(results.filter((result) => !result.allowed)).toHaveLength(20);
  });

  it("reports the window in the documented headers", async () => {
    const result = await consumeRateLimit("key-f", 100, 60);
    const headers = rateLimitHeaders(result);
    expect(headers["X-RateLimit-Limit"]).toBe("100");
    expect(headers["X-RateLimit-Remaining"]).toBe("99");
    expect(Number(headers["X-RateLimit-Reset"])).toBeGreaterThan(Date.now() / 1000 - 1);
  });

  it("starts a fresh allowance in the next window", async () => {
    // A one-second window makes the rollover observable without a fake clock.
    for (let index = 0; index < 2; index += 1) await consumeRateLimit("key-g", 2, 1);
    expect((await consumeRateLimit("key-g", 2, 1)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await consumeRateLimit("key-g", 2, 1)).allowed).toBe(true);
  });
});
