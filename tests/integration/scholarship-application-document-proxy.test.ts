import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { Types } from "mongoose";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { ScholarshipApplication, PlatformCredential } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";
import type { NextRequest } from "next/server";

const ORIGINAL_KEY = process.env.IDAP_CREDENTIAL_KEY;

beforeAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  return startTestDatabase("scholarship-application-document-proxy");
});
afterAll(() => {
  process.env.IDAP_CREDENTIAL_KEY = ORIGINAL_KEY;
  return stopTestDatabase();
});
beforeEach(clearDatabase);
afterEach(() => vi.unstubAllGlobals());

function routeRequest() {
  const url = new URL("http://localhost/api/scholarship-applications/x/documents/y/file");
  const headers = new Headers({ host: "localhost" });
  return { headers, nextUrl: url, url: url.toString() } as unknown as NextRequest;
}

async function signIn(institutionId: string, role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK") {
  const user = await makeUser(institutionId, role);
  const token = await signSession({ sub: String(user._id), role, institutionId, name: user.name, email: user.email, v: 0 });
  (await cookies()).set(SESSION_COOKIE, token);
  return user;
}

async function makeApplication(institutionId: string, documents: { key: string }[] = [{ key: "income_certificate" }]) {
  await PlatformCredential.create({ platform: "SCHOLARSHIP_HUB", keyEncrypted: encryptCredential("sh_pkey_test"), baseUrl: "https://hub.test", active: true });
  return ScholarshipApplication.create({
    institutionId, scholarshipId: new Types.ObjectId(), externalRef: `IDAP:${institutionId}:${new Types.ObjectId().toHexString()}`,
    hubApplicationId: "hub-app-1", applicant: { name: "Asha Rao" }, hubStatus: "submitted",
    documents: documents.map((d) => ({ ...d, label: "Income Certificate", filename: "income.pdf", contentType: "application/pdf" })),
    hubUpdatedAt: new Date(), lastSyncedAt: new Date(),
  });
}

describe("GET /api/scholarship-applications/[id]/documents/[key]/file", () => {
  it("streams the file when it belongs to this institution's application", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "INSTITUTION_ADMIN");
    const application = await makeApplication("INS0001");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("file-bytes", {
      status: 200,
      headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="income.pdf"' },
    })));

    const { GET } = await import("@/app/api/scholarship-applications/[id]/documents/[key]/file/route");
    const response = await GET(routeRequest(), {
      params: Promise.resolve({ id: String(application._id), key: "income_certificate" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await response.text()).toBe("file-bytes");
  });

  it("404s for another institution's application", async () => {
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
    await signIn("INS0001", "INSTITUTION_ADMIN");
    const application = await makeApplication("INS0002");

    const { GET } = await import("@/app/api/scholarship-applications/[id]/documents/[key]/file/route");
    const response = await GET(routeRequest(), {
      params: Promise.resolve({ id: String(application._id), key: "income_certificate" }),
    });
    expect(response.status).toBe(404);
  });

  it("404s for an unknown document key on a real application", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "INSTITUTION_ADMIN");
    const application = await makeApplication("INS0001");

    const { GET } = await import("@/app/api/scholarship-applications/[id]/documents/[key]/file/route");
    const response = await GET(routeRequest(), {
      params: Promise.resolve({ id: String(application._id), key: "nonexistent" }),
    });
    expect(response.status).toBe(404);
  });

  it("403s for FRONT_DESK, which holds no SCHOLARSHIP_APPLICATIONS_VIEW permission", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "FRONT_DESK");
    const application = await makeApplication("INS0001");

    const { GET } = await import("@/app/api/scholarship-applications/[id]/documents/[key]/file/route");
    const response = await GET(routeRequest(), {
      params: Promise.resolve({ id: String(application._id), key: "income_certificate" }),
    });
    expect(response.status).toBe(403);
  });
});
