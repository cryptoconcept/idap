import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { GET as listVacancies, POST as createVacancy } from "@/app/api/settings/vacancies/route";
import {
  PATCH as patchVacancy,
  DELETE as deleteVacancy,
} from "@/app/api/settings/vacancies/[vacancyId]/route";
import { VacancyService } from "@/services/vacancy.service";
import { Vacancy } from "@/models";
import type { VacancyCreateInput } from "@/lib/validation/vacancy";
import { PLATFORM_ADMIN_DENIED } from "@/lib/tenant";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

/** An id shaped like a vacancy's but belonging to no record. */
const UNKNOWN_ID = "6a8bf44bf4e473b526efc999";

/** A different valid ObjectId a caller might try to smuggle in as `_id`. */
const SMUGGLED_ID = "6a8bf44bf4e473b526efc123";

const vacancyInput: VacancyCreateInput = {
  title: "Maths Teacher",
  subject: "Mathematics",
  description: "Teach grades 6-10",
  salaryMin: 25000,
  salaryMax: 40000,
  experienceRequired: 2,
  facilities: ["Provident Fund (PF)", "Paid leave"],
};

async function makeVacancy(institutionId: string, overrides: Record<string, unknown> = {}) {
  return VacancyService.create(institutionId, { ...vacancyInput, ...overrides }, actor);
}

/** A request carrying only a session cookie, for JSON body routes. */
function jsonRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/vacancies");
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

