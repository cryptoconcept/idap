import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM vault for third-party platform credentials. One env secret
 * (`IDAP_CREDENTIAL_KEY`, 32 bytes base64) instead of N platform keys in env;
 * ciphertexts live in MongoDB. Format: `iv.ciphertext.tag`, each base64.
 *
 * The vault being unconfigured DISABLES the connections feature with an
 * explicit message — it never crashes the app and never falls back to
 * storing plaintext.
 */
const ALGO = "aes-256-gcm";

function keyBytes(): Buffer | null {
  const raw = process.env.IDAP_CREDENTIAL_KEY;
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function credentialVaultReady(): boolean {
  return keyBytes() !== null;
}

function requireKey(): Buffer {
  const key = keyBytes();
  if (!key) {
    throw new Error(
      "IDAP_CREDENTIAL_KEY is missing or is not 32 base64-encoded bytes — platform connections are disabled until it is set",
    );
  }
  return key;
}

export function encryptCredential(plain: string): string {
  const key = requireKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, ciphertext, cipher.getAuthTag()]
    .map((part) => part.toString("base64"))
    .join(".");
}

export function decryptCredential(blob: string): string {
  const key = requireKey();
  const [iv, ciphertext, tag] = blob.split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
