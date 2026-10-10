import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Types } from "mongoose";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { ScholarshipApplication } from "@/models";
import type { NextRequest } from "next/server";

beforeAll(() => startTestDatabase("scholarship-application-routes"));
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

function cookieRequest(init: { body?: unknown } = {}) {
  const url = new URL("http://localhost/api/scholarship-applications/x");
  const headers = new Headers({ host: "localhost" });
  return { headers, nextUrl: url, url: url.toString(), json: async () => init.body ?? {} } as unknown as NextRequest;
}

async function signIn(institutionId: string, role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK") {
  const user = await makeUser(institutionId, role);
  const token = await signSession({ sub: String(user._id), role, institutionId, name: user.name, email: user.email, v: 0 });
  (await cookies()).set(SESSION_COOKIE, token);
  return user;
}

async function makeApplication(institutionId: string, overrides: Record<string, unknown> = {}) {
  return ScholarshipApplication.create({
    institutionId, scholarshipId: new Types.ObjectId(), externalRef: `IDAP:${institutionId}:${new Types.ObjectId().toHexString()}`,
    hubApplicationId: new Types.ObjectId().toHexString(), applicant: { name: "Asha Rao" }, hubStatus: "submitted",
    hubUpdatedAt: new Date(), lastSyncedAt: new Date(), ...overrides,
  });
}

describe("PATCH /api/scholarship-applications/[id]", () => {
  it("updates reviewStatus for INSTITUTION_ADMIN", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "INSTITUTION_ADMIN");
    const application = await makeApplication("INS0001");

    const { PATCH } = await import("@/app/api/scholarship-applications/[id]/route");
    const response = await PATCH(cookieRequest({ body: { reviewStatus: "SHORTLISTED" } }), {
      params: Promise.resolve({ id: String(application._id) }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scholarshipApplication: { reviewStatus: string } };
    expect(body.scholarshipApplication.reviewStatus).toBe("SHORTLISTED");
  });

  it("403s for FRONT_DESK (no SCHOLARSHIP_APPLICATIONS_DECIDE)", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "FRONT_DESK");
    const application = await makeApplication("INS0001");

    const { PATCH } = await import("@/app/api/scholarship-applications/[id]/route");
    const response = await PATCH(cookieRequest({ body: { reviewStatus: "SHORTLISTED" } }), {
      params: Promise.resolve({ id: String(application._id) }),
    });
    expect(response.status).toBe(403);
  });

  it("a COUNSELOR can decide on an application assigned to them", async () => {
    await makeInstitution("INS0001");
    const counselor = await signIn("INS0001", "COUNSELOR");
    const application = await makeApplication("INS0001", { assignedTo: String(counselor._id) });

    const { PATCH } = await import("@/app/api/scholarship-applications/[id]/route");
    const response = await PATCH(cookieRequest({ body: { reviewStatus: "SHORTLISTED" } }), {
      params: Promise.resolve({ id: String(application._id) }),
    });
    expect(response.status).toBe(200);
  });

  it("a COUNSELOR can decide on an unassigned application", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "COUNSELOR");
    const application = await makeApplication("INS0001");

    const { PATCH } = await import("@/app/api/scholarship-applications/[id]/route");
    const response = await PATCH(cookieRequest({ body: { reviewStatus: "SHORTLISTED" } }), {
      params: Promise.resolve({ id: String(application._id) }),
    });
    expect(response.status).toBe(200);
  });

  it("404s for a COUNSELOR deciding on an application assigned to a DIFFERENT counselor (spec §4.6 visibility filter)", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "COUNSELOR");
    const otherCounselor = await makeUser("INS0001", "COUNSELOR", "other-counselor@example.test");
    const application = await makeApplication("INS0001", { assignedTo: String(otherCounselor._id) });

    const { PATCH } = await import("@/app/api/scholarship-applications/[id]/route");
    const response = await PATCH(cookieRequest({ body: { reviewStatus: "SHORTLISTED" } }), {
      params: Promise.resolve({ id: String(application._id) }),
    });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/scholarship-applications/[id]/assign", () => {
  it("assigns for INSTITUTION_ADMIN", async () => {
    await makeInstitution("INS0001");
    const admin = await signIn("INS0001", "INSTITUTION_ADMIN");
    const counselor = await makeUser("INS0001", "COUNSELOR");
    const application = await makeApplication("INS0001");
    void admin;

    const { POST } = await import("@/app/api/scholarship-applications/[id]/assign/route");
    const response = await POST(cookieRequest({ body: { assignedTo: String(counselor._id) } }), {
      params: Promise.resolve({ id: String(application._id) }),
    });
    expect(response.status).toBe(200);
  });

  it("403s for COUNSELOR (no SCHOLARSHIP_APPLICATIONS_ASSIGN)", async () => {
    await makeInstitution("INS0001");
    await signIn("INS0001", "COUNSELOR");
    const application = await makeApplication("INS0001");

    const { POST } = await import("@/app/api/scholarship-applications/[id]/assign/route");
    const response = await POST(cookieRequest({ body: { assignedTo: "someone" } }), {
      params: Promise.resolve({ id: String(application._id) }),
    });
    expect(response.status).toBe(403);
  });
});
