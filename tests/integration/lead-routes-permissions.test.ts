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
import { GET as getLead } from "@/app/api/leads/[id]/route";
import {
  GET as listNotes,
  POST as createNote,
} from "@/app/api/leads/[id]/notes/route";
import { GET as getDashboard } from "@/app/api/dashboard/route";
import { Note } from "@/models";
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

/**
 * Signs in an existing user rather than creating one. `signIn` above calls
 * makeUser, which collides with the User model's unique email index when the
 * counselor already had to be created up front to be an assignment target.
 */
async function signInAs(
  user: { _id: unknown; name: string; email: string },
  role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK",
) {
  const token = await signSession({
    sub: String(user._id),
    role,
    institutionId: "INS0001",
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
}

/**
 * Two counselors at one institution, each holding one lead. Every visibility
 * test below turns on the same question: can the caller reach the other one's.
 */
async function twoCounselorsWithALeadEach(names = { mine: "My lead", theirs: "Their lead" }) {
  const mineOwner = await makeUser("INS0001", "COUNSELOR", "owner@infinityschool.edu.in");
  const theirsOwner = await makeUser("INS0001", "COUNSELOR", "colleague@infinityschool.edu.in");
  const mine = await LeadService.createLead({
    institutionId: "INS0001",
    data: { studentName: names.mine, phone: "9876543210" },
    source: "API",
  });
  const theirs = await LeadService.createLead({
    institutionId: "INS0001",
    data: { studentName: names.theirs, phone: "9876543211" },
    source: "API",
  });
  for (const [lead, owner] of [
    [mine, mineOwner],
    [theirs, theirsOwner],
  ] as const) {
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(owner._id),
      // A real id, unlike the "x" the older tests in this file pass — the
      // activity record casts it to an ObjectId and logs a BSON error otherwise.
      actor: { id: String(owner._id), name: owner.name },
    });
  }
  return { mineOwner, theirsOwner, mine, theirs };
}

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

  it("a counselor cannot update the status of a lead assigned to someone else — 404", async () => {
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "Test", phone: "9876543210" },
      source: "API",
    });
    const counselorA = await makeUser("INS0001", "COUNSELOR", "owns-lead@infinityschool.edu.in");
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselorA._id),
      actor: { id: "x", name: "x" },
    });
    await signIn("INS0001", "COUNSELOR", "not-owner@infinityschool.edu.in");

    const response = await patchLead(
      cookieRequest({
        url: `http://localhost/api/leads/${lead.id}`,
        body: { status: "CONTACTED" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );
    expect(response.status).toBe(404);
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

  it("a counselor's search cannot reach a colleague's lead", async () => {
    // The search $or used to be assigned straight onto the filter, overwriting
    // the visibility clause's own $or — so adding ?q= to the list silently
    // widened it to the whole institution. Both leads match "Priya", so the
    // search term cannot be what separates them; only the scoping can.
    const { mineOwner } = await twoCounselorsWithALeadEach({
      mine: "Priya Mine",
      theirs: "Priya Theirs",
    });
    await signInAs(mineOwner, "COUNSELOR");

    const response = await listLeads(
      cookieRequest({ url: "http://localhost/api/leads?q=Priya", origin: "http://localhost" }),
    );
    const payload = await response.json();

    const names = payload.items.map((item: { studentName: string }) => item.studentName);
    expect(names).toEqual(["Priya Mine"]);
    expect(payload.total).toBe(1);
  });

  it("a counselor's search still finds their own lead", async () => {
    // The control for the test above: a scoping fix that returned nothing at
    // all would satisfy it just as well.
    const { mineOwner } = await twoCounselorsWithALeadEach({
      mine: "Priya Mine",
      theirs: "Priya Theirs",
    });
    await signInAs(mineOwner, "COUNSELOR");

    const payload = await (
      await listLeads(
        cookieRequest({ url: "http://localhost/api/leads?q=Mine", origin: "http://localhost" }),
      )
    ).json();

    expect(payload.total).toBe(1);
    expect(payload.items[0].studentName).toBe("Priya Mine");
  });

  it("a counselor gets 404 fetching a colleague's lead by id", async () => {
    // The lead number in the URL is sequential and therefore guessable, so the
    // detail read has to be scoped, not just the list.
    const { mineOwner, theirs } = await twoCounselorsWithALeadEach();
    await signInAs(mineOwner, "COUNSELOR");

    const response = await getLead(
      cookieRequest({ url: `http://localhost/api/leads/${theirs.id}`, origin: "http://localhost" }),
      { params: Promise.resolve({ id: theirs.id }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("a counselor can still fetch their own lead by id", async () => {
    const { mineOwner, mine } = await twoCounselorsWithALeadEach();
    await signInAs(mineOwner, "COUNSELOR");

    const response = await getLead(
      cookieRequest({ url: `http://localhost/api/leads/${mine.id}`, origin: "http://localhost" }),
      { params: Promise.resolve({ id: mine.id }) } as never,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).lead.studentName).toBe("My lead");
  });

  it("a counselor gets 404 listing the notes on a colleague's lead", async () => {
    // Notes carry the substance of a colleague's conversation with a family;
    // the note list is scoped by the lead's own visibility, nothing else.
    const { mineOwner, theirs } = await twoCounselorsWithALeadEach();
    await signInAs(mineOwner, "COUNSELOR");

    const response = await listNotes(
      cookieRequest({
        url: `http://localhost/api/leads/${theirs.id}/notes`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: theirs.id }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("the dashboard's recent enquiries exclude a colleague's lead", async () => {
    const { mineOwner } = await twoCounselorsWithALeadEach();
    await signInAs(mineOwner, "COUNSELOR");

    const response = await getDashboard(
      cookieRequest({ url: "http://localhost/api/dashboard", origin: "http://localhost" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(
      payload.recentLeads.map((lead: { studentName: string }) => lead.studentName),
    ).toEqual(["My lead"]);
  });

  it("a Front Desk user cannot add a note to a lead — 403", async () => {
    // The spec puts notes under LEADS_UPDATE, which FRONT_DESK never holds.
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "Test", phone: "9876543210" },
      source: "API",
    });
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await createNote(
      cookieRequest({
        url: `http://localhost/api/leads/${lead.id}/notes`,
        body: { note: "Called the parent" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );

    expect(response.status).toBe(403);
    expect(await Note.countDocuments({})).toBe(0);
  });

  it("a counselor cannot add a note to a colleague's lead — 404", async () => {
    const { mineOwner, theirs } = await twoCounselorsWithALeadEach();
    await signInAs(mineOwner, "COUNSELOR");

    const response = await createNote(
      cookieRequest({
        url: `http://localhost/api/leads/${theirs.id}/notes`,
        body: { note: "Not my lead to annotate" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: theirs.id }) } as never,
    );

    expect(response.status).toBe(404);
    expect(await Note.countDocuments({})).toBe(0);
  });

  it("a counselor can add a note to their own lead", async () => {
    // The control for both note refusals above.
    const { mineOwner, mine } = await twoCounselorsWithALeadEach();
    await signInAs(mineOwner, "COUNSELOR");

    const response = await createNote(
      cookieRequest({
        url: `http://localhost/api/leads/${mine.id}/notes`,
        body: { note: "Spoke to the parent" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: mine.id }) } as never,
    );

    expect(response.status).toBe(201);
    expect(await Note.countDocuments({})).toBe(1);
  });

  it("GET /api/leads?assignedTo=__unassigned__ returns only unassigned leads", async () => {
    const counselorA = await makeUser("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const unassignedLead = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "Nobody yet", phone: "9876543210" },
      source: "API",
    });
    const assignedLead = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "Already assigned", phone: "9876543211" },
      source: "API",
    });
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: assignedLead.id,
      assignedTo: String(counselorA._id),
      actor: { id: String(counselorA._id), name: counselorA.name },
    });
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await listLeads(
      cookieRequest({
        url: "http://localhost/api/leads?assignedTo=__unassigned__",
        origin: "http://localhost",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(
      payload.items.map((item: { studentName: string }) => item.studentName),
    ).toEqual(["Nobody yet"]);
  });

  it("GET /api/leads?assignedTo=<a-real-counselor-id> returns only that counselor's leads", async () => {
    const { mineOwner, mine } = await twoCounselorsWithALeadEach();
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await listLeads(
      cookieRequest({
        url: `http://localhost/api/leads?assignedTo=${String(mineOwner._id)}`,
        origin: "http://localhost",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(
      payload.items.map((item: { studentName: string }) => item.studentName),
    ).toEqual([mine.studentName]);
  });
});
