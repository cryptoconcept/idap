import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
// Aliased to tests/helpers/next-headers-stub.ts, whose cookie store is a plain
// module-level Map — so a test can put a real signed session cookie in front of
// the cookie branch of requireInstitution / getCurrentUser.
import { cookies } from "next/headers";
import { GET as getProfile, PATCH as patchProfile } from "@/app/api/settings/institution/route";
import { POST as publishProfile } from "@/app/api/settings/institution/publish/route";
import { POST as uploadMedia } from "@/app/api/settings/institution/media/route";
import { DELETE as deleteMedia } from "@/app/api/settings/institution/media/[mediaId]/route";
import { InstitutionService } from "@/services/institution.service";
import type { NextRequest } from "next/server";

/** Seeds a gallery item directly through the service, bypassing the route
 * under test, so DELETE tests exercise only the route's own guards. */
async function seedGalleryItem(institutionId: string): Promise<string> {
  const profile = await InstitutionService.addMedia(
    institutionId,
    { kind: "GALLERY", fileName: "seed.png", contentType: "image/png", bytes: PNG, title: "Seed" },
    { id: "6a8880f3446c577c470cd06c", name: "Seed Actor" },
  );
  return profile.gallery![0]!.id;
}

/** A request carrying only a session cookie, shaped for a dynamic-route handler
 * (formData routes and DELETE both need this instead of cookieRequest's json()). */
function mediaFormRequest(form: FormData, init: { origin?: string; host?: string } = {}) {
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  headers.set("host", init.host ?? "localhost");
  return {
    headers,
    nextUrl: new URL("http://localhost/api/settings/institution/media"),
    url: "http://localhost/api/settings/institution/media",
    formData: async () => form,
  } as unknown as NextRequest;
}

// A real PNG header followed by padding — passes the magic-byte sniff. Same
// bytes as tests/integration/institution-profile.test.ts.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

/** A request carrying only a session cookie, like the web dashboard. */
function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/institution");
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

/** Platform-admin session: no institutionId, role SUPER_ADMIN — the 403 case. */
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

describe("institution profile self-service routes", () => {
  beforeAll(async () => {
    await startTestDatabase("profileroutes");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001");
  });

  // The cookie store is module-level, so a session left behind would silently
  // authenticate the tests that expect no credentials at all.
  afterEach(async () => {
    (await cookies()).delete(SESSION_COOKIE);
  });

  it("returns the profile and completion for the signed-in institution admin", async () => {
    await signInWithCookie("INS0001");

    const response = await getProfile();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.profile.institutionId).toBe("INS0001");
    expect(payload.completion.percent).toBeGreaterThanOrEqual(0);
  });

  it("updates a profile section and returns the recomputed completion", async () => {
    await signInWithCookie("INS0001");

    const response = await patchProfile(
      cookieRequest({ body: { academic: { board: "CBSE" } }, origin: "http://localhost" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.profile.academic.board).toBe("CBSE");
    expect(payload.completion).toBeDefined();
  });

  it("refuses a platform admin session at the route level", async () => {
    await signInPlatformAdmin();

    const response = await patchProfile(
      cookieRequest({ body: { academic: { board: "CBSE" } }, origin: "http://localhost" }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cannot access institution data/i);
  });

  it("rejects a PATCH with no session at all", async () => {
    const response = await patchProfile(
      cookieRequest({ body: { academic: { board: "CBSE" } }, origin: "http://localhost" }),
    );

    expect(response.status).toBe(401);
  });

  it("publishes the profile and reports the new status", async () => {
    await signInWithCookie("INS0001");

    const response = await publishProfile(
      cookieRequest({
        url: "http://localhost/api/settings/institution/publish",
        body: { action: "publish" },
        origin: "http://localhost",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.profile.profileStatus).toBe("PUBLISHED");
  });

  it("uploads a gallery image through a multipart form", async () => {
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("file", new File([PNG], "photo.png", { type: "image/png" }));
    form.set("kind", "GALLERY");
    form.set("title", "Campus");

    const request = {
      headers: new Headers({ origin: "http://localhost", host: "localhost" }),
      nextUrl: new URL("http://localhost/api/settings/institution/media"),
      url: "http://localhost/api/settings/institution/media",
      formData: async () => form,
    } as unknown as NextRequest;

    const response = await uploadMedia(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.profile.gallery).toHaveLength(1);
    expect(payload.profile.gallery[0].title).toBe("Campus");
  });

  it("rejects a cross-origin PATCH even with a valid session — CSRF still enforced", async () => {
    await signInWithCookie("INS0001");

    const response = await patchProfile(
      cookieRequest({
        body: { academic: { board: "CBSE" } },
        origin: "https://not-the-app.test",
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);
  });

  it("refuses a platform admin session on publish", async () => {
    await signInPlatformAdmin();

    const response = await publishProfile(
      cookieRequest({
        url: "http://localhost/api/settings/institution/publish",
        body: { action: "publish" },
        origin: "http://localhost",
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cannot access institution data/i);
  });

  it("rejects a cross-origin publish even with a valid session — CSRF still enforced", async () => {
    await signInWithCookie("INS0001");

    const response = await publishProfile(
      cookieRequest({
        url: "http://localhost/api/settings/institution/publish",
        body: { action: "publish" },
        origin: "https://not-the-app.test",
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);
  });

  it("refuses a platform admin session on media upload", async () => {
    await signInPlatformAdmin();

    const form = new FormData();
    form.set("file", new File([PNG], "photo.png", { type: "image/png" }));
    form.set("kind", "GALLERY");

    const response = await uploadMedia(mediaFormRequest(form, { origin: "http://localhost" }));

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cannot access institution data/i);
  });

  it("rejects a cross-origin media upload even with a valid session — CSRF still enforced", async () => {
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("file", new File([PNG], "photo.png", { type: "image/png" }));
    form.set("kind", "GALLERY");

    const response = await uploadMedia(
      mediaFormRequest(form, { origin: "https://not-the-app.test" }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);
  });

  it("deletes a gallery item the institution admin owns", async () => {
    const mediaId = await seedGalleryItem("INS0001");
    await signInWithCookie("INS0001");

    const response = await deleteMedia(
      cookieRequest({ origin: "http://localhost" }),
      { params: Promise.resolve({ mediaId }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.profile.gallery ?? []).toHaveLength(0);
  });

  it("refuses a platform admin session on media delete", async () => {
    const mediaId = await seedGalleryItem("INS0001");
    await signInPlatformAdmin();

    const response = await deleteMedia(
      cookieRequest({ origin: "http://localhost" }),
      { params: Promise.resolve({ mediaId }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cannot access institution data/i);
  });

  it("rejects a cross-origin media delete even with a valid session — CSRF still enforced", async () => {
    // Same rule as every other mutating route here: a browser attaches the
    // session cookie to a DELETE fetch() automatically too, so the CSRF check
    // has to apply to it exactly like PATCH and the two POSTs.
    const mediaId = await seedGalleryItem("INS0001");
    await signInWithCookie("INS0001");

    const response = await deleteMedia(
      cookieRequest({ origin: "https://not-the-app.test" }),
      { params: Promise.resolve({ mediaId }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);
  });
});
