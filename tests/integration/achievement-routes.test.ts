import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { GET as listAchievements, POST as createAchievement } from "@/app/api/settings/achievements/route";
import {
  PATCH as patchAchievement,
  DELETE as deleteAchievement,
} from "@/app/api/settings/achievements/[achievementId]/route";
import {
  POST as addAsset,
  DELETE as removeAsset,
} from "@/app/api/settings/achievements/[achievementId]/assets/route";
import { AchievementService } from "@/services/achievement.service";
import { Achievement } from "@/models";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

/** An id shaped like an achievement's but belonging to no record. */
const UNKNOWN_ID = "6a8bf44bf4e473b526efc999";

/** Smallest valid PNG — the upload guard sniffs magic numbers, so this must be real. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A minimal but real PDF header — passes the `%PDF-` magic-byte sniff. */
const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< >>\nendobj\n%%EOF", "binary");

// `eventDate: undefined` is explicit because `optionalDateSchema` infers the
// key as required-but-possibly-undefined rather than `?:` — the same quirk
// tests/integration/achievement-service.test.ts and showcase-assets.test.ts
// work around.
const achievementInput = {
  category: "ACADEMIC" as const,
  title: "Science Olympiad Gold",
  description: "Won gold at the state science olympiad",
  eventDate: undefined,
  level: "STATE" as const,
};

async function makeAchievement(institutionId: string, overrides: Record<string, unknown> = {}) {
  return AchievementService.create(institutionId, { ...achievementInput, ...overrides }, actor);
}

/** A request carrying only a session cookie, for JSON body routes. */
function jsonRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/achievements");
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

