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
import { GET as listLeads } from "@/app/api/leads/route";
import { PATCH as patchLead } from "@/app/api/leads/[id]/route";
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
