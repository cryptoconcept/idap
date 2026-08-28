import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { POST as publishVacancy } from "@/app/api/settings/vacancies/[vacancyId]/publish/route";
import { VacancyService } from "@/services/vacancy.service";
import { PlatformCredential, Vacancy } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";
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

// ---------------------------------------------------------------------------
// eduFleet, for the publish route
//
// `vacancy-publish-service.test.ts` already covers WHICH contract a push uses,
// which credential authorises it, and how every eduFleet answer is recorded.
// None of that is re-tested here. What this file needs eduFleet for is the
// opposite: to make the publish route's own guards distinguishable. A tenant
// filter that lets a foreign vacancy through has to be observable as a push
// that SUCCEEDS — if the only reachable failure were "eduFleet is not
// configured", a 404 would prove nothing about scoping, because an unscoped
// route would 404 for the same unrelated reason.
//
// `fetch` is stubbed rather than the adapter faked, for the same reason that
// file gives: it keeps the real adapter and the real URL construction in the
// path, so "no HTTP call was made" means exactly that.
// ---------------------------------------------------------------------------

const PLATFORM_KEY = "ef_pkey_vacancy_routes";
const EDUFLEET_BASE_URL = "https://api.edufleet.test";
const VALID_VAULT_KEY = Buffer.alloc(32, 11).toString("base64");

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stubs `fetch` with one queued response per call, in order. */
function stubFetch(...responses: Response[]) {
  const mock = vi.fn();
  for (const response of responses) mock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The active platform credential — no grant anywhere, so every push here
 *  goes out under Contract One as an aggregated listing. */
async function makeEdufleetCredential() {
  return PlatformCredential.create({
    platform: "EDUFLEET",
    keyEncrypted: encryptCredential(PLATFORM_KEY),
    baseUrl: EDUFLEET_BASE_URL,
    active: true,
  });
}

/**
 * A vacancy that is already `OPEN` and already live on eduFleet — the state
 * the edit hook (spec §7's "Edit after publish issues a PATCH") acts on. The
 * listing is written after creation because `vacancyCreateSchema` is
 * `.strict()` and carries no `listing`.
 */
async function makeListedOpenVacancy(
  institutionId: string,
  listingOverrides: Record<string, unknown> = {},
) {
  const created = await makeVacancy(institutionId);
  await Vacancy.updateOne(
    { _id: created.id },
    {
      $set: {
        status: "OPEN",
        listing: {
          jobId: `ef-job-${created.id}`,
          externalJobId: created.id,
          contract: "AGGREGATED",
          lastPushedAt: new Date("2026-01-01T00:00:00.000Z"),
          claimState: "unclaimed",
          remoteStatus: "active",
          remoteSalaryMin: 25000,
          remoteSalaryMax: 40000,
          ...listingOverrides,
        },
      },
    },
  );
  return created;
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
  process.env.IDAP_CREDENTIAL_KEY = VALID_VAULT_KEY;
});

// The cookie store is module-level, so a session left behind would silently
// authenticate the tests that expect no credentials at all.
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
  vi.unstubAllGlobals();
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

