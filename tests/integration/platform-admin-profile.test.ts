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
import { platformInstitutionPatchSchema } from "@/lib/validation/institution";
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

/**
 * The only four fields a platform admin may change, per decision 3. Sorted, so
 * it can be compared straight against a sorted diff.
 */
const PROVISIONING_FIELDS = ["active", "institutionName", "institutionType", "regionCode"];

/** Field names whose values differ between two lean rows, ignoring bookkeeping. */
function changedFields(before: object, after: object): string[] {
  const rowBefore = before as Record<string, unknown>;
  const rowAfter = after as Record<string, unknown>;
  return [...new Set([...Object.keys(rowBefore), ...Object.keys(rowAfter)])]
    .filter((key) => key !== "updatedAt" && key !== "__v")
    .filter((key) => JSON.stringify(rowBefore[key]) !== JSON.stringify(rowAfter[key]))
    .sort();
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
    await makeProfiledInstitution("INS0001", {
      academic: { board: "State Board" },
      contactPerson: "Reception Desk",
      phone: "9876543210",
      email: "office@example.test",
      website: "https://example.test",
      address: "1 Main Road",
    });
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

    // Everything the institution detail screen's read-only profile summary
    // renders has to survive this response, or that panel silently shows a
    // column of em-dashes to the admin who came to it for support.
    expect(payload.profile.profileStatus).toBe("DRAFT");
    expect(payload.completion.percent).toBeGreaterThan(0);
    expect(payload.profile.tagline).toBeTruthy();
    expect(payload.profile.description).toBeTruthy();
    expect(payload.profile.contactPerson).toBe("Reception Desk");
    expect(payload.profile.phone).toBe("9876543210");
    expect(payload.profile.email).toBe("office@example.test");
    expect(payload.profile.website).toBe("https://example.test");
    expect(payload.profile.address).toBe("1 Main Road");
    expect(payload.profile.city).toBe("Mysore");
    expect(payload.profile.state).toBe("Karnataka");
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
    // A full profile, so every block the patch below tries to hijack has a
    // real prior value to be caught overwriting.
    await makeProfiledInstitution("INS0001", {
      description: "Original description",
      academic: { board: "State Board" },
      logoUrl: "https://original.example.test/logo.png",
      coverImageUrl: "https://original.example.test/cover.png",
    });
    await signInPlatformAdmin();

    const before = await Institution.findOne({ institutionId: "INS0001" }).lean();

    const response = await PATCH(
      cookieRequest({
        body: {
          // The four provisioning fields the schema allows, each given a value
          // that differs from the seed so it has to show up in the diff...
          institutionName: "Renamed",
          institutionType: "PU_COLLEGE",
          regionCode: "KA-MYS",
          active: false,
          // ...and every other field `updateProfileSchema` accepts.
          legalName: "Hijacked Legal Name",
          shortName: "Hijacked",
          tagline: "Hijacked tagline",
          description: "Hijacked description",
          establishedYear: 1999,
          logoUrl: "https://hijacked.example.test/logo.png",
          coverImageUrl: "https://hijacked.example.test/cover.png",
          address: "Hijacked address",
          city: "Hijacked city",
          state: "Hijacked state",
          contactPerson: "Hijacked Person",
          phone: "9999999999",
          email: "hijacked@example.test",
          website: "https://hijacked.example.test",
          addressLine2: "Hijacked line 2",
          locality: "Hijacked locality",
          district: "Hijacked district",
          country: "Hijackistan",
          contact: { whatsapp: "9999999999" },
          geo: { latitude: 1, longitude: 1 },
          academic: { board: "CBSE" },
          management: { principalName: "Hijacked Principal" },
          facilities: [{ code: "POOL", label: "Pool", available: true }],
          social: { facebook: "https://facebook.test/hijacked" },
          media: [{ kind: "IMAGE", url: "https://hijacked.example.test/g.png", status: "ACTIVE" }],
          slug: "hijacked-slug",
          profileStatus: "PUBLISHED",
        },
        origin: "http://localhost",
      }),
      contextFor("INS0001"),
    );

    expect(response.status).toBe(200);

    const after = await Institution.findOne({ institutionId: "INS0001" }).lean();

    // Exhaustive, not a probe of a few named keys: whatever moved in the stored
    // row has to be exactly the provisioning set and nothing else. Widening
    // `platformInstitutionPatchSchema` by one field fails here.
    expect(changedFields(before!, after!)).toEqual(PROVISIONING_FIELDS);

    // The allow-list this test compares against is the one the schema declares,
    // so the two can never silently drift apart.
    expect(Object.keys(platformInstitutionPatchSchema.shape).sort()).toEqual(PROVISIONING_FIELDS);

    // The provisioning fields really did apply — otherwise the diff above would
    // pass just as well on a route that wrote nothing at all.
    expect(after?.institutionName).toBe("Renamed");
    expect(after?.active).toBe(false);
    expect(after?.regionCode).toBe("KA-MYS");
    expect(after?.institutionType).toBe("PU_COLLEGE");
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
