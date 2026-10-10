import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { PlatformCredential } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";
import {
  loadScholarshipHubPartnerContext,
  loadScholarshipHubWebhookSecret,
  fetchScholarshipHubDocument,
} from "@/lib/connectors/scholarship-hub-partner-client";

const ORIGINAL_KEY = process.env.IDAP_CREDENTIAL_KEY;

beforeAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  return startTestDatabase("scholarship-hub-partner-client");
});
afterAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = ORIGINAL_KEY;
  return stopTestDatabase();
});
beforeEach(clearDatabase);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadScholarshipHubPartnerContext", () => {
  it("404s when no active credential exists", async () => {
    await expect(loadScholarshipHubPartnerContext()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("decrypts the platform key and returns a bound http client", async () => {
    await PlatformCredential.create({
      platform: "SCHOLARSHIP_HUB",
      keyEncrypted: encryptCredential("sh_pkey_test"),
      baseUrl: "https://hub.test",
      active: true,
    });

    const ctx = await loadScholarshipHubPartnerContext();
    expect(ctx.baseUrl).toBe("https://hub.test");
    expect(ctx.platformKey).toBe("sh_pkey_test");
    expect(typeof ctx.http).toBe("function");
  });
});

describe("loadScholarshipHubWebhookSecret", () => {
  it("returns null when no credential or no secret is set", async () => {
    expect(await loadScholarshipHubWebhookSecret()).toBeNull();
    await PlatformCredential.create({
      platform: "SCHOLARSHIP_HUB",
      keyEncrypted: encryptCredential("sh_pkey_test"),
      baseUrl: "https://hub.test",
      active: true,
    });
    expect(await loadScholarshipHubWebhookSecret()).toBeNull();
  });

  it("decrypts the webhook secret when set", async () => {
    await PlatformCredential.create({
      platform: "SCHOLARSHIP_HUB",
      keyEncrypted: encryptCredential("sh_pkey_test"),
      webhookSecretEncrypted: encryptCredential("sh_whsec_test"),
      baseUrl: "https://hub.test",
      active: true,
    });
    expect(await loadScholarshipHubWebhookSecret()).toBe("sh_whsec_test");
  });
});

describe("fetchScholarshipHubDocument", () => {
  it("fetches the exact partner document URL with the platform key as a bearer token", async () => {
    await PlatformCredential.create({
      platform: "SCHOLARSHIP_HUB",
      keyEncrypted: encryptCredential("sh_pkey_test"),
      baseUrl: "https://hub.test",
      active: true,
    });

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init.headers as Record<string, string>;
        return new Response("file-bytes", { status: 200 });
      }),
    );

    const response = await fetchScholarshipHubDocument("hub-app-1", "income_certificate");
    expect(response.status).toBe(200);
    expect(capturedUrl).toBe("https://hub.test/api/partner/applications/hub-app-1/documents/income_certificate/file");
    expect(capturedHeaders.Authorization).toBe("Bearer sh_pkey_test");
  });
});
