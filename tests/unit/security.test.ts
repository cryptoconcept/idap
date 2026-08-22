import { describe, expect, it } from "vitest";
import { generateKeyId, generateSecret, hashSecret, verifySecret } from "@/lib/security/tokens";
import { hashPassword, verifyPassword } from "@/lib/security/password";
import { signSession, verifySessionToken } from "@/lib/auth/session";
import { escapeRegex, dateRangeFilter } from "@/lib/utils/serialize";
import { validateUpload } from "@/services/document.service";
import { AppError } from "@/lib/api/errors";

describe("API secrets", () => {
  it("verifies a secret against its own hash", () => {
    const secret = generateSecret();
    expect(verifySecret(secret, hashSecret(secret))).toBe(true);
  });

  it("rejects the wrong secret", () => {
    expect(verifySecret(generateSecret(), hashSecret(generateSecret()))).toBe(false);
  });

  it("rejects an empty secret or hash instead of passing vacuously", () => {
    const secret = generateSecret();
    expect(verifySecret("", hashSecret(secret))).toBe(false);
    expect(verifySecret(secret, "")).toBe(false);
  });

  it("never stores anything resembling the plaintext", () => {
    const secret = generateSecret();
    const hash = hashSecret(secret);
    expect(hash).not.toContain(secret);
    expect(hash).not.toContain(secret.slice(4, 24));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic, so a stored hash keeps verifying", () => {
    const secret = generateSecret();
    expect(hashSecret(secret)).toBe(hashSecret(secret));
  });

  it("generates distinct, well-formed credentials", () => {
    const keyIds = new Set(Array.from({ length: 200 }, generateKeyId));
    const secrets = new Set(Array.from({ length: 200 }, generateSecret));
    expect(keyIds.size).toBe(200);
    expect(secrets.size).toBe(200);
    expect([...keyIds].every((id) => /^ak_[a-z0-9]{24}$/.test(id))).toBe(true);
    expect([...secrets].every((s) => s.startsWith("sk_") && s.length > 40)).toBe(true);
  });
});

describe("passwords", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("Correct!Horse2026");
    expect(await verifyPassword("Correct!Horse2026", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("Correct!Horse2026");
    expect(await verifyPassword("correct!horse2026", hash)).toBe(false);
  });

  it("salts, so the same password hashes differently each time", async () => {
    expect(await hashPassword("Same!Password2026")).not.toBe(
      await hashPassword("Same!Password2026"),
    );
  });

  it("returns false rather than throwing on a missing hash", async () => {
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});

describe("session tokens", () => {
  const payload = {
    sub: "6a8880f3446c577c470cd06c",
    role: "INSTITUTION_ADMIN" as const,
    institutionId: "INS0001",
    name: "Institution Admin",
    email: "admin@example.test",
    v: 0,
  };

  it("round-trips a session", async () => {
    const verified = await verifySessionToken(await signSession(payload));
    expect(verified).toMatchObject(payload);
  });

  it("rejects a tampered token", async () => {
    const token = await signSession(payload);
    const [header, body, signature] = token.split(".");
    const forged = JSON.parse(Buffer.from(body, "base64url").toString());
    forged.role = "SUPER_ADMIN";
    const tampered = [
      header,
      Buffer.from(JSON.stringify(forged)).toString("base64url"),
      signature,
    ].join(".");

    expect(await verifySessionToken(tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession(payload);
    const previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "a-completely-different-secret-value-for-this-test";
    const verified = await verifySessionToken(token);
    process.env.AUTH_SECRET = previous;
    expect(verified).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    for (const bad of ["", "not-a-token", "a.b.c", "..."]) {
      expect(await verifySessionToken(bad)).toBeNull();
    }
  });

  it("carries the session version used to invalidate old sessions", async () => {
    const verified = await verifySessionToken(await signSession({ ...payload, v: 7 }));
    expect(verified?.v).toBe(7);
  });
});

describe("query building", () => {
  it("escapes regex metacharacters in a search term", () => {
    // Without this, a search string could act as an operator against Mongo.
    expect(escapeRegex(".*")).toBe("\\.\\*");
    expect(new RegExp(escapeRegex("a+b")).test("a+b")).toBe(true);
    expect(new RegExp(escapeRegex("a+b")).test("aab")).toBe(false);
  });

  it("builds an inclusive date range", () => {
    const range = dateRangeFilter("2026-08-01", "2026-08-31");
    expect(range?.$gte.getHours()).toBe(0);
    expect(range?.$lte.getHours()).toBe(23);
    expect(range?.$lte.getMinutes()).toBe(59);
  });

  it("returns undefined when neither bound is usable", () => {
    expect(dateRangeFilter(undefined, undefined)).toBeUndefined();
    expect(dateRangeFilter("not-a-date", "also-not")).toBeUndefined();
  });
});

describe("upload validation", () => {
  it("accepts an allowed type whose extension agrees", () => {
    const { safeFileName } = validateUpload({
      name: "photo.png",
      type: "image/png",
      size: 1024,
    });
    // The stored name is generated, never the one the client sent.
    expect(safeFileName).not.toContain("photo");
    expect(safeFileName).toMatch(/^[0-9a-f]{24}\.png$/);
  });

  it("rejects a disallowed content type", () => {
    expect(() => validateUpload({ name: "run.sh", type: "application/x-sh", size: 10 })).toThrow(
      AppError,
    );
  });

  it("rejects an extension that disagrees with the content type", () => {
    expect(() => validateUpload({ name: "payload.exe", type: "image/png", size: 10 })).toThrow(
      /extension does not match/i,
    );
  });

  it("rejects an oversized file", () => {
    expect(() =>
      validateUpload({ name: "big.pdf", type: "application/pdf", size: 6 * 1024 * 1024 }),
    ).toThrow(/5 MB or smaller/i);
  });

  it("rejects an empty file", () => {
    expect(() => validateUpload({ name: "empty.pdf", type: "application/pdf", size: 0 })).toThrow(
      /empty/i,
    );
  });

  it("generates a distinct name per upload of the same file", () => {
    const a = validateUpload({ name: "photo.jpg", type: "image/jpeg", size: 100 });
    const b = validateUpload({ name: "photo.jpg", type: "image/jpeg", size: 100 });
    expect(a.safeFileName).not.toBe(b.safeFileName);
  });
});
