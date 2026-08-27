import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
// Aliased to tests/helpers/next-headers-stub.ts (a plain module-level Map), so
// a real signed session cookie can sit in front of requireInstitution's cookie
// branch exactly as it does for a browser request.
import { cookies } from "next/headers";
import { POST as uploadMedia } from "@/app/api/settings/institution/media/route";
import { POST as addVideo } from "@/app/api/settings/institution/media/video/route";
import { PATCH as patchMedia, DELETE as deleteMedia } from "@/app/api/settings/institution/media/[mediaId]/route";
import { InstitutionService } from "@/services/institution.service";
import { Institution } from "@/models";
import type { NextRequest } from "next/server";

// A real PNG header followed by padding — passes the magic-byte sniff. Same
// bytes as tests/integration/institution-profile.test.ts.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

/** A minimal but real PDF header — passes the `%PDF-` magic-byte sniff. Same
 *  bytes as tests/integration/institution-media.test.ts. */
const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< >>\nendobj\n%%EOF", "binary");

/** A YouTube URL `normalizeVideoUrl` recognizes. */
const YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

/** A request carrying only a session cookie, shaped for a multipart route. */
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

/** A request carrying only a session cookie, for JSON body routes (video POST, PATCH). */
function jsonRequest(init: { url: string; body?: unknown; origin?: string } = { url: "" }) {
  const url = new URL(init.url);
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

/** A request carrying only a session cookie and no body, for DELETE. */
function bareRequest(init: { url: string; origin?: string }) {
  const url = new URL(init.url);
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  headers.set("host", "localhost");
  return {
    headers,
    nextUrl: url,
    url: url.toString(),
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

/** Seeds one media item directly through the service, bypassing every route
 * under test, so PATCH/DELETE tests exercise only the route's own guards. */
async function seedImage(institutionId: string, overrides: { caption?: string } = {}): Promise<string> {
  const profile = await InstitutionService.addMediaImage(
    institutionId,
    {
      target: "MEDIA",
      fileName: "seed.png",
      contentType: "image/png",
      bytes: PNG,
      title: "Seed",
      caption: overrides.caption,
    },
    { id: "6a8880f3446c577c470cd06c", name: "Seed Actor" },
  );
  return profile.media![0]!.id;
}

async function mediaCount(institutionId: string): Promise<number> {
  const row = await Institution.findOne({ institutionId }).select("media").lean();
  return row?.media?.length ?? 0;
}

describe("media routes", () => {
  beforeAll(async () => {
    await startTestDatabase("mediaroutes");
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

  describe("POST /media (image path)", () => {
    it("uploads a MEDIA image with an explicit kind=IMAGE", async () => {
      await signInWithCookie("INS0001");

      const form = new FormData();
      form.set("file", new File([PNG], "photo.png", { type: "image/png" }));
      form.set("target", "MEDIA");
      form.set("kind", "IMAGE");
      form.set("title", "Campus");

      const response = await uploadMedia(mediaFormRequest(form, { origin: "http://localhost" }));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.profile.media).toHaveLength(1);
      expect(payload.profile.media[0].kind).toBe("IMAGE");
    });

    it("rejects a cross-origin image upload and creates no media item — CSRF still enforced", async () => {
      await signInWithCookie("INS0001");

      const form = new FormData();
      form.set("file", new File([PNG], "photo.png", { type: "image/png" }));
      form.set("target", "MEDIA");

      const response = await uploadMedia(
        mediaFormRequest(form, { origin: "https://not-the-app.test" }),
      );

      expect(response.status).toBe(403);
      expect((await response.json()).error.message).toMatch(/cross-origin/i);
      expect(await mediaCount("INS0001")).toBe(0);
    });
  });

  describe("POST /media (document path)", () => {
    it("routes target=MEDIA with kind=BROCHURE to addMediaDocument", async () => {
      await signInWithCookie("INS0001");

      const form = new FormData();
      form.set("file", new File([PDF], "brochure.pdf", { type: "application/pdf" }));
      form.set("target", "MEDIA");
      form.set("kind", "BROCHURE");
      form.set("title", "2026 Brochure");

      const response = await uploadMedia(mediaFormRequest(form, { origin: "http://localhost" }));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.profile.media).toHaveLength(1);
      expect(payload.profile.media[0].kind).toBe("BROCHURE");
      expect(payload.profile.media[0].title).toBe("2026 Brochure");
    });

    it("routes target=MEDIA with kind=PROSPECTUS to addMediaDocument", async () => {
      await signInWithCookie("INS0001");

      const form = new FormData();
      form.set("file", new File([PDF], "prospectus.pdf", { type: "application/pdf" }));
      form.set("target", "MEDIA");
      form.set("kind", "PROSPECTUS");

      const response = await uploadMedia(mediaFormRequest(form, { origin: "http://localhost" }));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.profile.media[0].kind).toBe("PROSPECTUS");
    });

    it("refuses a kind outside the upload enum rather than misfiling it, and creates no media item", async () => {
      // "VIDEO" is a real MediaKind elsewhere in the domain, but never a legal
      // `kind` for this multipart route — the Task 5 review finding this
      // guards against is exactly a kind reaching addMediaDocument's
      // "BROCHURE" ? ... : "prospectuses" ternary without belonging to its
      // narrower BROCHURE|PROSPECTUS contract. A value the wider upload enum
      // itself rejects is the sharpest version of that: it must 400, not land
      // in either bucket.
      await signInWithCookie("INS0001");

      const form = new FormData();
      form.set("file", new File([PDF], "brochure.pdf", { type: "application/pdf" }));
      form.set("target", "MEDIA");
      form.set("kind", "VIDEO");

      const response = await uploadMedia(mediaFormRequest(form, { origin: "http://localhost" }));

      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toMatch(/kind/i);
      expect(await mediaCount("INS0001")).toBe(0);
    });

    it("rejects a cross-origin document upload and creates no media item — CSRF still enforced", async () => {
      await signInWithCookie("INS0001");

      const form = new FormData();
      form.set("file", new File([PDF], "brochure.pdf", { type: "application/pdf" }));
      form.set("target", "MEDIA");
      form.set("kind", "BROCHURE");

      const response = await uploadMedia(
        mediaFormRequest(form, { origin: "https://not-the-app.test" }),
      );

      expect(response.status).toBe(403);
      expect((await response.json()).error.message).toMatch(/cross-origin/i);
      expect(await mediaCount("INS0001")).toBe(0);
    });
  });

  describe("POST /media/video", () => {
    it("adds a YouTube link as a VIDEO item", async () => {
      await signInWithCookie("INS0001");

      const response = await addVideo(
        jsonRequest({
          url: "http://localhost/api/settings/institution/media/video",
          body: { url: YOUTUBE_URL, title: "Campus Tour" },
          origin: "http://localhost",
        }),
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.profile.media).toHaveLength(1);
      expect(payload.profile.media[0].kind).toBe("VIDEO");
      expect(payload.profile.media[0].provider).toBe("YOUTUBE");
      expect(payload.profile.media[0].title).toBe("Campus Tour");
    });

    it("rejects an unsupported video host without storing bytes or creating a media item", async () => {
      await signInWithCookie("INS0001");

      const response = await addVideo(
        jsonRequest({
          url: "http://localhost/api/settings/institution/media/video",
          body: { url: "https://vimeo.example/not-real" },
          origin: "http://localhost",
        }),
      );

      expect(response.status).toBe(400);
      expect(await mediaCount("INS0001")).toBe(0);
    });

    it("rejects a cross-origin video POST and creates no media item — CSRF still enforced", async () => {
      await signInWithCookie("INS0001");

      const response = await addVideo(
        jsonRequest({
          url: "http://localhost/api/settings/institution/media/video",
          body: { url: YOUTUBE_URL },
          origin: "https://not-the-app.test",
        }),
      );

      expect(response.status).toBe(403);
      expect((await response.json()).error.message).toMatch(/cross-origin/i);
      expect(await mediaCount("INS0001")).toBe(0);
    });
  });

  describe("PATCH /media/[mediaId]", () => {
    it("updates a media item's caption and status", async () => {
      const mediaId = await seedImage("INS0001", { caption: "Original" });
      await signInWithCookie("INS0001");

      const response = await patchMedia(
        jsonRequest({
          url: `http://localhost/api/settings/institution/media/${mediaId}`,
          body: { caption: "Updated caption", status: "HIDDEN" },
          origin: "http://localhost",
        }),
        { params: Promise.resolve({ mediaId }) } as never,
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      const item = payload.profile.media.find((entry: { id: string }) => entry.id === mediaId);
      expect(item.caption).toBe("Updated caption");
      expect(item.status).toBe("HIDDEN");
    });

    it("rejects a cross-origin PATCH and leaves the media item unchanged — CSRF still enforced", async () => {
      const mediaId = await seedImage("INS0001", { caption: "Original" });
      await signInWithCookie("INS0001");

      const response = await patchMedia(
        jsonRequest({
          url: `http://localhost/api/settings/institution/media/${mediaId}`,
          body: { caption: "Updated caption", status: "HIDDEN" },
          origin: "https://not-the-app.test",
        }),
        { params: Promise.resolve({ mediaId }) } as never,
      );

      expect(response.status).toBe(403);
      expect((await response.json()).error.message).toMatch(/cross-origin/i);

      const row = await Institution.findOne({ institutionId: "INS0001" }).select("media").lean();
      const item = row!.media!.find((entry) => String(entry._id) === mediaId)!;
      expect(item.caption).toBe("Original");
      expect(item.status).toBe("ACTIVE");
    });
  });

  describe("DELETE /media/[mediaId]", () => {
    it("removes a media item", async () => {
      const mediaId = await seedImage("INS0001");
      await signInWithCookie("INS0001");

      const response = await deleteMedia(bareRequest({ url: `http://localhost/api/settings/institution/media/${mediaId}`, origin: "http://localhost" }), {
        params: Promise.resolve({ mediaId }),
      } as never);
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.profile.media ?? []).toHaveLength(0);
    });

    it("rejects a cross-origin DELETE and creates no change to the media count — CSRF still enforced", async () => {
      const mediaId = await seedImage("INS0001");
      await signInWithCookie("INS0001");

      const response = await deleteMedia(
        bareRequest({
          url: `http://localhost/api/settings/institution/media/${mediaId}`,
          origin: "https://not-the-app.test",
        }),
        { params: Promise.resolve({ mediaId }) } as never,
      );

      expect(response.status).toBe(403);
      expect((await response.json()).error.message).toMatch(/cross-origin/i);
      expect(await mediaCount("INS0001")).toBe(1);
    });
  });
});
