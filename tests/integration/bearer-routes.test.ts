import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signAccessToken, signSession, SESSION_COOKIE } from "@/lib/auth/session";
// Aliased to tests/helpers/next-headers-stub.ts, whose cookie store is a plain
// module-level Map — so a test can put a real signed session cookie in front of
// the cookie branch of requireApiUser.
import { cookies } from "next/headers";
import { LeadService } from "@/services/lead.service";
import { createLeadSchema } from "@/lib/validation/lead";
import { GET as listLeads, POST as createLead } from "@/app/api/leads/route";
import { GET as listApplications, POST as createApplication } from "@/app/api/applications/route";
import { PATCH as decideApplication } from "@/app/api/applications/[applicationNumber]/route";
import { PATCH as patchLead } from "@/app/api/leads/[id]/route";
import { POST as assignLead } from "@/app/api/leads/[id]/assign/route";
import { Application, Lead } from "@/models";
import type { UserRole } from "@/lib/constants";
import type { NextRequest } from "next/server";

const leadInput = createLeadSchema.parse({
  studentName: "Rahul Kumar",
  phone: "9876543210",
  classInterested: "Grade 5",
});

/** A request carrying only a bearer token — no cookie, like a native app. */
function bearerRequest(
  token: string,
  init: { url?: string; body?: unknown; origin?: string } = {},
) {
  const url = new URL(init.url ?? "http://localhost/api/leads");
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (init.origin) headers.set("origin", init.origin);
  headers.set("host", "localhost");
  return {
    headers,
    nextUrl: url,
    url: url.toString(),
    json: async () => init.body ?? {},
  } as unknown as NextRequest;
}

/** A request carrying only a session cookie, like the web dashboard. */
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

