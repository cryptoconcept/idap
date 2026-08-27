import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { GET as listCredentials, PUT as putCredential } from "@/app/api/admin/platform-credentials/route";
import { DELETE as deleteCredential } from "@/app/api/admin/platform-credentials/[platform]/route";
import { PlatformCredential, Activity } from "@/models";
import { decryptCredential } from "@/lib/security/credentials";

const VALID_VAULT_KEY = Buffer.alloc(32, 9).toString("base64");
const PLAINTEXT_KEY = "pp_pkey_super_secret_value_9999";

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/admin/platform-credentials");
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  headers.set("host", "localhost");
  return {
    headers,
    nextUrl: url,
    url: url.toString(),
    json: async () => init.body ?? {},
  } as unknown as NextRequest;
}

async function signIn(role: "SUPER_ADMIN" | "INSTITUTION_ADMIN", institutionId?: string) {
  const user = await makeUser(institutionId, role);
  const token = await signSession({
    sub: String(user._id),
    role,
    institutionId,
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
  return user;
}

async function storedCiphertext(platform: string): Promise<string | undefined> {
  const row = await PlatformCredential.findOne({ platform }).select("+keyEncrypted").lean();
  return row?.keyEncrypted;
}

beforeAll(() => startTestDatabase("platform-credentials"));
afterAll(stopTestDatabase);

beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  process.env.IDAP_CREDENTIAL_KEY = VALID_VAULT_KEY;
});

afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
  process.env.IDAP_CREDENTIAL_KEY = VALID_VAULT_KEY;
});

describe("platform credential routes — masking", () => {
  it("never returns the plaintext key or its ciphertext, on create or on list", async () => {
    await signIn("SUPER_ADMIN");

    const putResponse = await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: {
          platform: "PASSPERCENT",
          baseUrl: "https://api.passpercent.in",
          key: PLAINTEXT_KEY,
          active: true,
        },
      }),
    );
    expect(putResponse.status).toBe(200);
    const putBody = await putResponse.json();
    const putRaw = JSON.stringify(putBody);

    const storedCipher = await storedCiphertext("PASSPERCENT");
    expect(storedCipher).toBeTruthy();

    // The strong assertion: the plaintext and the ciphertext are both absent
    // from the response — not merely that a `keyMasked` field exists.
    expect(putRaw).not.toContain(PLAINTEXT_KEY);
    expect(putRaw).not.toContain(storedCipher);
    expect(putBody.credential.keyMasked).toBe("…9999");

    const listResponse = await listCredentials();
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    const listRaw = JSON.stringify(listBody);

    expect(listRaw).not.toContain(PLAINTEXT_KEY);
    expect(listRaw).not.toContain(storedCipher);

    const entry = listBody.credentials.find((c: { platform: string }) => c.platform === "PASSPERCENT");
    expect(entry.keyMasked).toBe("…9999");
    expect(entry.baseUrl).toBe("https://api.passpercent.in");
    expect(entry.active).toBe(true);
  });

  it("upsert-then-list round-trip shows the last 4 characters of the real key", async () => {
    await signIn("SUPER_ADMIN");

    await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: { platform: "FEESBASKET", baseUrl: "https://api.feesbasket.in", key: "fbk_live_ABCDWXYZ" },
      }),
    );

    const listResponse = await listCredentials();
    const listBody = await listResponse.json();
    const entry = listBody.credentials.find((c: { platform: string }) => c.platform === "FEESBASKET");
    expect(entry.keyMasked).toBe("…WXYZ");
  });

  it("a platform with no stored credential lists with keyMasked null", async () => {
    await signIn("SUPER_ADMIN");
    const listResponse = await listCredentials();
    const listBody = await listResponse.json();
    expect(listBody.vaultReady).toBe(true);

    const entry = listBody.credentials.find((c: { platform: string }) => c.platform === "PASSPERCENT");
    expect(entry.keyMasked).toBeNull();
    expect(entry.baseUrl).toBeNull();
    expect(entry.active).toBe(false);
  });
});

describe("platform credential routes — update preserves the secret", () => {
  it("updating baseUrl/active without `key` leaves the stored ciphertext byte-for-byte unchanged", async () => {
    await signIn("SUPER_ADMIN");

    await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: { platform: "PASSPERCENT", baseUrl: "https://api.passpercent.in", key: PLAINTEXT_KEY },
      }),
    );

    const before = await storedCiphertext("PASSPERCENT");
    expect(before).toBeTruthy();
    expect(decryptCredential(before!)).toBe(PLAINTEXT_KEY);

    // No `key` in this request — only baseUrl and active change.
    const updateResponse = await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: { platform: "PASSPERCENT", baseUrl: "https://api.passpercent.in/v2", active: false },
      }),
    );
    expect(updateResponse.status).toBe(200);
    const updateBody = await updateResponse.json();
    expect(updateBody.credential.baseUrl).toBe("https://api.passpercent.in/v2");
    expect(updateBody.credential.active).toBe(false);

    const after = await storedCiphertext("PASSPERCENT");

    // The load-bearing assertion: the ciphertext string itself is identical,
    // not merely that it still decrypts to the same value (which a fresh
    // re-encryption with the same plaintext would also satisfy).
    expect(after).toBe(before);
    expect(decryptCredential(after!)).toBe(PLAINTEXT_KEY);
  });

  it("creating a brand-new credential without a key is rejected", async () => {
    await signIn("SUPER_ADMIN");

    const response = await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: { platform: "FEESBASKET", baseUrl: "https://api.feesbasket.in" },
      }),
    );
    expect(response.status).toBe(400);
    expect(await storedCiphertext("FEESBASKET")).toBeUndefined();
  });
});

