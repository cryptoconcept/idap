import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Types } from "mongoose";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { GET as listAlumni, POST as createAlumnus } from "@/app/api/settings/alumni/route";
import {
  PATCH as patchAlumnus,
  DELETE as deleteAlumnus,
} from "@/app/api/settings/alumni/[alumnusId]/route";
import { POST as uploadAlumnusPhoto } from "@/app/api/settings/alumni/[alumnusId]/photo/route";
import { AlumniService } from "@/services/alumni.service";
import { Alumnus } from "@/models";
import { storage } from "@/lib/storage";
// The image cap has exactly one name, imported by both the route and these
// tests rather than re-declared — this is the limit an oversized upload must
// exceed to be refused, at the route before `arrayBuffer()` and again inside
// `validateImage`.
import { MAX_IMAGE_BYTES } from "@/lib/media/image";

// `storage.get()` reads the adapter's PRIVATE store, never where `putPublic`
// writes — same helper as tests/integration/showcase-assets.test.ts and
// tests/integration/achievement-routes.test.ts, which this mirrors.
const PUBLIC_ROOT = resolve(process.env.PUBLIC_UPLOAD_DIR ?? join(process.cwd(), ".uploads-public"));
const storedPath = (key: string) => resolve(PUBLIC_ROOT, key.replace(/^\/api\/media\//, ""));

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

/** An id shaped like an alumnus's but belonging to no record. */
const UNKNOWN_ID = "6a8bf44bf4e473b526efc999";

/** Smallest valid PNG — the upload guard sniffs magic numbers, so this must be real. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const alumnusInput = {
  name: "Asha Rao",
  batch: "2012-2015",
  category: "ENGINEER" as const,
  currentRole: "Software Engineer",
  org: "Acme Corp",
  note: "Class topper",
};

async function makeAlumnus(institutionId: string, overrides: Record<string, unknown> = {}) {
  return AlumniService.create(institutionId, { ...alumnusInput, ...overrides }, actor);
}

/** A request carrying only a session cookie, for JSON body routes. */
function jsonRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/alumni");
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

/** A request carrying only a session cookie and a multipart body. */
function formRequest(url: string, form: FormData, init: { origin?: string } = {}) {
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  headers.set("host", "localhost");
  return {
    headers,
    nextUrl: new URL(url),
    url,
    formData: async () => form,
  } as unknown as NextRequest;
}

async function signInWithCookie(institutionId: string, email = "alumni-admin@example.test") {
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
 * `requireInstitution()` (`src/lib/tenant/index.ts`) requires role exactly
 * `INSTITUTION_ADMIN` — it denies SUPER_ADMIN and any other institution-
 * scoped role (COUNSELOR, FRONT_DESK) alike, through the same branch, not
 * merely the unauthenticated case the 401 tests cover. Same convention as
 * tests/integration/results-routes.test.ts's `signInPlatformAdmin` and
 * tests/integration/achievement-routes.test.ts's.
 */
async function signInPlatformAdmin(email = "alumni-platform-admin@example.test") {
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
  await startTestDatabase("alumni-routes");
  await Alumnus.syncIndexes();
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

describe("GET /api/settings/alumni", () => {
  it("lists only the caller's alumni", async () => {
    await makeAlumnus("INS0001");
    await makeAlumnus("INS0002");
    await signInWithCookie("INS0001");

    const response = await listAlumni();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alumni).toHaveLength(1);
  });
});

describe("POST /api/settings/alumni", () => {
  it("creates an alumnus over HTTP", async () => {
    await signInWithCookie("INS0001");

    const response = await createAlumnus(
      jsonRequest({ body: alumnusInput, origin: "http://localhost" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.alumnus.name).toBe("Asha Rao");
    expect(payload.alumnus.status).toBe("ACTIVE");
  });

  it("rejects a body missing a required field", async () => {
    await signInWithCookie("INS0001");

    const response = await createAlumnus(
      jsonRequest({ body: { name: "No Category" }, origin: "http://localhost" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  // Requirement: institutionId comes from requireInstitution() and nowhere
  // else. A body carrying a foreign institutionId must not move the record
  // there, and must not touch that institution's existing data.
  it("MUTATION-DISTINGUISHING: creates the record under the caller's institution even when the body names another institution, and leaves that institution's own record untouched", async () => {
    const foreign = await makeAlumnus("INS0002", { name: "INS0002 original" });
    const before = await Alumnus.findById(foreign.id).lean();
    await signInWithCookie("INS0001");

    const response = await createAlumnus(
      jsonRequest({
        body: { ...alumnusInput, institutionId: "INS0002" },
        origin: "http://localhost",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);

    const raw = await Alumnus.findById(payload.alumnus.id).lean();
    expect(raw?.institutionId).toBe("INS0001");

    const after = await Alumnus.findById(foreign.id).lean();
    expect(after).toEqual(before);
  });

  // `institutionId` survives a smuggled body only because
  // `AlumniService.create` re-assigns it after the object spread
  // (`{ ...input, institutionId, status: "ACTIVE" }`) — `photo` and `_id`
  // get no such re-assignment. `photo` is an ordinary schema path
  // (`Alumnus.ts`) the model will happily persist, and `_id` is a real
  // Mongoose path `create` never touches, so `.parse()` at the route is the
  // ONLY thing standing between a raw body and an attacker choosing either:
  // a storage key that bypasses the upload endpoint entirely — no
  // magic-byte check, no size cap, none of Task 7's rollback machinery, and
  // no proof the key even belongs to this institution's storage prefix — or
  // the document's own id.
  it("MUTATION-DISTINGUISHING: strips photo and _id from the create body — a caller cannot plant a storage key or choose the document id", async () => {
    await signInWithCookie("INS0001");
    const attackerId = new Types.ObjectId().toHexString();

    const response = await createAlumnus(
      jsonRequest({
        body: {
          ...alumnusInput,
          _id: attackerId,
          photo: "showcase/INS0002/alumni/deadbeef.jpg",
        },
        origin: "http://localhost",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alumnus.id).not.toBe(attackerId);

    // The raw stored document, not the DTO: `serialize` already turns a
    // missing `photo` into `undefined` on the way out, so asserting only the
    // response would pass even if the field were stored non-empty.
    const raw = await Alumnus.findById(payload.alumnus.id).lean();
    expect(raw).not.toHaveProperty("photo");
  });

  it("MUTATION-DISTINGUISHING: rejects a cross-origin create and creates nothing", async () => {
    await signInWithCookie("INS0001");

    const response = await createAlumnus(
      jsonRequest({ body: alumnusInput, origin: "https://not-the-app.test" }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);
    expect(await Alumnus.countDocuments({})).toBe(0);
  });

  // `requireInstitution()` is otherwise only pinned indirectly, through every
  // other test's signed-in session. No cookie at all must 401 before
  // `alumnusCreateSchema.parse` or the service ever runs.
  it("returns 401 without a session and creates nothing", async () => {
    const response = await createAlumnus(
      jsonRequest({ body: alumnusInput, origin: "http://localhost" }),
    );

    expect(response.status).toBe(401);
    expect(await Alumnus.countDocuments({})).toBe(0);
  });

  // `requireInstitution()` is INSTITUTION_ADMIN-only: it throws `forbidden`
  // for a SUPER_ADMIN session exactly as it does for a COUNSELOR or
  // FRONT_DESK one — the platform admin has no route to institution-owned
  // alumni data, same boundary results-routes.test.ts and
  // achievement-routes.test.ts pin.
  it("returns 403 for an authenticated platform admin and creates nothing", async () => {
    await signInPlatformAdmin();

    const response = await createAlumnus(
      jsonRequest({ body: alumnusInput, origin: "http://localhost" }),
    );

    expect(response.status).toBe(403);
    expect(await Alumnus.countDocuments({})).toBe(0);
  });
});

describe("PATCH /api/settings/alumni/[alumnusId]", () => {
  it("updates an alumnus over HTTP", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        body: { currentRole: "Senior Software Engineer" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alumnus.currentRole).toBe("Senior Software Engineer");
  });

  // Three-state patch contract, first half: `batch`. Absent means leave
  // alone. Exercised end-to-end through the route rather than the service —
  // a route that normalises the body would silently turn "don't touch this"
  // into an overwrite.
  it("leaves the stored batch untouched when the patch omits it", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        body: { name: "Renamed only" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alumnus.batch).toBe("2012-2015");

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw?.batch).toBe("2012-2015");
  });

  // The three-state patch contract's load-bearing assertion, exercised
  // end-to-end through the route: a route that normalises the body or drops
  // `null` on the way through would silently turn "clear this field" into
  // "leave it alone" — the exact bug this project already shipped once, for
  // media captions.
  it("MUTATION-DISTINGUISHING: clears the stored batch when the patch sends an explicit null, not merely omitting the key", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        body: { batch: null },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alumnus.batch).toBeUndefined();

    // The raw stored document, not just the DTO: a DTO can report success
    // over a write that did nothing.
    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("batch");
  });

  // Second field covering the identical `optionalText(n).nullable()`
  // construct as `batch`, chosen because it takes a different max length
  // (120 vs 20) and a different semantic role (organisation vs cohort), so
  // together the two prove the construct is wired generically rather than
  // for one field's sake.
  it("leaves the stored org untouched when the patch omits it", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        body: { name: "Renamed only" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alumnus.org).toBe("Acme Corp");

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw?.org).toBe("Acme Corp");
  });

  it("MUTATION-DISTINGUISHING: clears the stored org when the patch sends an explicit null, not merely omitting the key", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        body: { org: null },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alumnus.org).toBeUndefined();

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("org");
  });

  // `currentRole` and `note` complete the set: all four of the alumnus's
  // clearable fields are now pinned at the route as well as at the service.
  // The route is where a "spread and rebuild the patch" refactor would drop a
  // `null` on the floor, and covering only two of four left the other two
  // resting on the assumption that whatever holds for `batch` and `org` holds
  // for them — which is exactly the assumption a refactor breaks.
  it("leaves the stored currentRole untouched when the patch omits it", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        body: { name: "Renamed only" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alumnus.currentRole).toBe("Software Engineer");

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw?.currentRole).toBe("Software Engineer");
  });

  it("MUTATION-DISTINGUISHING: clears the stored currentRole when the patch sends an explicit null, not merely omitting the key", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        body: { currentRole: null },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alumnus.currentRole).toBeUndefined();

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("currentRole");
  });

  it("leaves the stored note untouched when the patch omits it", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        body: { name: "Renamed only" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alumnus.note).toBe("Class topper");

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw?.note).toBe("Class topper");
  });

  it("MUTATION-DISTINGUISHING: clears the stored note when the patch sends an explicit null, not merely omitting the key", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        body: { note: null },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alumnus.note).toBeUndefined();

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("note");
  });

  it("MUTATION-DISTINGUISHING: rejects a cross-origin PATCH and leaves the record unchanged", async () => {
    const created = await makeAlumnus("INS0001");
    const before = await Alumnus.findById(created.id).lean();
    await signInWithCookie("INS0001");

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        body: { name: "Should not apply", batch: null },
        origin: "https://not-the-app.test",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);

    const after = await Alumnus.findById(created.id).lean();
    expect(after).toEqual(before);
  });

  it("returns 404 for another institution's alumnus and leaves it untouched", async () => {
    const foreign = await makeAlumnus("INS0002");
    const before = await Alumnus.findById(foreign.id).lean();
    await signInWithCookie("INS0001");

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${foreign.id}`,
        body: { name: "Hacked" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: foreign.id }) } as never,
    );

    expect(response.status).toBe(404);
    const after = await Alumnus.findById(foreign.id).lean();
    expect(after).toEqual(before);
  });

  it("returns 404 for an unknown id", async () => {
    await signInWithCookie("INS0001");

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${UNKNOWN_ID}`,
        body: { name: "Nope" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: UNKNOWN_ID }) } as never,
    );

    expect(response.status).toBe(404);
  });

  // `requireInstitution()` guards this route family too — pinned so far only
  // on POST /alumni. No session at all must 401 before the patch is parsed
  // or the record is touched.
  it("returns 401 without a session and leaves the record unchanged", async () => {
    const created = await makeAlumnus("INS0001");
    const before = await Alumnus.findById(created.id).lean();

    const response = await patchAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        body: { name: "Should not apply" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );

    expect(response.status).toBe(401);
    const after = await Alumnus.findById(created.id).lean();
    expect(after).toEqual(before);
  });
});

