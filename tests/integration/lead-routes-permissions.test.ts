import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
// Aliased to tests/helpers/next-headers-stub.ts, whose cookie store is a plain
// module-level Map — so a test can put a real signed session cookie in front of
// the cookie branch of requireApiUser.
import { cookies } from "next/headers";
import { GET as listLeads, POST as createLead } from "@/app/api/leads/route";
import { PATCH as patchLead } from "@/app/api/leads/[id]/route";
import { POST as assignLead } from "@/app/api/leads/[id]/assign/route";
import { LeadService } from "@/services/lead.service";
import type { NextRequest } from "next/server";

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/leads");
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

async function signIn(institutionId: string, role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK", email: string) {
  const user = await makeUser(institutionId, role, email);
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

beforeAll(() => startTestDatabase("lead-routes-permissions"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("lead routes — permission enforcement", () => {
  it("a Counselor cannot create a lead — 403", async () => {
    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");

    const response = await createLead(
      cookieRequest({ body: { studentName: "Test", phone: "9876543210" }, origin: "http://localhost" }),
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk user can create a lead", async () => {
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await createLead(
      cookieRequest({ body: { studentName: "Test", phone: "9876543210" }, origin: "http://localhost" }),
    );
    // The live route returns 201 Created for a successful enquiry submission
    // (jsonSuccess({ lead }, { status: 201 })), predating this plan and
    // exercised today by tests/integration/bearer-routes.test.ts's "lets
    // ordinary staff create an enquiry" — permission wiring doesn't touch it.
    expect(response.status).toBe(201);
  });

  it("a Front Desk user cannot update a lead's status — 403", async () => {
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "Test", phone: "9876543210" },
      source: "API",
    });
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await patchLead(
      cookieRequest({
        url: `http://localhost/api/leads/${lead.id}`,
        body: { status: "CONTACTED" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk user cannot assign a lead — 403", async () => {
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "Test", phone: "9876543210" },
      source: "API",
    });
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await assignLead(
      cookieRequest({
        url: `http://localhost/api/leads/${lead.id}/assign`,
        body: { assignedTo: String(counselor._id) },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );
    expect(response.status).toBe(403);
  });

  it("an admin can assign a lead over HTTP", async () => {
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "Test", phone: "9876543210" },
      source: "API",
    });
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await assignLead(
      cookieRequest({
        url: `http://localhost/api/leads/${lead.id}/assign`,
        body: { assignedTo: String(counselor._id) },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.lead.assignedTo).toBe(String(counselor._id));
  });

  it("a counselor can set a follow-up date on their own lead via PATCH", async () => {
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "Test", phone: "9876543210" },
      source: "API",
    });
    const counselor = await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselor._id),
      actor: { id: "x", name: "x" },
    });

    const response = await patchLead(
      cookieRequest({
        url: `http://localhost/api/leads/${lead.id}`,
        body: { followUpAt: "2026-09-01" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.lead.followUpAt).toContain("2026-09-01");
  });

  it("a counselor's list only shows their own leads plus unassigned ones, over real HTTP", async () => {
    const counselorA = await makeUser("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const counselorB = await makeUser("INS0001", "COUNSELOR", "b@infinityschool.edu.in");
    const leadA = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "A's lead", phone: "9876543210" },
      source: "API",
    });
    const leadB = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "B's lead", phone: "9876543211" },
      source: "API",
    });
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: leadA.id,
      assignedTo: String(counselorA._id),
      actor: { id: "x", name: "x" },
    });
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: leadB.id,
      assignedTo: String(counselorB._id),
      actor: { id: "x", name: "x" },
    });

    // Signing in as counselorA directly (not via signIn(), which would call
    // makeUser() again with the same email and collide with the User model's
    // global unique index on email — counselorA already exists, created above
    // so its id could be used as the assignment target).
    const tokenA = await signSession({
      sub: String(counselorA._id),
      role: "COUNSELOR",
      institutionId: "INS0001",
      name: counselorA.name,
      email: counselorA.email,
      v: 0,
    });
    (await cookies()).set(SESSION_COOKIE, tokenA);
    const response = await listLeads(cookieRequest({ origin: "http://localhost" }));
    const payload = await response.json();

    const names = payload.items.map((item: { studentName: string }) => item.studentName);
    expect(names).toEqual(["A's lead"]);
  });
});