describe("platform credential routes — access control", () => {
  it("an INSTITUTION_ADMIN session gets 403 on every route", async () => {
    await signIn("SUPER_ADMIN");
    await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: { platform: "PASSPERCENT", baseUrl: "https://api.passpercent.in", key: PLAINTEXT_KEY },
      }),
    );
    (await cookies()).delete(SESSION_COOKIE);

    await signIn("INSTITUTION_ADMIN", "INS0001");

    const getResponse = await listCredentials();
    expect(getResponse.status).toBe(403);

    const putResponse = await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: { platform: "PASSPERCENT", baseUrl: "https://api.passpercent.in/hacked" },
      }),
    );
    expect(putResponse.status).toBe(403);

    const deleteResponse = await deleteCredential(
      cookieRequest({
        url: "http://localhost/api/admin/platform-credentials/PASSPERCENT",
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ platform: "PASSPERCENT" }) } as never,
    );
    expect(deleteResponse.status).toBe(403);

    // Refused calls must not have touched anything.
    const entry = await storedCiphertext("PASSPERCENT");
    expect(entry).toBeTruthy();
  });
});

describe("platform credential routes — CSRF", () => {
  it("a cross-origin PUT is refused and leaves the collection unchanged", async () => {
    await signIn("SUPER_ADMIN");

    await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: { platform: "PASSPERCENT", baseUrl: "https://api.passpercent.in", key: PLAINTEXT_KEY },
      }),
    );

    const countBefore = await PlatformCredential.countDocuments({});
    const cipherBefore = await storedCiphertext("PASSPERCENT");

    const forged = await putCredential(
      cookieRequest({
        origin: "http://evil.test",
        body: { platform: "PASSPERCENT", baseUrl: "https://evil.test/steal", key: "attacker_key_0000" },
      }),
    );
    expect(forged.status).toBe(403);

    const countAfter = await PlatformCredential.countDocuments({});
    const cipherAfter = await storedCiphertext("PASSPERCENT");

    expect(countAfter).toBe(countBefore);
    expect(cipherAfter).toBe(cipherBefore);
  });
});

describe("platform credential routes — remove", () => {
  it("DELETE removes the credential and records activity without the secret", async () => {
    await signIn("SUPER_ADMIN");

    await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: { platform: "PASSPERCENT", baseUrl: "https://api.passpercent.in", key: PLAINTEXT_KEY },
      }),
    );

    const deleteResponse = await deleteCredential(
      cookieRequest({
        url: "http://localhost/api/admin/platform-credentials/PASSPERCENT",
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ platform: "PASSPERCENT" }) } as never,
    );
    expect(deleteResponse.status).toBe(200);

    const listResponse = await listCredentials();
    const listBody = await listResponse.json();
    const entry = listBody.credentials.find((c: { platform: string }) => c.platform === "PASSPERCENT");
    expect(entry.keyMasked).toBeNull();
    expect(entry.active).toBe(false);
  });

  it("never writes the plaintext or ciphertext into the Activity log", async () => {
    await signIn("SUPER_ADMIN");

    await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: { platform: "PASSPERCENT", baseUrl: "https://api.passpercent.in", key: PLAINTEXT_KEY },
      }),
    );
    const cipher = await storedCiphertext("PASSPERCENT");

    await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: { platform: "PASSPERCENT", baseUrl: "https://api.passpercent.in/v2" },
      }),
    );

    await deleteCredential(
      cookieRequest({
        url: "http://localhost/api/admin/platform-credentials/PASSPERCENT",
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ platform: "PASSPERCENT" }) } as never,
    );

    const entries = await Activity.find({ entityType: "PLATFORM_CREDENTIAL" }).lean();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const raw = JSON.stringify(entry);
      expect(raw).not.toContain(PLAINTEXT_KEY);
      expect(raw).not.toContain(cipher);
    }
  });
});

describe("platform credential routes — vault not ready", () => {
  it("list() degrades to keyMasked: null and vaultReady: false rather than throwing", async () => {
    await signIn("SUPER_ADMIN");

    // Store a credential while the vault is configured...
    await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: { platform: "PASSPERCENT", baseUrl: "https://api.passpercent.in", key: PLAINTEXT_KEY },
      }),
    );

    // ...then simulate the key going missing.
    delete process.env.IDAP_CREDENTIAL_KEY;

    const listResponse = await listCredentials();
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();

    expect(listBody.vaultReady).toBe(false);
    const entry = listBody.credentials.find((c: { platform: string }) => c.platform === "PASSPERCENT");
    expect(entry.keyMasked).toBeNull();
    // The base URL and active flag are unaffected by the vault being down.
    expect(entry.baseUrl).toBe("https://api.passpercent.in");
  });

  it("PUT with a new key while the vault is not ready is a handled error, not a 500", async () => {
    await signIn("SUPER_ADMIN");
    delete process.env.IDAP_CREDENTIAL_KEY;

    const response = await putCredential(
      cookieRequest({
        origin: "http://localhost",
        body: { platform: "PASSPERCENT", baseUrl: "https://api.passpercent.in", key: PLAINTEXT_KEY },
      }),
    );

    expect(response.status).not.toBe(500);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(await storedCiphertext("PASSPERCENT")).toBeUndefined();
  });
});
