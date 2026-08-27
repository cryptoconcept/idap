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

  it("returns an absolute http URL unchanged", () => {
    expect(toPublicUrl("http://blob.example.com/x.pdf")).toBe(
      "http://blob.example.com/x.pdf",
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

  it("handles protocol-relative URLs unchanged", () => {
    expect(toPublicUrl("//blob.vercel-storage.com/x.pdf")).toBe(
      "//blob.vercel-storage.com/x.pdf",
    );
  });
});

describe("assertExternallyReachable", () => {
  // MUTATION-DISTINGUISHING: this is the only thing standing between a default
  // dev config (APP_URL defaults to http://localhost:3000) and dead links on a
  // live public listing. FeesBasket links to what it is given and never
  // fetches a copy, so IDAP can never observe the breakage itself.

  describe("IPv4 loopback and special addresses", () => {
    it("throws for IPv4 loopback 127.0.0.1", () => {
      expect(() => assertExternallyReachable("http://127.0.0.1:3000/api/media/x.pdf")).toThrow(
        /not reachable/i,
      );
    });

    it("throws for IPv4 loopback 0.0.0.0", () => {
      expect(() => assertExternallyReachable("http://0.0.0.0/api/media/x.pdf")).toThrow(
        /not reachable/i,
      );
    });
  });

  describe("IPv4 private ranges (RFC1918)", () => {
    it("throws for 10.0.0.0/8", () => {
      expect(() => assertExternallyReachable("http://10.0.0.5/api/media/x.pdf")).toThrow(
        /not reachable/i,
      );
    });

    it("throws for 192.168.0.0/16", () => {
      expect(() => assertExternallyReachable("http://192.168.1.10/api/media/x.pdf")).toThrow(
        /not reachable/i,
      );
    });

    it("throws for 172.16.0.0/12 (lower boundary)", () => {
      expect(() => assertExternallyReachable("http://172.16.0.1/api/media/x.pdf")).toThrow(
        /not reachable/i,
      );
    });

    it("throws for 172.16.0.0/12 (upper boundary at 172.31)", () => {
      expect(() => assertExternallyReachable("http://172.31.255.255/api/media/x.pdf")).toThrow(
        /not reachable/i,
      );
    });

    it("throws for link-local 169.254.0.0/16", () => {
      expect(() => assertExternallyReachable("http://169.254.1.1/api/media/x.pdf")).toThrow(
        /not reachable/i,
      );
    });
  });

  describe("IPv6 loopback and private ranges", () => {
    it("throws for IPv6 loopback ::1", () => {
      expect(() => assertExternallyReachable("http://[::1]:3000/api/media/x.pdf")).toThrow(
        /not reachable/i,
      );
    });

    it("throws for IPv6 unspecified ::", () => {
      expect(() => assertExternallyReachable("http://[::]:3000/api/media/x.pdf")).toThrow(
        /not reachable/i,
      );
    });

    it("throws for IPv6 link-local fe80::/10", () => {
      expect(() => assertExternallyReachable("http://[fe80::1]:3000/api/media/x.pdf")).toThrow(
        /not reachable/i,
      );
    });

    it("throws for IPv6 unique-local fc00::/7", () => {
      expect(() => assertExternallyReachable("http://[fc00::1]:3000/api/media/x.pdf")).toThrow(
        /not reachable/i,
      );
    });

    it("throws for IPv6 unique-local fd00::/7", () => {
      expect(() => assertExternallyReachable("http://[fd00::1]:3000/api/media/x.pdf")).toThrow(
        /not reachable/i,
      );
    });
  });

  describe("IPv4-mapped IPv6", () => {
    it("throws for IPv4-mapped IPv6 with loopback ::ffff:127.0.0.1", () => {
      expect(() =>
        assertExternallyReachable("http://[::ffff:127.0.0.1]:3000/api/media/x.pdf"),
      ).toThrow(/not reachable/i);
    });

    it("throws for IPv4-mapped IPv6 with private 10.0.0.0/8", () => {
      expect(() =>
        assertExternallyReachable("http://[::ffff:10.0.0.5]:3000/api/media/x.pdf"),
      ).toThrow(/not reachable/i);
    });

    it("throws for IPv4-mapped IPv6 with private 192.168.0.0/16", () => {
      expect(() =>
        assertExternallyReachable("http://[::ffff:192.168.1.1]:3000/api/media/x.pdf"),
      ).toThrow(/not reachable/i);
    });
  });

  describe("DNS names (never apply numeric prefix rules)", () => {
    it("accepts DNS name 10.example.com despite numeric prefix", () => {
      expect(() => assertExternallyReachable("https://10.example.com/x.pdf")).not.toThrow();
    });

    it("accepts DNS name 192.168.foo.com despite numeric prefix", () => {
      expect(() => assertExternallyReachable("https://192.168.foo.com/x.pdf")).not.toThrow();
    });

    it("accepts DNS name 127.example.com despite numeric prefix", () => {
      expect(() => assertExternallyReachable("https://127.example.com/x.pdf")).not.toThrow();
    });

    it("rejects literal DNS name localhost (case-insensitive)", () => {
      expect(() => assertExternallyReachable("http://localhost:3000/x.pdf")).toThrow(
        /not reachable/i,
      );
    });

    it("rejects uppercase LOCALHOST", () => {
      expect(() => assertExternallyReachable("http://LOCALHOST:3000/x.pdf")).toThrow(
        /not reachable/i,
      );
    });
  });

  describe("Error messages distinguish branches", () => {
    it("names the offending IPv4 host in the message", () => {
      expect(() => assertExternallyReachable("http://127.0.0.1/x.pdf")).toThrow(/127\.0\.0\.1/);
    });

    it("names localhost in the message", () => {
      expect(() => assertExternallyReachable("http://localhost:3000/x.pdf")).toThrow(/localhost/);
    });

    it("throws with distinct message for non-URL string", () => {
      expect(() => assertExternallyReachable("/api/media/x.pdf")).toThrow(/not an absolute URL/i);
    });
  });

  describe("Valid URLs", () => {
    it("accepts a real public https URL", () => {
      expect(() => assertExternallyReachable("https://idap.example.com/x.pdf")).not.toThrow();
    });

    it("accepts public IPv4 addresses", () => {
      expect(() => assertExternallyReachable("https://8.8.8.8/x.pdf")).not.toThrow();
    });

    it("accepts public IPv6 addresses", () => {
      expect(() => assertExternallyReachable("http://[2001:db8::1]/x.pdf")).not.toThrow();
    });
  });
});