async function signInWithCookie(institutionId: string, email = "cookie@example.test") {
  const user = await makeUser(institutionId, "INSTITUTION_ADMIN", email);
  const token = await signSession({
    sub: String(user._id),
    role: "INSTITUTION_ADMIN",
    institutionId,
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
}

async function tokenFor(institutionId: string | undefined, role: "INSTITUTION_ADMIN" | "SUPER_ADMIN" = "INSTITUTION_ADMIN", email?: string) {
  const user = await makeUser(institutionId, role, email);
  return signAccessToken({
    sub: String(user._id),
    role,
    institutionId,
    name: user.name,
    email: user.email,
    v: 0,
  });
}

/**
 * A bearer token for a freshly created staff user of any role, handing back the
 * user document too — the assignment tests need its id as the assignee target.
 * `tokenFor` above covers the admin/platform cases that don't.
 */
async function bearerFor(role: UserRole, institutionId: string, email: string) {
  const user = await makeUser(institutionId, role, email);
  const token = await signAccessToken({
    sub: String(user._id),
    role,
    institutionId,
    name: user.name,
    email: user.email,
    v: 0,
  });
  return { user, token };
}

describe("routes accept bearer tokens", () => {
  beforeAll(async () => {
    await startTestDatabase("bearerroutes");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
  });

  // The cookie store is module-level, so a session left behind would silently
  // authenticate the tests that expect no credentials at all.
  afterEach(async () => {
    (await cookies()).delete(SESSION_COOKIE);
  });

  it("serves a list to a bearer-authenticated caller", async () => {
    await LeadService.createLead({ institutionId: "INS0001", data: leadInput, source: "API" });
    const token = await tokenFor("INS0001");

    const response = await listLeads(bearerRequest(token));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.total).toBe(1);
  });

  it("still scopes a bearer caller to their own institution", async () => {
    // The whole isolation guarantee has to survive the new auth path.
    await LeadService.createLead({ institutionId: "INS0002", data: leadInput, source: "API" });
    const token = await tokenFor("INS0001");

    const payload = await (await listLeads(bearerRequest(token))).json();
    expect(payload.total).toBe(0);
  });

  it("refuses a platform admin on the bearer path too", async () => {
    const token = await tokenFor(undefined, "SUPER_ADMIN", "platform@example.test");
    const response = await listLeads(bearerRequest(token));

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cannot access institution data/i);
  });

  it("rejects a request with no credentials at all", async () => {
    const noAuth = { headers: new Headers(), nextUrl: new URL("http://localhost/api/leads"), json: async () => ({}) } as unknown as NextRequest;
    expect((await listLeads(noAuth)).status).toBe(401);
  });

  it("allows a cross-origin mutation when it is bearer-authenticated", async () => {
    // A native app has no meaningful Origin, and a bearer token is never
    // attached automatically, so CSRF cannot apply to it.
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "API",
    });
    const token = await tokenFor("INS0001");

    const response = await patchLead(
      bearerRequest(token, { body: { status: "CONTACTED" }, origin: "https://not-the-app.test" }),
      { params: Promise.resolve({ id: lead.leadNumber }) } as never,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).lead.status).toBe("CONTACTED");
  });

  it("refuses a platform admin creating an enquiry, even with an institutionId to hand", async () => {
    // POST /api/leads and POST /api/applications were the only write paths
    // reaching tenant data through user.institutionId rather than
    // tenantFilter(user) — the one function the isolation guarantee rests on.
    // Their own `!user.institutionId` guard passes for a platform admin who
    // carries one, so the record would be created under that institution.
    // The institutionId is populated deliberately, so a missing one can never
    // be what produces the 403 — the caller's role has to be.
    const token = await tokenFor("INS0001", "SUPER_ADMIN", "platform@example.test");

    const response = await createLead(
      bearerRequest(token, {
        url: "http://localhost/api/leads",
        body: { studentName: "Rahul Kumar", phone: "9876543210" },
      }),
    );

    expect(response.status).toBe(403);
    // The refusal moved one check earlier once requirePermission stopped being
    // skipped for bearer callers: SUPER_ADMIN holds no permissions at all, so
    // the permission layer turns it away before tenantFilter ever runs. Both
    // things that matter here — the 403 and the absent record — are unchanged,
    // and tenantFilter's own platform-admin message stays covered by "refuses a
    // platform admin on the bearer path too" (GET /api/leads, which has no
    // permission gate, so tenantFilter is what turns SUPER_ADMIN away there).
    expect((await response.json()).error.message).toMatch(/do not have access/i);
    expect(await Lead.countDocuments({})).toBe(0);
  });

  it("refuses a platform admin creating an application, even with an institutionId to hand", async () => {
    const token = await tokenFor("INS0001", "SUPER_ADMIN", "platform@example.test");

    const response = await createApplication(
      bearerRequest(token, {
        url: "http://localhost/api/applications",
        body: {
          academicYear: "2026-27",
          student: { firstName: "Rahul", lastName: "Kumar" },
          parent: { fatherName: "Rajesh Kumar", phone: "9876543210" },
          admission: { applyingFor: "Grade 5" },
        },
      }),
    );

    expect(response.status).toBe(403);
    // Applications are now gated by requirePermission exactly like leads (the
    // fix for the audit's H1 — the applications plane had no per-role gate at
    // all). So the refusal is the permission layer's, not tenantFilter's:
    // SUPER_ADMIN holds no permissions, so APPLICATIONS_CREATE turns it away
    // before tenantFilter runs. The 403 and the absent record are unchanged.
    expect((await response.json()).error.message).toMatch(/do not have access/i);
    expect(await Application.countDocuments({})).toBe(0);
  });

  it("H1 regression: FRONT_DESK cannot read applicant PII or decide an admission", async () => {
    // The audit's HIGH-1: the applications plane had no per-role gate, so
    // FRONT_DESK — granted zero application permissions — could list every
    // applicant's record and approve/reject admissions. Both must now 403.
    const { token } = await bearerFor("FRONT_DESK", "INS0001", "frontdesk@example.test");

    const listed = await listApplications(bearerRequest(token) as NextRequest);
    expect(listed.status).toBe(403);

    const decided = await decideApplication(
      bearerRequest(token, {
        url: "http://localhost/api/applications/INS0001-APP-000001",
        body: { status: "APPROVED" },
      }) as NextRequest,
      { params: Promise.resolve({ applicationNumber: "INS0001-APP-000001" }) },
    );
    expect(decided.status).toBe(403);
  });

  it("lets ordinary staff create an enquiry, scoped to their own institution", async () => {
    // The control for the two refusals above: they must not be satisfied by a
    // route that refuses everybody.
    const token = await tokenFor("INS0001", "INSTITUTION_ADMIN", "staff@example.test");

    const response = await createLead(
      bearerRequest(token, {
        url: "http://localhost/api/leads",
        body: { studentName: "Rahul Kumar", phone: "9876543210" },
      }),
    );

    expect(response.status).toBe(201);
    const created = await Lead.findOne({}).lean();
    expect(created!.institutionId).toBe("INS0001");
  });

  it("refuses a Counselor's bearer-token lead assignment, and leaves the lead unassigned", async () => {
    // The headline of the bearer permission bypass: POST /assign has no
    // ownership check behind it, so while requirePermission was skipped for
    // bearer callers a Counselor could sign in on mobile and pull any lead in
    // the institution — including a colleague's — onto themselves.
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "API",
    });
    const { user: counselor, token } = await bearerFor("COUNSELOR", "INS0001", "counselor@example.test");

    const response = await assignLead(
      bearerRequest(token, {
        url: `http://localhost/api/leads/${lead.id}/assign`,
        body: { assignedTo: String(counselor._id) },
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );

    expect(response.status).toBe(403);
    const after = await Lead.findById(lead.id).lean();
    expect(after!.assignedTo ?? null).toBeNull();
  });

  it("refuses a Counselor creating an enquiry over bearer, and writes nothing", async () => {
    // COUNSELOR does not hold LEADS_CREATE; the cookie path already refused
    // this, and the bearer path used to wave it through.
    const { token } = await bearerFor("COUNSELOR", "INS0001", "counselor@example.test");

    const response = await createLead(
      bearerRequest(token, {
        url: "http://localhost/api/leads",
        body: { studentName: "Rahul Kumar", phone: "9876543210" },
      }),
    );

    expect(response.status).toBe(403);
    expect(await Lead.countDocuments({})).toBe(0);
  });

  it("refuses a Front Desk status change over bearer with 403, not the ownership 404", async () => {
    // FRONT_DESK holds neither LEADS_UPDATE nor LEADS_SET_FOLLOWUP. The
    // ownership check inside updateStatus happened to stop this write anyway
    // (as a 404), so the status code is what distinguishes a permission layer
    // that runs on the bearer path from one that is skipped.
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "API",
    });
    const { token } = await bearerFor("FRONT_DESK", "INS0001", "frontdesk@example.test");

    const response = await patchLead(
      bearerRequest(token, {
        url: `http://localhost/api/leads/${lead.id}`,
        body: { status: "CONTACTED" },
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await Lead.findById(lead.id).lean())!.status).toBe("NEW");
  });

  it("refuses a Front Desk follow-up date over bearer with 403, not the ownership 404", async () => {
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "API",
    });
    const { token } = await bearerFor("FRONT_DESK", "INS0001", "frontdesk@example.test");

    const response = await patchLead(
      bearerRequest(token, {
        url: `http://localhost/api/leads/${lead.id}`,
        body: { followUpAt: "2026-09-01" },
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await Lead.findById(lead.id).lean())!.followUpAt ?? null).toBeNull();
  });

  it("still refuses a cross-origin mutation when it is cookie-authenticated", async () => {
    // The other half of the conditional CSRF rule, and the half with teeth:
    // browsers attach the session cookie automatically, so dropping this check
    // reopens CSRF across the whole dashboard. Making requireApiUser report
    // viaBearer for cookie callers disables it everywhere and, before this
    // test, left the suite entirely green.
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "API",
    });
    await signInWithCookie("INS0001");

    const response = await patchLead(
      cookieRequest({ body: { status: "CONTACTED" }, origin: "https://not-the-app.test" }),
      { params: Promise.resolve({ id: lead.leadNumber }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);
  });

  it("allows the same cookie mutation from its own origin", async () => {
    // The control for the test above. Without it a 403 could just as well mean
    // the cookie never authenticated at all, and the CSRF check would be
    // untested either way.
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: leadInput,
      source: "API",
    });
    await signInWithCookie("INS0001");

    const response = await patchLead(
      cookieRequest({ body: { status: "CONTACTED" }, origin: "http://localhost" }),
      { params: Promise.resolve({ id: lead.leadNumber }) } as never,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).lead.status).toBe("CONTACTED");
  });
});