describe("DELETE /api/settings/alumni/[alumnusId]", () => {
  it("removes an alumnus over HTTP", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const response = await deleteAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.deleted).toBe(true);
    expect(await Alumnus.findById(created.id).lean()).toBeNull();
  });

  // The photo-removal path for alumni: there is no standalone "clear the
  // photo" method (an alumnus has exactly one photo, and `setPhoto` already
  // owns cleaning up whatever it replaces) — the only way a photo goes away
  // on its own is the whole record going away via `AlumniService.remove`.
  // Unlike the achievements sibling's `removeAsset`, which leaves `photos:
  // []` behind because `$pull` empties an array in place, here the entire
  // document is gone — so there is no field state to assert on the document
  // at all. What's left to prove is that the stored object itself was
  // actually deleted from disk, not merely unreferenced.
  it("deletes the stored photo object when the alumnus that owned it is removed", async () => {
    const created = await makeAlumnus("INS0001");
    const withPhoto = await AlumniService.setPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const key = withPhoto.photo!;
    expect(existsSync(storedPath(key))).toBe(true);
    await signInWithCookie("INS0001");

    const response = await deleteAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );

    expect(response.status).toBe(200);
    expect(await Alumnus.findById(created.id).lean()).toBeNull();
    expect(existsSync(storedPath(key))).toBe(false);
  });

  // `.toEqual(before)`, not `.not.toBeNull()`: the latter would also pass if
  // the record had been mutated rather than left alone, and a broken guard
  // that mutates instead of rejecting is exactly the kind of thing nobody
  // predicts. Matches PATCH's form on the same two guards.
  it("MUTATION-DISTINGUISHING: rejects a cross-origin DELETE and leaves the record intact", async () => {
    const created = await makeAlumnus("INS0001");
    const before = await Alumnus.findById(created.id).lean();
    await signInWithCookie("INS0001");

    const response = await deleteAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        origin: "https://not-the-app.test",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);
    const after = await Alumnus.findById(created.id).lean();
    expect(after).toEqual(before);
  });

  it("returns 404 for another institution's alumnus and leaves it intact", async () => {
    const foreign = await makeAlumnus("INS0002");
    const before = await Alumnus.findById(foreign.id).lean();
    await signInWithCookie("INS0001");

    const response = await deleteAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${foreign.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: foreign.id }) } as never,
    );

    expect(response.status).toBe(404);
    const after = await Alumnus.findById(foreign.id).lean();
    expect(after).toEqual(before);
  });

  it("returns 404 for an unknown id", async () => {
    await signInWithCookie("INS0001");

    const response = await deleteAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${UNKNOWN_ID}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: UNKNOWN_ID }) } as never,
    );

    expect(response.status).toBe(404);
  });

  // `requireInstitution()` guards this route family too — the only mutating
  // handler in this file that didn't already have a 401 test of its own. No
  // session at all must 401 before the record is touched.
  it("returns 401 without a session and leaves the record unchanged", async () => {
    const created = await makeAlumnus("INS0001");
    const before = await Alumnus.findById(created.id).lean();

    const response = await deleteAlumnus(
      jsonRequest({
        url: `http://localhost/api/settings/alumni/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );

    expect(response.status).toBe(401);
    const after = await Alumnus.findById(created.id).lean();
    expect(after).toEqual(before);
  });
});

describe("POST /api/settings/alumni/[alumnusId]/photo", () => {
  it("uploads a photo and sets the key", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("file", new File([new Uint8Array(PNG)], "photo.png", { type: "image/png" }));

    const response = await uploadAlumnusPhoto(
      formRequest(
        `http://localhost/api/settings/alumni/${created.id}/photo`,
        form,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alumnus.photo).toContain("showcase/INS0001/alumni/");
    expect(existsSync(storedPath(payload.alumnus.photo))).toBe(true);
  });

  // `AlumniService.setPhoto` reads a `{ new: false }` pre-image specifically
  // so each write deletes the key its OWN write displaced, not a key read
  // earlier — the mechanism that makes concurrent uploads safe (Task 7).
  // That behaviour was pinned only at the service layer until now: if this
  // route ever stopped reaching `setPhoto` correctly, every other test in
  // this block would still pass while every replaced photo piled up in
  // storage forever. Both halves matter — asserting only that the record
  // changed would miss the leak entirely.
  it("replaces an existing photo: the old object is gone from storage and the record references the new one", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const firstForm = new FormData();
    firstForm.set("file", new File([new Uint8Array(PNG)], "first.png", { type: "image/png" }));
    const firstResponse = await uploadAlumnusPhoto(
      formRequest(
        `http://localhost/api/settings/alumni/${created.id}/photo`,
        firstForm,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const firstPayload = await firstResponse.json();
    const firstKey = firstPayload.alumnus.photo as string;
    expect(existsSync(storedPath(firstKey))).toBe(true);

    const secondForm = new FormData();
    secondForm.set("file", new File([new Uint8Array(PNG)], "second.png", { type: "image/png" }));
    const secondResponse = await uploadAlumnusPhoto(
      formRequest(
        `http://localhost/api/settings/alumni/${created.id}/photo`,
        secondForm,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const secondPayload = await secondResponse.json();
    const secondKey = secondPayload.alumnus.photo as string;

    expect(secondResponse.status).toBe(200);
    expect(secondKey).not.toBe(firstKey);
    expect(existsSync(storedPath(firstKey))).toBe(false);
    expect(existsSync(storedPath(secondKey))).toBe(true);

    // The raw stored document, not just the DTO.
    const raw = await Alumnus.findById(created.id).lean();
    expect(raw?.photo).toBe(secondKey);
  });

  it("rejects a request with no file", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const form = new FormData();

    const response = await uploadAlumnusPhoto(
      formRequest(
        `http://localhost/api/settings/alumni/${created.id}/photo`,
        form,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );

    expect(response.status).toBe(400);
    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("photo");
  });

  // Proves there is no route-level pre-check standing in front of
  // `validateImage`: a payload whose bytes are not a real image is still
  // refused, solely by `AlumniService.setPhoto`'s own magic-byte sniff.
  it("rejects a file whose bytes are not a real image", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(Buffer.from("#!/bin/sh\necho not-an-image"))], "photo.png", {
        type: "image/png",
      }),
    );

    const response = await uploadAlumnusPhoto(
      formRequest(
        `http://localhost/api/settings/alumni/${created.id}/photo`,
        form,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );

    expect(response.status).toBe(400);
    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("photo");
  });

  // Proves the ruling behind this route carrying no size/empty pre-check of
  // its own: an empty file is still refused, solely by
  // `AlumniService.setPhoto`'s own `validateImage` call.
  it("rejects an empty file, and stores nothing", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("file", new File([], "empty.png", { type: "image/png" }));

    const response = await uploadAlumnusPhoto(
      formRequest(
        `http://localhost/api/settings/alumni/${created.id}/photo`,
        form,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toMatch(/empty/i);
    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("photo");
  });

  // The route-level size check is not about the status code — `validateImage`
  // 400s an oversized image on its own, so a test that asserted only the
  // status would pass with the check deleted. What the check buys is WHERE
  // the refusal happens: `formData()` has already materialised the body,
  // `arrayBuffer()` copies it a second time, and `validateImage` only runs
  // once that second copy exists. Spying on the file's own `arrayBuffer` is
  // therefore the assertion that distinguishes the two — it is the exact
  // allocation the check exists to prevent.
  it("MUTATION-DISTINGUISHING: refuses an oversized photo before `arrayBuffer()` copies the body", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const oversized = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    const file = new File([new Uint8Array(oversized)], "big.png", { type: "image/png" });
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    const putPublic = vi.spyOn(storage, "putPublic");
    const form = new FormData();
    form.set("file", file);

    try {
      const response = await uploadAlumnusPhoto(
        formRequest(
          `http://localhost/api/settings/alumni/${created.id}/photo`,
          form,
          { origin: "http://localhost" },
        ),
        { params: Promise.resolve({ alumnusId: created.id }) } as never,
      );
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe("VALIDATION_ERROR");
      expect(payload.error.message).toMatch(/5 MB or smaller/);
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(putPublic).not.toHaveBeenCalled();
    } finally {
      arrayBuffer.mockRestore();
      putPublic.mockRestore();
    }

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("photo");
  });

  it("MUTATION-DISTINGUISHING: rejects a cross-origin upload and stores nothing", async () => {
    const created = await makeAlumnus("INS0001");
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("file", new File([new Uint8Array(PNG)], "photo.png", { type: "image/png" }));

    const response = await uploadAlumnusPhoto(
      formRequest(
        `http://localhost/api/settings/alumni/${created.id}/photo`,
        form,
        { origin: "https://not-the-app.test" },
      ),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("photo");
  });

  it("returns 404 for another institution's alumnus without storing anything", async () => {
    const foreign = await makeAlumnus("INS0002");
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("file", new File([new Uint8Array(PNG)], "photo.png", { type: "image/png" }));

    const response = await uploadAlumnusPhoto(
      formRequest(
        `http://localhost/api/settings/alumni/${foreign.id}/photo`,
        form,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ alumnusId: foreign.id }) } as never,
    );

    expect(response.status).toBe(404);
    const raw = await Alumnus.findById(foreign.id).lean();
    expect(raw).not.toHaveProperty("photo");
  });

  it("returns 404 for an unknown alumnus id", async () => {
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("file", new File([new Uint8Array(PNG)], "photo.png", { type: "image/png" }));

    const response = await uploadAlumnusPhoto(
      formRequest(
        `http://localhost/api/settings/alumni/${UNKNOWN_ID}/photo`,
        form,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ alumnusId: UNKNOWN_ID }) } as never,
    );

    expect(response.status).toBe(404);
  });

  // `requireInstitution()` guards the photo route family too — the third and
  // last of the three surfaces (create, item, photo). No session at all must
  // 401 before the file is even read, let alone stored.
  it("returns 401 without a session and stores nothing", async () => {
    const created = await makeAlumnus("INS0001");

    const form = new FormData();
    form.set("file", new File([new Uint8Array(PNG)], "photo.png", { type: "image/png" }));

    const response = await uploadAlumnusPhoto(
      formRequest(
        `http://localhost/api/settings/alumni/${created.id}/photo`,
        form,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ alumnusId: created.id }) } as never,
    );

    expect(response.status).toBe(401);
    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("photo");
  });
});
