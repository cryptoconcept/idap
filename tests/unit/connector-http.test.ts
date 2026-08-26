import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectorHttp, ConnectorHttpError } from "@/lib/connectors/http";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("createConnectorHttp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends a JSON request with a bearer token and returns the parsed JSON response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const http = createConnectorHttp("https://api.passpercent.example");
    const result = await http("/api/partner/institutions", {
      method: "POST",
      token: "secret-platform-token",
      body: { name: "Delhi Public School" },
    });

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(String(url)).toBe("https://api.passpercent.example/api/partner/institutions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret-platform-token");
    expect(JSON.parse(String(init.body))).toEqual({ name: "Delhi Public School" });
    // 15s timeout via AbortSignal.timeout — wired into every request.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("resolves normally for a non-2xx response instead of throwing, so the adapter can classify it", async () => {
    // A 403 carrying a specific reason means something different from a bare
    // 401 or a 429 — the client must hand this back intact, not collapse it
    // into an exception.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, { reason: "needs_school_consent" }));
    vi.stubGlobal("fetch", fetchMock);

    const http = createConnectorHttp("https://api.example.com");
    const result = await http("/x", { method: "GET", token: "t" });

    expect(result).toEqual({ status: 403, body: { reason: "needs_school_consent" } });
  });

  it("retries exactly once after the Retry-After seconds on a 429, returning the retry's result", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate_limited" }, { "retry-after": "3" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const http = createConnectorHttp("https://api.example.com");
    const promise = http("/x", { method: "GET", token: "t" });

    // Not yet at 3s: still one call, still pending.
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once after a flat 2 seconds on a 429 with no Retry-After header", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate_limited" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const http = createConnectorHttp("https://api.example.com");
    const promise = http("/x", { method: "GET", token: "t" });

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a second time — a 429 on the retry itself is returned as-is", async () => {
    // Exactly one retry, not a loop. If this ever regresses into a loop, this
    // is the test that fails: it demands the call count stop at two.
    vi.useFakeTimers();
    // A fresh Response per call — a Response body can only be read once, and
    // reusing one across two calls would fail for that reason rather than for
    // the retry-count regression this test exists to catch.
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(429, { error: "rate_limited" }));
    vi.stubGlobal("fetch", fetchMock);

    const http = createConnectorHttp("https://api.example.com");
    const promise = http("/x", { method: "GET", token: "t" });

    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws ConnectorHttpError when the request times out", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);

    const http = createConnectorHttp("https://api.example.com");

    await expect(http("/x", { method: "GET", token: "t" })).rejects.toBeInstanceOf(ConnectorHttpError);
  });

  it("throws ConnectorHttpError on a plain network failure (not only on timeout)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const http = createConnectorHttp("https://api.example.com");

    await expect(http("/x", { method: "GET", token: "t" })).rejects.toBeInstanceOf(ConnectorHttpError);
  });

  it("never lets the platform token reach a thrown error's message, including on timeout", async () => {
    const token = "super-secret-platform-token-xyz";
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);

    const http = createConnectorHttp("https://api.example.com");

    let caught: unknown;
    try {
      await http("/x", { method: "GET", token });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConnectorHttpError);
    expect(String(caught)).not.toContain(token);
    expect(JSON.stringify((caught as ConnectorHttpError).body ?? null)).not.toContain(token);
  });
});
