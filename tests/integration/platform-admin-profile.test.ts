import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeProfiledInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
// Aliased to tests/helpers/next-headers-stub.ts, whose cookie store is a plain
// module-level Map — so a test can put a real signed session cookie in front of
// the cookie branch of requireUser / requireSuperAdmin.
import { cookies } from "next/headers";
import { GET, PATCH } from "@/app/api/institutions/[institutionId]/route";
import { Institution } from "@/models";
import type { NextRequest } from "next/server";

/** A request carrying only a session cookie, like the web dashboard. */
function cookieRequest(init: { body?: unknown; origin?: string } = {}) {
  const url = new URL("http://localhost/api/institutions/INS0001");
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

/** Shapes the dynamic-route `context` argument both handlers take. */
function contextFor(institutionId: string) {
  return { params: Promise.resolve({ institutionId }) } as never;
}

async function signInPlatformAdmin(email = "platform@example.test") {
  const user = await makeUser(undefined, "SUPER_ADMIN", email);
  const token = await signSession({
    sub: String(user._id),
    role: "SUPER_ADMIN",
    institutionId: undefined,
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
}

async function signInInstitutionAdmin(institutionId: string, email = "admin@example.test") {
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

describe("platform-admin institution routes", () => {
  beforeAll(async () => {
    await startTestDatabase("platformadminprofile");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
  });

  // The cookie store is module-level, so a session left behind would silently
  // authenticate the tests that expect no credentials at all.
  afterEach(async () => {
    (await cookies()).delete(SESSION_COOKIE);
  });

  it("returns the full profile of any institution to a platform admin", async () => {
    // A genuinely full profile — academic, management, facilities, tagline —
    // not just one field, since this is what the test claims to exercise.
    await makeProfiledInstitution("INS0001", { academic: { board: "State Board" } });
    await signInPlatformAdmin();

    const response = await GET(cookieRequest(), contextFor("INS0001"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.institution.institutionId).toBe("INS0001");
    expect(payload.profile.academic.board).toBe("State Board");
    expect(payload.profile.management.principalName).toBeTruthy();
    expect(payload.profile.facilities.length).toBeGreaterThan(0);
    expect(payload.completion.percent).toBeGreaterThanOrEqual(0);
  });

  it("lets a platform admin patch provisioning fields", async () => {
    await makeInstitution("INS0001", { institutionName: "Old Name", active: true });
    await signInPlatformAdmin();

    const response = await PATCH(
      cookieRequest({
        body: { institutionName: "New Name", regionCode: "KA-MYS", active: false },
        origin: "http://localhost",
      }),
      contextFor("INS0001"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.institution.institutionName).toBe("New Name");
    expect(payload.institution.regionCode).toBe("KA-MYS");
    expect(payload.institution.active).toBe(false);
  });

  it("strips profile-content fields from a platform-admin patch instead of applying them", async () => {
    await makeInstitution("INS0001", {
      description: "Original description",
      academic: { board: "State Board" },
      logoUrl: "https://original.example.test/logo.png",
    });
    await signInPlatformAdmin();

    const response = await PATCH(
      cookieRequest({
        body: {
          description: "Hijacked description",
          academic: { board: "CBSE" },
          logoUrl: "https://hijacked.example.test/logo.png",
        },
        origin: "http://localhost",
      }),
      contextFor("INS0001"),
    );

    expect(response.status).toBe(200);

    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
    expect(row?.description).toBe("Original description");
    expect(row?.academic?.board).toBe("State Board");
    expect(row?.logoUrl).toBe("https://original.example.test/logo.png");
  });

  it("refuses an institution admin's patch with 403", async () => {
    await makeInstitution("INS0001");
    await signInInstitutionAdmin("INS0001");

    const response = await PATCH(
      cookieRequest({ body: { institutionName: "New Name" }, origin: "http://localhost" }),
      contextFor("INS0001"),
    );

    expect(response.status).toBe(403);
  });

  it("rejects a patch with no session at all", async () => {
    await makeInstitution("INS0001");

    const response = await PATCH(
      cookieRequest({ body: { institutionName: "New Name" }, origin: "http://localhost" }),
      contextFor("INS0001"),
    );

    expect(response.status).toBe(401);
  });
});
