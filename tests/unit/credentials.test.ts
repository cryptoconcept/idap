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
    const parts = blob.split(".");
    parts[1] = Buffer.from("tampered-ciphertext!").toString("base64");
    expect(() => decryptCredential(parts.join("."))).toThrow();
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