async function signInWithCookie(institutionId: string, email = "achievements-admin@example.test") {
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

beforeAll(async () => {
  await startTestDatabase("achievement-routes");
  await Achievement.syncIndexes();
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

describe("GET /api/settings/achievements", () => {
  it("lists only the caller's achievements", async () => {
    await makeAchievement("INS0001");
    await makeAchievement("INS0002");
    await signInWithCookie("INS0001");

    const response = await listAchievements();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.achievements).toHaveLength(1);
  });
});

describe("POST /api/settings/achievements", () => {
  it("creates an achievement over HTTP", async () => {
    await signInWithCookie("INS0001");

    const response = await createAchievement(
      jsonRequest({ body: achievementInput, origin: "http://localhost" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.achievement.title).toBe("Science Olympiad Gold");
    expect(payload.achievement.status).toBe("ACTIVE");
  });

  it("rejects a body missing a required field", async () => {
    await signInWithCookie("INS0001");

    const response = await createAchievement(
      jsonRequest({ body: { category: "ACADEMIC" }, origin: "http://localhost" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  // Requirement: institutionId comes from requireInstitution() and nowhere
  // else. A body carrying a foreign institutionId must not move the record
  // there, and must not touch that institution's existing data.
  it("MUTATION-DISTINGUISHING: creates the record under the caller's institution even when the body names another institution, and leaves that institution's own record untouched", async () => {
    const foreign = await makeAchievement("INS0002", { title: "INS0002 original" });
    const before = await Achievement.findById(foreign.id).lean();
    await signInWithCookie("INS0001");

    const response = await createAchievement(
      jsonRequest({
        body: { ...achievementInput, institutionId: "INS0002" },
        origin: "http://localhost",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);

    const raw = await Achievement.findById(payload.achievement.id).lean();
    expect(raw?.institutionId).toBe("INS0001");

    const after = await Achievement.findById(foreign.id).lean();
    expect(after).toEqual(before);
  });

  it("MUTATION-DISTINGUISHING: rejects a cross-origin create and creates nothing", async () => {
    await signInWithCookie("INS0001");

    const response = await createAchievement(
      jsonRequest({ body: achievementInput, origin: "https://not-the-app.test" }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);
    expect(await Achievement.countDocuments({})).toBe(0);
  });
});

describe("PATCH /api/settings/achievements/[achievementId]", () => {
  it("updates an achievement over HTTP", async () => {
    const created = await makeAchievement("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchAchievement(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${created.id}`,
        body: { title: "Science Olympiad Gold Medal" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ achievementId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.achievement.title).toBe("Science Olympiad Gold Medal");
  });

  it("leaves the stored description untouched when the patch omits it", async () => {
    const created = await makeAchievement("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchAchievement(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${created.id}`,
        body: { title: "Renamed only" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ achievementId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.achievement.description).toBe("Won gold at the state science olympiad");

    const raw = await Achievement.findById(created.id).lean();
    expect(raw?.description).toBe("Won gold at the state science olympiad");
  });

  // The three-state patch contract's load-bearing assertion, exercised
  // end-to-end through the route rather than the service: a route that
  // normalises the body or drops `null` on the way through would silently
  // turn "clear this field" into "leave it alone."
  it("MUTATION-DISTINGUISHING: clears the stored description when the patch sends an explicit null, not merely omitting the key", async () => {
    const created = await makeAchievement("INS0001");
    await signInWithCookie("INS0001");

    const response = await patchAchievement(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${created.id}`,
        body: { description: null },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ achievementId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.achievement.description).toBeUndefined();

    const raw = await Achievement.findById(created.id).lean();
    expect(raw).not.toHaveProperty("description");
  });

  it("MUTATION-DISTINGUISHING: rejects a cross-origin PATCH and leaves the record unchanged", async () => {
    const created = await makeAchievement("INS0001");
    const before = await Achievement.findById(created.id).lean();
    await signInWithCookie("INS0001");

    const response = await patchAchievement(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${created.id}`,
        body: { title: "Should not apply", description: null },
        origin: "https://not-the-app.test",
      }),
      { params: Promise.resolve({ achievementId: created.id }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);

    const after = await Achievement.findById(created.id).lean();
    expect(after).toEqual(before);
  });

  it("returns 404 for another institution's achievement and leaves it untouched", async () => {
    const foreign = await makeAchievement("INS0002");
    const before = await Achievement.findById(foreign.id).lean();
    await signInWithCookie("INS0001");

    const response = await patchAchievement(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${foreign.id}`,
        body: { title: "Hacked" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ achievementId: foreign.id }) } as never,
    );

    expect(response.status).toBe(404);
    const after = await Achievement.findById(foreign.id).lean();
    expect(after).toEqual(before);
  });

  it("returns 404 for an unknown id", async () => {
    await signInWithCookie("INS0001");

    const response = await patchAchievement(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${UNKNOWN_ID}`,
        body: { title: "Nope" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ achievementId: UNKNOWN_ID }) } as never,
    );

    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/settings/achievements/[achievementId]", () => {
  it("removes an achievement over HTTP", async () => {
    const created = await makeAchievement("INS0001");
    await signInWithCookie("INS0001");

    const response = await deleteAchievement(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ achievementId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.deleted).toBe(true);
    expect(await Achievement.findById(created.id).lean()).toBeNull();
  });

  it("MUTATION-DISTINGUISHING: rejects a cross-origin DELETE and leaves the record intact", async () => {
    const created = await makeAchievement("INS0001");
    await signInWithCookie("INS0001");

    const response = await deleteAchievement(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${created.id}`,
        origin: "https://not-the-app.test",
      }),
      { params: Promise.resolve({ achievementId: created.id }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);
    expect(await Achievement.findById(created.id).lean()).not.toBeNull();
  });

  it("returns 404 for another institution's achievement and leaves it intact", async () => {
    const foreign = await makeAchievement("INS0002");
    await signInWithCookie("INS0001");

    const response = await deleteAchievement(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${foreign.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ achievementId: foreign.id }) } as never,
    );

    expect(response.status).toBe(404);
    expect(await Achievement.findById(foreign.id).lean()).not.toBeNull();
  });

  it("returns 404 for an unknown id", async () => {
    await signInWithCookie("INS0001");

    const response = await deleteAchievement(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${UNKNOWN_ID}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ achievementId: UNKNOWN_ID }) } as never,
    );

    expect(response.status).toBe(404);
  });
});

describe("POST /api/settings/achievements/[achievementId]/assets", () => {
  it("uploads a photo and appends its key", async () => {
    const created = await makeAchievement("INS0001");
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("kind", "PHOTO");
    form.set("file", new File([new Uint8Array(PNG)], "photo.png", { type: "image/png" }));

    const response = await addAsset(
      formRequest(
        `http://localhost/api/settings/achievements/${created.id}/assets`,
        form,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ achievementId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.achievement.photos).toHaveLength(1);
    expect(payload.achievement.photos[0]).toContain("showcase/INS0001/achievements/");
  });

  it("uploads a certificate and appends its key", async () => {
    const created = await makeAchievement("INS0001");
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("kind", "CERTIFICATE");
    form.set("file", new File([new Uint8Array(PDF)], "cert.pdf", { type: "application/pdf" }));

    const response = await addAsset(
      formRequest(
        `http://localhost/api/settings/achievements/${created.id}/assets`,
        form,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ achievementId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.achievement.certificates).toHaveLength(1);
    expect(payload.achievement.certificates[0].endsWith(".pdf")).toBe(true);
  });

  it("rejects a request with no file", async () => {
    const created = await makeAchievement("INS0001");
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("kind", "PHOTO");

    const response = await addAsset(
      formRequest(
        `http://localhost/api/settings/achievements/${created.id}/assets`,
        form,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ achievementId: created.id }) } as never,
    );

    expect(response.status).toBe(400);
  });

  it("MUTATION-DISTINGUISHING: rejects a cross-origin upload and stores nothing", async () => {
    const created = await makeAchievement("INS0001");
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("kind", "PHOTO");
    form.set("file", new File([new Uint8Array(PNG)], "photo.png", { type: "image/png" }));

    const response = await addAsset(
      formRequest(
        `http://localhost/api/settings/achievements/${created.id}/assets`,
        form,
        { origin: "https://not-the-app.test" },
      ),
      { params: Promise.resolve({ achievementId: created.id }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);

    const raw = await Achievement.findById(created.id).lean();
    expect(raw?.photos ?? []).toHaveLength(0);
  });

  it("returns 404 for another institution's achievement without storing anything", async () => {
    const foreign = await makeAchievement("INS0002");
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("kind", "PHOTO");
    form.set("file", new File([new Uint8Array(PNG)], "photo.png", { type: "image/png" }));

    const response = await addAsset(
      formRequest(
        `http://localhost/api/settings/achievements/${foreign.id}/assets`,
        form,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ achievementId: foreign.id }) } as never,
    );

    expect(response.status).toBe(404);
    const raw = await Achievement.findById(foreign.id).lean();
    expect(raw?.photos ?? []).toHaveLength(0);
  });

  it("returns 404 for an unknown achievement id", async () => {
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.set("kind", "PHOTO");
    form.set("file", new File([new Uint8Array(PNG)], "photo.png", { type: "image/png" }));

    const response = await addAsset(
      formRequest(
        `http://localhost/api/settings/achievements/${UNKNOWN_ID}/assets`,
        form,
        { origin: "http://localhost" },
      ),
      { params: Promise.resolve({ achievementId: UNKNOWN_ID }) } as never,
    );

    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/settings/achievements/[achievementId]/assets", () => {
  it("removes a photo asset and clears the field", async () => {
    const created = await makeAchievement("INS0001");
    const withPhoto = await AchievementService.addPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const key = withPhoto.photos![0]!;
    await signInWithCookie("INS0001");

    const response = await removeAsset(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${created.id}/assets`,
        body: { kind: "PHOTO", key },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ achievementId: created.id }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.achievement.photos).toBeUndefined();
  });

  it("MUTATION-DISTINGUISHING: rejects a cross-origin removal and leaves the asset in place", async () => {
    const created = await makeAchievement("INS0001");
    const withPhoto = await AchievementService.addPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const key = withPhoto.photos![0]!;
    await signInWithCookie("INS0001");

    const response = await removeAsset(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${created.id}/assets`,
        body: { kind: "PHOTO", key },
        origin: "https://not-the-app.test",
      }),
      { params: Promise.resolve({ achievementId: created.id }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/cross-origin/i);

    const raw = await Achievement.findById(created.id).lean();
    expect(raw?.photos).toEqual([key]);
  });

  it("returns 404 for another institution's achievement and leaves the asset untouched", async () => {
    const foreign = await makeAchievement("INS0002");
    const withPhoto = await AchievementService.addPhoto(
      "INS0002",
      foreign.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const key = withPhoto.photos![0]!;
    await signInWithCookie("INS0001");

    const response = await removeAsset(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${foreign.id}/assets`,
        body: { kind: "PHOTO", key },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ achievementId: foreign.id }) } as never,
    );

    expect(response.status).toBe(404);
    const raw = await Achievement.findById(foreign.id).lean();
    expect(raw?.photos).toEqual([key]);
  });

  it("returns 404 for an unknown achievement id", async () => {
    await signInWithCookie("INS0001");

    const response = await removeAsset(
      jsonRequest({
        url: `http://localhost/api/settings/achievements/${UNKNOWN_ID}/assets`,
        body: { kind: "PHOTO", key: "showcase/INS0001/achievements/deadbeef.png" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ achievementId: UNKNOWN_ID }) } as never,
    );

    expect(response.status).toBe(404);
  });
});
