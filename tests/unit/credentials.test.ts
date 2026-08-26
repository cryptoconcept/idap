import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  credentialVaultReady,
  decryptCredential,
  encryptCredential,
} from "@/lib/security/credentials";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

describe("credential vault", () => {
  const original = process.env.IDAP_CREDENTIAL_KEY;
  beforeEach(() => {
    process.env.IDAP_CREDENTIAL_KEY = VALID_KEY;
  });
  afterEach(() => {
    process.env.IDAP_CREDENTIAL_KEY = original;
  });

  it("round-trips a credential", () => {
    const blob = encryptCredential("pp_pkey_secret_value");
    expect(blob).not.toContain("pp_pkey");
    expect(decryptCredential(blob)).toBe("pp_pkey_secret_value");
  });

  it("produces a different ciphertext each call (fresh IV)", () => {
    expect(encryptCredential("same")).not.toBe(encryptCredential("same"));
  });

  it("refuses a tampered ciphertext rather than returning garbage", () => {
    const blob = encryptCredential("secret");
    const [iv, ciphertext, tag] = blob.split(".");

    // Flip one bit in the ciphertext, preserving its LENGTH and leaving the
    // IV and auth tag untouched and well-formed. That matters: replacing the
    // ciphertext wholesale — or dropping the tag — makes GCM's final() throw
    // for a structural reason, so the test would pass even if setAuthTag()
    // were never called and nothing were authenticated at all. With the tag
    // still valid-shaped and set, a tag MISMATCH is the only thing left that
    // can reject this.
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[0] ^= 0x01;

    expect(() => decryptCredential([iv, bytes.toString("base64"), tag].join("."))).toThrow();
  });

  it("reports not-ready (and never throws) when the env key is absent", () => {
    delete process.env.IDAP_CREDENTIAL_KEY;
    expect(credentialVaultReady()).toBe(false);
  });

  it("reports not-ready for a key that is not 32 bytes", () => {
    process.env.IDAP_CREDENTIAL_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(credentialVaultReady()).toBe(false);
  });

  it("encrypt/decrypt throw a clear error when the vault is not ready", () => {
    delete process.env.IDAP_CREDENTIAL_KEY;
    expect(() => encryptCredential("x")).toThrow(/IDAP_CREDENTIAL_KEY/);
  });
});