async function signInWithCookie(institutionId: string, email = "vacancies-admin@example.test") {
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
 * Platform-admin session: no `institutionId`, role `SUPER_ADMIN`.
 * `requireInstitution()` denies SUPER_ADMIN and any other institution-scoped
 * role (COUNSELOR, FRONT_DESK) through the same branch, so this one session
 * covers every non-admin role — same convention as
 * tests/integration/achievement-routes.test.ts / results-routes.test.ts.
 */
async function signInPlatformAdmin(email = "vacancies-platform-admin@example.test") {
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

beforeAll(async () => {
  await startTestDatabase("vacancy-routes");
  await Vacancy.syncIndexes();
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

describe("GET /api/settings/vacancies", () => {
  it("lists only the caller's vacancies", async () => {
    await makeVacancy("INS0001");
    await makeVacancy("INS0002");
    await signInWithCookie("INS0001");

    const response = await listVacancies();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancies).toHaveLength(1);
  });
});

describe("POST /api/settings/vacancies", () => {
  it("creates a vacancy over HTTP", async () => {
    await signInWithCookie("INS0001");

    const response = await createVacancy(
      jsonRequest({ body: vacancyInput, origin: "http://localhost" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.vacancy.title).toBe("Maths Teacher");
    expect(payload.vacancy.status).toBe("DRAFT");
  });

  it("rejects a body missing a required field", async () => {
    await signInWithCookie("INS0001");

    const { title: _title, ...rest } = vacancyInput;
    const response = await createVacancy(
      jsonRequest({ body: rest, origin: "http://localhost" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  // This is the test that pins the route's `.parse()`. `_id` is a real
  // Mongoose path with no re-assignment in `VacancyService.create` (only
  // `institutionId` is re-assigned after the spread — verified by reading
  // `vacancy.service.ts` before writing this test) and is not declared on
  // `vacancyCreateSchema`. Before `vacancyCreateSchema` gained `.strict()`
  // (Task 1, to keep the new `listing` block out of client input), an
  // undeclared `_id` was silently stripped and the create still succeeded
  // with a server-generated id; `.strict()` now rejects the whole request
  // instead. Either way a caller-chosen `_id` never reaches `Vacancy.create`
  // — but the response changed from 200 to 400, so this test had to change
  // with it. Without `.parse()` at all, this smuggled `_id` would flow
  // straight through and become the document's actual id.
  it("MUTATION-DISTINGUISHING: rejects a create body carrying an unrecognised _id key, and stores nothing", async () => {
    await signInWithCookie("INS0001");

    const response = await createVacancy(
      jsonRequest({ body: { ...vacancyInput, _id: SMUGGLED_ID }, origin: "http://localhost" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("VALIDATION_ERROR");
    expect(await Vacancy.findById(SMUGGLED_ID).lean()).toBeNull();
    expect(await Vacancy.countDocuments({})).toBe(0);
  });

  // `createdAt` is parse-only exactly like `_id`: not in
  // `vacancyCreateSchema`, never re-assigned by `VacancyService.create`, but
  // a real Mongoose path (`timestamps: true`) that `list` sorts by (`{
  // createdAt: -1 }`) — a smuggled value could pin a vacancy to the top of
  // every listing indefinitely. Same `.strict()`-driven change as the `_id`
  // test above: rejected outright now, rather than silently stripped.
  it("MUTATION-DISTINGUISHING: rejects a create body carrying an unrecognised createdAt key, and stores nothing", async () => {
    await signInWithCookie("INS0001");
    const smuggledCreatedAt = "2099-01-01T00:00:00.000Z";

    const response = await createVacancy(
      jsonRequest({
        body: { ...vacancyInput, createdAt: smuggledCreatedAt },
        origin: "http://localhost",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("VALIDATION_ERROR");
    expect(await Vacancy.countDocuments({})).toBe(0);
  });

  // A SECOND parse pin, alongside the `_id` one above. `status` is absent
  // from `vacancyCreateSchema` entirely, AND `VacancyService.create` never
  // re-assigns it after the spread — unlike `AchievementService.create`'s
  // `{ ...input, institutionId, status: "ACTIVE" }`. A Mongoose `default`
  // only fills in when the path is ABSENT, so without `.parse()` a smuggled
  // `status: "OPEN"` would persist exactly as sent, skipping the DRAFT
  // review step that exists to stop a half-written advert going live. Same
  // `.strict()`-driven change as above: rejected outright now.
  it("MUTATION-DISTINGUISHING: rejects a create body carrying an unrecognised status key, and stores nothing", async () => {
    await signInWithCookie("INS0001");

    const response = await createVacancy(
      jsonRequest({
        body: { ...vacancyInput, status: "OPEN" },
        origin: "http://localhost",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("VALIDATION_ERROR");
    expect(await Vacancy.countDocuments({})).toBe(0);
  });

  // Tenant scoping: institutionId comes from requireInstitution() and
  // nowhere else. Before `.strict()`, `institutionId` in the body was
  // silently stripped and `VacancyService.create` still re-assigned the
  // session's institutionId after the spread, so this request used to
  // succeed (200) under the caller's own institution regardless of what the
  // body claimed — and did NOT pin the route's `.parse()`, since the service
  // reassignment alone was already enough to protect it. `.strict()` now
  // rejects the body outright before that re-assignment is ever reached, so
  // this DOES now pin `.parse()`: without it, the smuggled `institutionId`
  // would flow through unrejected and the request would 200 again (still
  // correctly scoped, by the service's re-assignment). The service-level
  // re-assignment itself stays directly covered in
  // tests/integration/vacancy-service.test.ts's "ignores an institutionId key
  // smuggled into create input".
  it("MUTATION-DISTINGUISHING: rejects a create body naming another institution, and leaves both institutions' records untouched", async () => {
    const foreign = await makeVacancy("INS0002", { title: "INS0002 original" });
    const before = await Vacancy.findById(foreign.id).lean();
    await signInWithCookie("INS0001");

    const response = await createVacancy(
      jsonRequest({
        body: { ...vacancyInput, institutionId: "INS0002" },
        origin: "http://localhost",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("VALIDATION_ERROR");

    const after = await Vacancy.findById(foreign.id).lean();
    expect(after).toEqual(before);
    expect(await Vacancy.countDocuments({ institutionId: "INS0001" })).toBe(0);
  });

  it("MUTATION-DISTINGUISHING: rejects a cross-origin create and creates nothing", async () => {
    await signInWithCookie("INS0001");

    const response = await createVacancy(
      jsonRequest({ body: vacancyInput, origin: "https://not-the-app.test" }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);
    expect(await Vacancy.countDocuments({})).toBe(0);
  });

  it("returns 401 without a session and creates nothing", async () => {
    const response = await createVacancy(
      jsonRequest({ body: vacancyInput, origin: "http://localhost" }),
    );

    expect(response.status).toBe(401);
    expect(await Vacancy.countDocuments({})).toBe(0);
  });

  // requireInstitution() is INSTITUTION_ADMIN-only: it throws `forbidden` for
  // a SUPER_ADMIN session exactly as it does for COUNSELOR/FRONT_DESK — one
  // session covers every non-admin role.
  it("returns 403 for an authenticated platform admin and creates nothing", async () => {
    await signInPlatformAdmin();

    const response = await createVacancy(
      jsonRequest({ body: vacancyInput, origin: "http://localhost" }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toBe(PLATFORM_ADMIN_DENIED);
    expect(await Vacancy.countDocuments({})).toBe(0);
  });
});

describe("PATCH /api/settings/vacancies/[vacancyId]", () => {
  it("updates a vacancy over HTTP", async () => {
    const created = await makeVacancy("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${created.id}`,
        body: { title: "Senior Maths Teacher" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.title).toBe("Senior Maths Teacher");
  });

  // The three-state patch contract's load-bearing assertion, exercised
  // end-to-end through the route rather than the service: a route that
  // normalises the body or drops `null` on the way through would silently
  // turn "clear this field" into "leave it alone" — this repo shipped
  // exactly that bug once with media captions.
  it("MUTATION-DISTINGUISHING: clears the stored salaryMin when the patch sends an explicit null, not merely omitting the key", async () => {
    const created = await makeVacancy("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${created.id}`,
        body: { salaryMin: null },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.salaryMin).toBeUndefined();

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw).not.toHaveProperty("salaryMin");
  });

  it("leaves the stored salaryMin untouched when the patch omits it", async () => {
    const created = await makeVacancy("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${created.id}`,
        body: { title: "Renamed only" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.salaryMin).toBe(25000);

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.salaryMin).toBe(25000);
  });

  // Same three-state pair as salaryMin above, copied for salaryMax: the
  // route is field-agnostic today (it forwards `patch` wholesale), but a
  // future field-specific normalisation could regress just this one field
  // uncaught if only salaryMin were pinned here.
  it("MUTATION-DISTINGUISHING: clears the stored salaryMax when the patch sends an explicit null, not merely omitting the key", async () => {
    const created = await makeVacancy("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${created.id}`,
        body: { salaryMax: null },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.salaryMax).toBeUndefined();

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw).not.toHaveProperty("salaryMax");
  });

  it("leaves the stored salaryMax untouched when the patch omits it", async () => {
    const created = await makeVacancy("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${created.id}`,
        body: { title: "Renamed only" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.salaryMax).toBe(40000);

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.salaryMax).toBe(40000);
  });

  // Same pair again for experienceRequired — the third and last field this
  // three-state contract covers.
  it("MUTATION-DISTINGUISHING: clears the stored experienceRequired when the patch sends an explicit null, not merely omitting the key", async () => {
    const created = await makeVacancy("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${created.id}`,
        body: { experienceRequired: null },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.experienceRequired).toBeUndefined();

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw).not.toHaveProperty("experienceRequired");
  });

  it("leaves the stored experienceRequired untouched when the patch omits it", async () => {
    const created = await makeVacancy("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${created.id}`,
        body: { title: "Renamed only" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.experienceRequired).toBe(2);

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.experienceRequired).toBe(2);
  });

  it("MUTATION-DISTINGUISHING: rejects a cross-origin PATCH and leaves the record unchanged", async () => {
    const created = await makeVacancy("INS0001");
    const before = await Vacancy.findById(created.id).lean();
    await signInWithCookie("INS0001");

    const response = await patchVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${created.id}`,
        body: { title: "Should not apply", salaryMin: null },
        origin: "https://not-the-app.test",
      }),
      { params: Promise.resolve({ vacancyId: created.id }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);

    const after = await Vacancy.findById(created.id).lean();
    expect(after).toEqual(before);
  });

  it("returns 404 for another institution's vacancy and leaves it byte-for-byte unchanged", async () => {
    const foreign = await makeVacancy("INS0002");
    const before = await Vacancy.findById(foreign.id).lean();
    await signInWithCookie("INS0001");

    const response = await patchVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${foreign.id}`,
        body: { title: "Hacked" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: foreign.id }) } as never,
    );

    expect(response.status).toBe(404);
    const after = await Vacancy.findById(foreign.id).lean();
    expect(after).toEqual(before);
  });

  it("returns 404 for an unknown id", async () => {
    await signInWithCookie("INS0001");

    const response = await patchVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${UNKNOWN_ID}`,
        body: { title: "Nope" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: UNKNOWN_ID }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("returns 401 without a session and leaves the record unchanged", async () => {
    const created = await makeVacancy("INS0001");
    const before = await Vacancy.findById(created.id).lean();

    const response = await patchVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${created.id}`,
        body: { title: "Should not apply" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: created.id }) } as never,
    );

    expect(response.status).toBe(401);
    const after = await Vacancy.findById(created.id).lean();
    expect(after).toEqual(before);
  });
});

describe("DELETE /api/settings/vacancies/[vacancyId]", () => {
  it("removes a vacancy over HTTP", async () => {
    const created = await makeVacancy("INS0001");
    await signInWithCookie("INS0001");

    const response = await deleteVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.deleted).toBe(true);
    expect(await Vacancy.findById(created.id).lean()).toBeNull();
  });

  it("MUTATION-DISTINGUISHING: rejects a cross-origin DELETE and leaves the record intact", async () => {
    const created = await makeVacancy("INS0001");
    await signInWithCookie("INS0001");

    const response = await deleteVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${created.id}`,
        origin: "https://not-the-app.test",
      }),
      { params: Promise.resolve({ vacancyId: created.id }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);
    expect(await Vacancy.findById(created.id).lean()).not.toBeNull();
  });

  it("returns 404 for another institution's vacancy and leaves it intact", async () => {
    const foreign = await makeVacancy("INS0002");
    await signInWithCookie("INS0001");

    const response = await deleteVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${foreign.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: foreign.id }) } as never,
    );

    expect(response.status).toBe(404);
    expect(await Vacancy.findById(foreign.id).lean()).not.toBeNull();
  });

  it("returns 404 for an unknown id", async () => {
    await signInWithCookie("INS0001");

    const response = await deleteVacancy(
      jsonRequest({
        url: `http://localhost/api/settings/vacancies/${UNKNOWN_ID}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ vacancyId: UNKNOWN_ID }) } as never,
    );

    expect(response.status).toBe(404);
  });

  // No separate 401 here: DELETE shares the exact same `requireInstitution()`
  // guard as PATCH above, in the same file — that branch is already pinned
  // there, same reasoning as the single SUPER_ADMIN 403 covering every
  // non-admin role rather than one test per role.
});
