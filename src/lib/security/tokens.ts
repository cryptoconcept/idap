import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/** URL-safe base32-ish alphabet: no ambiguous characters, safe to read aloud. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export function generateKeyId(): string {
  return `ak_${randomString(24).toLowerCase()}`;
}

export function generateSecret(): string {
  // 48 bytes of entropy, base64url encoded.
  return `sk_${randomBytes(36).toString("base64url")}`;
}

/**
 * API secrets are high-entropy random strings, so a keyed one-way HMAC is the
 * right primitive: a slow KDF such as bcrypt would add per-request latency
 * without adding meaningful resistance to guessing 288 bits of randomness.
 */
export function hashSecret(secret: string): string {
  return createHmac("sha256", env.AUTH_SECRET).update(secret).digest("hex");
}

export function verifySecret(secret: string, expectedHash: string): boolean {
  if (!secret || !expectedHash) return false;
  const candidate = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
