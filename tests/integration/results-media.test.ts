import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { ResultService } from "@/services/result.service";
import { Result } from "@/models";
import { storage } from "@/lib/storage";

// `storage.get()` reads the adapter's PRIVATE store, which is never where
// `putPublic` writes (see src/lib/storage/local.ts and blob.ts — two stores,
// two roots/tokens, by design). Existence of a public object is therefore
// checked on disk directly, mirroring the pattern already established in
// tests/integration/institution-profile.test.ts.
const PUBLIC_ROOT = resolve(process.env.PUBLIC_UPLOAD_DIR ?? join(process.cwd(), ".uploads-public"));
const storedPath = (url: string) => resolve(PUBLIC_ROOT, url.replace(/^\/api\/media\//, ""));

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };
const cycle = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  stream: null,
  academicYear: "2025-26",
  appeared: 10,
  passed: 10,
  toppers: [{ name: "Priya S", percentage: 98.6, consentAcknowledged: true }],
};

/** Smallest valid PNG — the upload guard sniffs magic numbers, so this must be real. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(() => startTestDatabase("results-media"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("topper photos", () => {
  it("stores a photo under the calling institution's owned media prefix", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    const updated = await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );

    const photoUrl = updated.toppers?.[0]?.photoUrl as string;
    expect(photoUrl).toBeDefined();
    expect(photoUrl).toContain("/media/INS0001/");
  });

  it("rejects a file whose bytes do not match its declared type", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    await expect(
      ResultService.setTopperPhoto(
        "INS0001",
        created.id,
        topperId,
        { contentType: "image/png", bytes: Buffer.from("not a png at all") },
        actor,
      ),
    ).rejects.toThrow(/do not match the declared file type/i);
  });

  it("rejects a content type that is not an allowed image", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    await expect(
      ResultService.setTopperPhoto(
        "INS0001",
        created.id,
        topperId,
        { contentType: "application/pdf", bytes: PNG },
        actor,
      ),
    ).rejects.toThrow(/JPG, PNG and WEBP/i);
  });

  it("replaces a photo and deletes the one it replaced", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    const first = await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const firstUrl = first.toppers?.[0]?.photoUrl as string;

    const second = await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const secondUrl = second.toppers?.[0]?.photoUrl as string;

    expect(secondUrl).not.toBe(firstUrl);
    // The replaced object is gone from the public store.
    expect(existsSync(storedPath(firstUrl))).toBe(false);
  });

  it("removes a photo and clears the field", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const cleared = await ResultService.removeTopperPhoto("INS0001", created.id, topperId, actor);

    expect(cleared.toppers?.[0]?.photoUrl).toBeUndefined();
  });

  it("never deletes a stored URL that this institution does not own", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    // Simulate a foreign URL reaching the stored field by any route.
    const foreign = "/api/media/media/INS0002/somebody-elses-photo.png";
    await Result.updateOne(
      { _id: created.id, "toppers._id": topperId },
      { $set: { "toppers.$.photoUrl": foreign } },
    );

    // Put a real object at the foreign key so its survival is observable.
    await storage.putPublic({
      key: "media/INS0002/somebody-elses-photo.png",
      body: PNG,
      contentType: "image/png",
    });

    await ResultService.removeTopperPhoto("INS0001", created.id, topperId, actor);

    // The foreign object must still exist — the guard refused to delete it.
    expect(existsSync(storedPath(foreign))).toBe(true);
  });

  it("deleting a result cleans up only the photos it owns", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    const withPhoto = await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const ownUrl = withPhoto.toppers?.[0]?.photoUrl as string;

    await ResultService.remove("INS0001", created.id, actor);

    expect(existsSync(storedPath(ownUrl))).toBe(false);
  });

  it("refuses to touch another institution's result", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;

    await expect(
      ResultService.setTopperPhoto(
        "INS0002",
        created.id,
        topperId,
        { contentType: "image/png", bytes: PNG },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns NOT_FOUND for a topper id that is not on this result", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);

    await expect(
      ResultService.setTopperPhoto(
        "INS0001",
        created.id,
        "6a887abd755db527bea51204",
        { contentType: "image/png", bytes: PNG },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

async function signInWithCookie(institutionId: string, email = "results-media-admin@example.test") {
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

/** A request carrying only a session cookie and a multipart body. */
function photoFormRequest(form: FormData, init: { origin?: string } = {}) {
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  headers.set("host", "localhost");
  return {
    headers,
    nextUrl: new URL("http://localhost/photo"),
    url: "http://localhost/photo",
    formData: async () => form,
  } as unknown as NextRequest;
}

describe("topper photo routes", () => {
  // The cookie store is module-level, so a session left behind would silently
  // authenticate a later test that expects no credentials at all.
  afterEach(async () => {
    (await cookies()).delete(SESSION_COOKIE);
  });

  it("accepts a multipart upload and returns the updated result", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;
    await signInWithCookie("INS0001");

    const form = new FormData();
    form.append("file", new File([new Uint8Array(PNG)], "priya.png", { type: "image/png" }));

    const { POST } = await import(
      "@/app/api/settings/results/[resultId]/toppers/[topperId]/photo/route"
    );
    const response = await POST(
      photoFormRequest(form, { origin: "http://localhost" }),
      { params: Promise.resolve({ resultId: created.id, topperId }) } as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.result.toppers[0].photoUrl).toContain("/media/INS0001/");
  });

  it("rejects a request with no file", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const topperId = created.toppers?.[0]?.id as string;
    await signInWithCookie("INS0001");

    const { POST } = await import(
      "@/app/api/settings/results/[resultId]/toppers/[topperId]/photo/route"
    );
    const response = await POST(
      photoFormRequest(new FormData(), { origin: "http://localhost" }),
      { params: Promise.resolve({ resultId: created.id, topperId }) } as never,
    );

    expect(response.status).toBe(400);
  });
});
