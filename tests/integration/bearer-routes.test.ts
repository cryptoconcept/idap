import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signAccessToken } from "@/lib/auth/session";
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
});
