import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toPublicUrl, assertExternallyReachable } from "@/lib/media/public-url";

describe("toPublicUrl", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://idap.example.com");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an absolute https URL unchanged", () => {
    expect(toPublicUrl("https://blob.vercel-storage.com/x.pdf")).toBe(
      "https://blob.vercel-storage.com/x.pdf",
    );
  });

  it("resolves a relative storage key against APP_URL", () => {
    expect(toPublicUrl("/api/media/media/INS0001/a.pdf")).toBe(
      "https://idap.example.com/api/media/media/INS0001/a.pdf",
    );
  });

  it("does not double a slash when APP_URL has a trailing one", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://idap.example.com/");
    expect(toPublicUrl("/api/media/x.pdf")).toBe("https://idap.example.com/api/media/x.pdf");
  });
});

describe("assertExternallyReachable", () => {
  // MUTATION-DISTINGUISHING: this is the only thing standing between a default
  // dev config (APP_URL defaults to http://localhost:3000) and dead links on a
  // live public listing. FeesBasket links to what it is given and never
  // fetches a copy, so IDAP can never observe the breakage itself.
  const unreachable = [
    "http://localhost:3000/api/media/x.pdf",
    "http://127.0.0.1:3000/api/media/x.pdf",
    "http://[::1]:3000/api/media/x.pdf",
    "http://192.168.1.10/api/media/x.pdf",
    "http://10.0.0.5/api/media/x.pdf",
    "http://172.16.4.2/api/media/x.pdf",
  ];

  for (const url of unreachable) {
    it(`throws for ${url}`, () => {
      expect(() => assertExternallyReachable(url)).toThrow(/not reachable/i);
    });
  }

  it("names the offending host in the message", () => {
    expect(() => assertExternallyReachable("http://localhost:3000/x.pdf")).toThrow(/localhost/);
  });

  it("accepts a real public https URL", () => {
    expect(() => assertExternallyReachable("https://idap.example.com/x.pdf")).not.toThrow();
  });

  it("throws for a value that is not a URL at all", () => {
    expect(() => assertExternallyReachable("/api/media/x.pdf")).toThrow();
  });
});