describe("POST /api/settings/vacancies/[vacancyId]/publish", () => {
  /** An OPEN vacancy is the only status the publish route creates a listing
   *  for; `makeVacancy` produces DRAFTs, which the service refuses. */
  async function makeOpenVacancy(institutionId: string, overrides: Record<string, unknown> = {}) {
    const created = await makeVacancy(institutionId, overrides);
    await Vacancy.updateOne({ _id: created.id }, { $set: { status: "OPEN" } });
    return created;
  }

  function publishRequest(vacancyId: string, origin?: string) {
    return jsonRequest({
      url: `http://localhost/api/settings/vacancies/${vacancyId}/publish`,
      origin,
    });
  }

  const params = (vacancyId: string) =>
    ({ params: Promise.resolve({ vacancyId }) }) as never;

  it("publishes an OPEN vacancy and returns the recorded listing", async () => {
    const created = await makeOpenVacancy("INS0001");
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(201, {
        jobId: "ef-job-published",
        externalJobId: created.id,
        status: "active",
        claimStatus: "unclaimed",
        publicUrl: "https://edufleetexchange.test/jobs/maths-teacher/ef-job-published",
      }),
    );

    const response = await publishVacancy(
      publishRequest(created.id, "http://localhost"),
      params(created.id),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.outcome.status).toBe("PUSHED");
    expect(payload.outcome.listing.jobId).toBe("ef-job-published");
    expect(payload.outcome.listing.remoteStatus).toBe("active");
    // The card renders this as a link, so the route must actually carry it.
    expect(payload.outcome.listing.publicUrl).toBe(
      "https://edufleetexchange.test/jobs/maths-teacher/ef-job-published",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${EDUFLEET_BASE_URL}/api/partner/jobs`);

    const stored = await Vacancy.findById(created.id).lean();
    expect(stored?.listing?.jobId).toBe("ef-job-published");
  });

  /**
   * THE tenant test for this route, and the reason the eduFleet stub above
   * exists. `INS0002`'s vacancy is OPEN, its institution has a city, the
   * credential is active and `fetch` is primed to answer `201` — so the ONLY
   * thing standing between `INS0001`'s session and a live public advert for
   * another school's vacancy is the `institutionId` in
   * `VacancyPublishService.loadVacancy`'s filter.
   *
   * MUTATION CHECK: drop `institutionId` from that filter (make it
   * `Vacancy.findOne({ _id: toObjectId(vacancyId) })`) and this test fails on
   * the very first assertion — the response is a 200 carrying a `PUSHED`
   * outcome, the stubbed `fetch` is called once, and `INS0002`'s vacancy comes
   * back with a listing it never asked for. Asserting the status alone would
   * NOT distinguish it: an unscoped route reaching an unconfigured eduFleet
   * would 404 as well, for a completely different reason. Hence the three
   * assertions below the status: nothing was sent, and nothing was recorded.
   */
  it("MUTATION-DISTINGUISHING: 404s on another institution's vacancy, sends nothing and records nothing", async () => {
    const foreign = await makeOpenVacancy("INS0002");
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(201, { jobId: "ef-job-foreign", externalJobId: foreign.id, status: "active" }),
    );

    const response = await publishVacancy(
      publishRequest(foreign.id, "http://localhost"),
      params(foreign.id),
    );
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error.message).toBe("Vacancy not found");
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await Vacancy.findById(foreign.id).lean())?.listing).toBeUndefined();
  });

  it("MUTATION-DISTINGUISHING: rejects a cross-origin publish, sends nothing and records nothing", async () => {
    const created = await makeOpenVacancy("INS0001");
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(201, { jobId: "ef-job-csrf", externalJobId: created.id, status: "active" }),
    );

    const response = await publishVacancy(
      publishRequest(created.id, "https://not-the-app.test"),
      params(created.id),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await Vacancy.findById(created.id).lean())?.listing).toBeUndefined();
  });

  it("returns 401 without a session and publishes nothing", async () => {
    const created = await makeOpenVacancy("INS0001");
    await makeEdufleetCredential();
    const fetchMock = stubFetch(
      jsonResponse(201, { jobId: "ef-job-anon", externalJobId: created.id, status: "active" }),
    );

    const response = await publishVacancy(
      publishRequest(created.id, "http://localhost"),
      params(created.id),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await Vacancy.findById(created.id).lean())?.listing).toBeUndefined();
  });

  it("returns 403 for an authenticated platform admin and publishes nothing", async () => {
    const created = await makeOpenVacancy("INS0001");
    await makeEdufleetCredential();
    await signInPlatformAdmin();
    const fetchMock = stubFetch(
      jsonResponse(201, { jobId: "ef-job-admin", externalJobId: created.id, status: "active" }),
    );

    const response = await publishVacancy(
      publishRequest(created.id, "http://localhost"),
      params(created.id),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toBe(PLATFORM_ADMIN_DENIED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown id", async () => {
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");

    const response = await publishVacancy(
      publishRequest(UNKNOWN_ID, "http://localhost"),
      params(UNKNOWN_ID),
    );

    expect(response.status).toBe(404);
  });

  /**
   * A refusal the service made before the wire has to reach the browser as a
   * 4xx carrying its own words — that message is what the section toasts, and
   * it is the only thing telling an admin what to do. A `DRAFT` is the
   * cheapest of those refusals to reach and the one the UI's own gating is
   * built around.
   */
  it("returns the service's refusal verbatim for a DRAFT vacancy, and sends nothing", async () => {
    const created = await makeVacancy("INS0001"); // DRAFT by default
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(201, { jobId: "ef-job-draft", externalJobId: created.id, status: "active" }),
    );

    const response = await publishVacancy(
      publishRequest(created.id, "http://localhost"),
      params(created.id),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("VALIDATION_ERROR");
    expect(payload.error.message).toBe(
      "Set this vacancy to Open before publishing it to eduFleet Exchange",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The route's other half of the same rule: a push eduFleet ANSWERED is not a
   * failed request, however unwelcome the answer. A `403` comes back 200 with
   * a `BLOCKED` outcome and eduFleet's reason, because the push happened and
   * one of the school's daily write units is already spent — reporting it as a
   * 4xx would say "this didn't happen" about something that did, and would
   * invite the retry that spends another unit for the same answer.
   */
  it("returns a 403 from eduFleet as a 200 BLOCKED outcome carrying the reason", async () => {
    const created = await makeOpenVacancy("INS0001");
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    stubFetch(jsonResponse(403, { reason: "upgrade_required", message: "Plan is full" }));

    const response = await publishVacancy(
      publishRequest(created.id, "http://localhost"),
      params(created.id),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.outcome.status).toBe("BLOCKED");
    expect(payload.outcome.message).toMatch(/plan has no room for another live listing/i);
  });
});

/**
 * Spec §7 — "**Edit** after publish issues a `PATCH`". Exercised through the
 * PATCH route rather than the service so the whole chain is pinned: an ordinary
 * dashboard save has to reach eduFleet, and the three kinds of save that must
 * NOT spend one of the school's daily write units have to stay silent.
 */
describe("PATCH /api/settings/vacancies/[vacancyId] — the eduFleet edit hook", () => {
  const params = (vacancyId: string) => ({ params: Promise.resolve({ vacancyId }) }) as never;

  function editRequest(vacancyId: string, body: unknown) {
    return jsonRequest({
      url: `http://localhost/api/settings/vacancies/${vacancyId}`,
      body,
      origin: "http://localhost",
    });
  }

  it("PATCHes an edited field through to a live listing", async () => {
    const created = await makeListedOpenVacancy("INS0001");
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(200, {
        jobId: `ef-job-${created.id}`,
        externalJobId: created.id,
        title: "Senior Maths Teacher",
        status: "active",
        claimStatus: "unclaimed",
      }),
    );

    const response = await patchVacancy(
      editRequest(created.id, { title: "Senior Maths Teacher" }),
      params(created.id),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.title).toBe("Senior Maths Teacher");

    // Contract One addresses a job by `externalJobId`, and a PATCH must never
    // carry a `status` key — `patchJob` throws on one, because Contract Two
    // silently discards every other field in a body that has it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(String(url)).toBe(`${EDUFLEET_BASE_URL}/api/partner/jobs/${created.id}`);
    expect(init.method).toBe("PATCH");
    const sent = JSON.parse(init.body) as Record<string, unknown>;
    expect(sent.title).toBe("Senior Maths Teacher");
    expect("status" in sent).toBe(false);

    // The response the dashboard renders must carry the push, not the
    // pre-push copy: `lastPushedAt` moved off the fixture's date.
    expect(payload.vacancy.listing.lastPushedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });

  /**
   * A vacancy the school never published must stay unpublished however much it
   * is edited — publication takes an explicit action (spec §10).
   *
   * **Deliberately NOT marked mutation-distinguishing, and the reason is worth
   * recording rather than hiding.** Two independent guards defend this, and
   * either one alone is sufficient: `shouldPushEdit` refuses to call the push
   * at all without a live listing, and `repush`'s `allowCreate: false` makes
   * `pushFields` throw before it can reach `createJob`. Breaking either one on
   * its own leaves the other holding, so this test keeps passing under both
   * single mutations — it was tried, in both directions, and it passed both
   * times. Marking it anyway would be a claim the evidence does not support.
   * It stays as a plain regression test, which is what it honestly is; the
   * conditions of `shouldPushEdit` that ARE singly load-bearing get their own
   * mutation-distinguishing tests below.
   */
  it("an edit to an unpublished vacancy makes no HTTP call and creates no listing", async () => {
    const created = await makeVacancy("INS0001");
    await Vacancy.updateOne({ _id: created.id }, { $set: { status: "OPEN" } });
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(201, { jobId: "ef-should-not-exist", externalJobId: created.id, status: "active" }),
    );

    const response = await patchVacancy(
      editRequest(created.id, { title: "Edited but never published" }),
      params(created.id),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.title).toBe("Edited but never published");
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await Vacancy.findById(created.id).lean())?.listing).toBeUndefined();
  });

  /**
   * Neither of eduFleet's PATCH routes accepts a `subject` — `PartnerJobPatch`
   * and `SchoolJobPatch` do not declare one and neither update function looks
   * for it — so a subject change can only ever reach a public advert by
   * closing the listing and publishing a new one. Pushing this edit would send
   * eduFleet a body it already holds and spend one of the school's daily write
   * units doing it, `spendWrite` running before eduFleet validates anything.
   *
   * This is the case that isolates `shouldPushEdit`'s field gate: the vacancy
   * stays `OPEN`, the listing stays live, and nothing downstream would refuse
   * the push.
   *
   * MUTATION CHECK: make the third condition unconditionally true (`return
   * true || EDUFLEET_PATCHABLE_KEYS.some(...)`) and this fails — a `PATCH` is
   * sent for a field eduFleet cannot read.
   */
  it("MUTATION-DISTINGUISHING: a subject-only edit pushes nothing", async () => {
    const created = await makeListedOpenVacancy("INS0001");
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    const fetchMock = stubFetch(jsonResponse(200, { jobId: `ef-job-${created.id}`, status: "active" }));

    const response = await patchVacancy(
      editRequest(created.id, { subject: "Physics" }),
      params(created.id),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.subject).toBe("Physics");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The status dropdown on the dashboard sends `{ status }` and nothing else,
   * which is the commonest save in this section and must not touch eduFleet.
   * Unmarked: the guard that actually stops it here is the `status !== "OPEN"`
   * condition, which the FILLED test above already mutation-pins — this covers
   * the real request shape the UI sends rather than a second guard.
   */
  it("a status-only edit pushes nothing", async () => {
    const created = await makeListedOpenVacancy("INS0001");
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    const fetchMock = stubFetch(jsonResponse(200, { jobId: `ef-job-${created.id}`, status: "closed" }));

    const response = await patchVacancy(
      editRequest(created.id, { status: "FILLED" }),
      params(created.id),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).vacancy.status).toBe("FILLED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * A FIELD edit — not a status change — on a vacancy that is no longer open.
   * `repush` routes a `FILLED`/`CLOSED` vacancy to a CLOSE, so without the
   * `status !== "OPEN"` condition, fixing a typo in the title of a filled
   * vacancy would take its public advert down. The school never asked for
   * that; taking an advert down is what the "Close on eduFleet Exchange"
   * button is for.
   *
   * This is the one condition of `shouldPushEdit` that nothing downstream
   * repeats: the field gate passes (the title was touched), the listing is
   * live, and `repush` would go through with the close quite happily.
   *
   * MUTATION CHECK: drop `if (updated.status !== "OPEN") return false` and
   * this fails — a `PATCH .../jobs/{id}` carrying `{"status":"closed"}` is
   * sent and the listing's `remoteStatus` flips to `closed`.
   */
  it("MUTATION-DISTINGUISHING: editing a field on a FILLED vacancy does not close its advert", async () => {
    const created = await makeListedOpenVacancy("INS0001");
    await Vacancy.updateOne({ _id: created.id }, { $set: { status: "FILLED" } });
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    const fetchMock = stubFetch(jsonResponse(200, { jobId: `ef-job-${created.id}`, status: "closed" }));

    const response = await patchVacancy(
      editRequest(created.id, { title: "Filled, but the title had a typo" }),
      params(created.id),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.title).toBe("Filled, but the title had a typo");
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await Vacancy.findById(created.id).lean())?.listing?.remoteStatus).toBe("active");
  });

  /**
   * A listing eduFleet has already closed is not a listing an edit can update:
   * eduFleet cannot reopen an advert, so putting one back is a new publication
   * (the "Publish again" button), not a save.
   *
   * The observable harm the guard prevents is not an HTTP call — `pushFields`
   * would refuse this one too — but what that refusal LEAVES BEHIND. The
   * listing exists, so `recordPushFailure` succeeds in writing its reason, and
   * the card would show a school a red "This listing was closed on eduFleet
   * Exchange" every time they edited a perfectly ordinary vacancy whose advert
   * they had already, deliberately, taken down.
   *
   * MUTATION CHECK: drop `|| updated.listing.remoteStatus === "closed"` from
   * `shouldPushEdit` and this fails on the last assertion — a `blockedReason`
   * appears on a listing that has nothing wrong with it.
   */
  it("MUTATION-DISTINGUISHING: an edit to a closed listing pushes nothing and records no reason", async () => {
    const created = await makeListedOpenVacancy("INS0001", { remoteStatus: "closed" });
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    const fetchMock = stubFetch(jsonResponse(200, { jobId: `ef-job-${created.id}`, status: "active" }));

    const response = await patchVacancy(
      editRequest(created.id, { title: "Edited after the advert came down" }),
      params(created.id),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.title).toBe("Edited after the advert came down");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(payload.vacancy.listing.blockedReason).toBeUndefined();
    expect((await Vacancy.findById(created.id).lean())?.listing?.blockedReason).toBeUndefined();
  });

  /**
   * Clearing a bound is the one edit that provably cannot change the advert:
   * both patch types declare `number`, never `null`, and both routes gate on
   * `!== undefined`, so the key is omitted and eduFleet keeps what it holds.
   * Spending a write unit to send eduFleet its own values is exactly what
   * rule 3's quota shield exists to stop.
   */
  it("an edit that only clears a salary bound pushes nothing", async () => {
    const created = await makeListedOpenVacancy("INS0001");
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    const fetchMock = stubFetch(jsonResponse(200, { jobId: `ef-job-${created.id}`, status: "active" }));

    const response = await patchVacancy(
      editRequest(created.id, { salaryMin: null }),
      params(created.id),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.salaryMin).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    // eduFleet still holds the bound it was last told about, which is what the
    // dialog's warning quotes.
    expect(payload.vacancy.listing.remoteSalaryMin).toBe(25000);
  });

  /**
   * The edit is already written by the time the push runs, so a refused push
   * must not turn a saved edit into a failed request — the school would
   * re-enter a change that is already stored. It surfaces as `blockedReason`
   * on the listing instead, the same field and the same wording a refused
   * publish uses.
   */
  it("saves the edit and records the reason when eduFleet refuses the push", async () => {
    const created = await makeListedOpenVacancy("INS0001");
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    stubFetch(jsonResponse(403, { reason: "insufficient_scope", message: "no jobs:write" }));

    const response = await patchVacancy(
      editRequest(created.id, { title: "Edited while blocked" }),
      params(created.id),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.vacancy.title).toBe("Edited while blocked");
    expect(payload.vacancy.listing.blockedReason).toMatch(/does not allow IDAP to post jobs/i);
    expect((await Vacancy.findById(created.id).lean())?.title).toBe("Edited while blocked");
  });

  /**
   * The other half of the same rule, for a refusal raised BEFORE the wire.
   * `preflightPatch` merges the sent bounds over what eduFleet holds, so a
   * minimum raised above eduFleet's stored maximum is a 400 waiting to happen;
   * refusing locally saves the unit, and the reason still has to reach the
   * school rather than vanishing.
   */
  it("saves the edit and records the reason when the push is refused before the wire", async () => {
    const created = await makeListedOpenVacancy("INS0001");
    // The vacancy carries NO maximum while eduFleet still holds one (40000).
    // That gap is the whole reason `preflightPatch` merges against the remote
    // record: the push builds its body from the vacancy, so it sends no
    // maximum, IDAP's own salary-order check sees no pair to compare, and only
    // the merged view catches that a minimum of 45000 would be rejected
    // against the 40000 eduFleet keeps.
    await Vacancy.updateOne({ _id: created.id }, { $unset: { salaryMax: "" } });
    await makeEdufleetCredential();
    await signInWithCookie("INS0001");
    const fetchMock = stubFetch();

    const response = await patchVacancy(
      editRequest(created.id, { salaryMin: 45000 }),
      params(created.id),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.vacancy.salaryMin).toBe(45000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(payload.vacancy.listing.blockedReason).toMatch(/still has a salary maximum of 40000/i);
  });
});
