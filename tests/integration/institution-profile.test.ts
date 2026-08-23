import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Institution } from "@/models";
import { InstitutionService } from "@/services/institution.service";
import { updateProfileSchema } from "@/lib/validation/institution";
import { storage } from "@/lib/storage";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ACTOR = { id: "6a8880f3446c577c470cd06c", name: "Test Admin" };

// A real PNG header followed by padding — passes the magic-byte sniff.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

/** Where the local adapter actually wrote an object it handed back as `/api/media/<key>`. */
const PUBLIC_ROOT = resolve(process.env.PUBLIC_UPLOAD_DIR ?? join(process.cwd(), ".uploads-public"));
const storedPath = (url: string) => resolve(PUBLIC_ROOT, url.replace(/^\/api\/media\//, ""));

describe("institution profile service", () => {
  beforeAll(async () => {
    await startTestDatabase("institutionprofile");
    await Institution.syncIndexes();
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("updates one section without erasing a sibling field", async () => {
    await makeInstitution("INS0001");
    await InstitutionService.updateProfile(
      "INS0001",
      updateProfileSchema.parse({ academic: { board: "State", classesOffered: ["1", "2"] } }),
      ACTOR,
    );

    // A later patch touching only the board must not wipe classesOffered.
    await InstitutionService.updateProfile(
      "INS0001",
      updateProfileSchema.parse({ academic: { board: "CBSE" } }),
      ACTOR,
    );

    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
    expect(row!.academic!.board).toBe("CBSE");
    expect(row!.academic!.classesOffered).toEqual(["1", "2"]);
  });

  it("returns completion alongside the profile", async () => {
    await makeInstitution("INS0001");
    const { completion } = await InstitutionService.getProfile("INS0001");
    expect(completion.percent).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(completion.missing)).toBe(true);
  });

  it("publishes and records when, then unpublishes without losing the date", async () => {
    await makeInstitution("INS0001");
    const published = await InstitutionService.setProfileStatus("INS0001", "PUBLISHED", ACTOR);
    expect(published.profileStatus).toBe("PUBLISHED");
    expect(published.publishedAt).toBeDefined();

    const draft = await InstitutionService.setProfileStatus("INS0001", "DRAFT", ACTOR);
    expect(draft.profileStatus).toBe("DRAFT");
    expect(draft.publishedAt).toBeDefined(); // history, not state
  });

  it("stores a logo and replaces it on the next upload", async () => {
    await makeInstitution("INS0001");
    const first = await InstitutionService.addMedia(
      "INS0001",
      { kind: "LOGO", fileName: "logo.png", contentType: "image/png", bytes: PNG },
      ACTOR,
    );
    expect(first.logoUrl).toBeTruthy();

    const second = await InstitutionService.addMedia(
      "INS0001",
      { kind: "LOGO", fileName: "logo2.png", contentType: "image/png", bytes: PNG },
      ACTOR,
    );
    expect(second.logoUrl).toBeTruthy();
    expect(second.logoUrl).not.toBe(first.logoUrl);
  });

  it("rejects a fake image regardless of its declared content type", async () => {
    await makeInstitution("INS0001");
    await expect(
      InstitutionService.addMedia(
        "INS0001",
        {
          kind: "GALLERY",
          fileName: "evil.png",
          contentType: "image/png",
          bytes: Buffer.from("#!/bin/sh\nrm -rf /\n"),
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("enforces the gallery cap atomically", async () => {
    await makeInstitution("INS0001", {
      gallery: Array.from({ length: 60 }, (_, i) => ({
        imageUrl: `https://cdn.test/${i}.jpg`,
        status: "ACTIVE",
      })),
    });

    await expect(
      InstitutionService.addMedia(
        "INS0001",
        { kind: "GALLERY", fileName: "one-too-many.png", contentType: "image/png", bytes: PNG },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("removes a gallery item by id", async () => {
    await makeInstitution("INS0001");
    await InstitutionService.addMedia(
      "INS0001",
      { kind: "GALLERY", fileName: "a.png", contentType: "image/png", bytes: PNG, title: "A" },
      ACTOR,
    );
    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
    const mediaId = String(row!.gallery![0]!._id);

    const after = await InstitutionService.removeGalleryItem("INS0001", mediaId, ACTOR);
    expect(after.gallery ?? []).toHaveLength(0);
  });

  it("allocates a slug when an institution is created", async () => {
    const { institution } = await InstitutionService.create(
      { institutionName: "Green Valley Public School", institutionType: "SCHOOL", city: "Mysore" } as never,
      ACTOR,
    );
    const row = await Institution.findOne({ institutionId: institution.institutionId }).lean();
    expect(row!.slug).toMatch(/^green-valley-public-school/);
  });

  it("clears a logo and a cover when the patch sends an explicit null", async () => {
    await makeInstitution("INS0001", {
      logoUrl: "https://cdn.test/logo.png",
      coverImageUrl: "https://cdn.test/cover.jpg",
      tagline: "Kept",
    });

    await InstitutionService.updateProfile(
      "INS0001",
      updateProfileSchema.parse({ logoUrl: null, coverImageUrl: null }),
      ACTOR,
    );

    // `$unset`, not `$set: null` — the field is gone, not stored as a null the
    // DTO would have to keep translating back.
    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
    expect(row).not.toHaveProperty("logoUrl");
    expect(row).not.toHaveProperty("coverImageUrl");
    expect(row!.tagline).toBe("Kept");
  });

  it("leaves an image alone when the patch does not mention it", async () => {
    await makeInstitution("INS0001", {
      logoUrl: "https://cdn.test/logo.png",
      coverImageUrl: "https://cdn.test/cover.jpg",
    });

    await InstitutionService.updateProfile(
      "INS0001",
      updateProfileSchema.parse({ logoUrl: null, tagline: "New" }),
      ACTOR,
    );

    // `undefined` (absent) and `null` (clear) are different instructions: only
    // the field the patch actually named is cleared.
    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
    expect(row).not.toHaveProperty("logoUrl");
    expect(row!.coverImageUrl).toBe("https://cdn.test/cover.jpg");
    expect(row!.tagline).toBe("New");
  });

  it("accepts a patch that touches nothing", async () => {
    // The update object is now assembled operator by operator, so the
    // all-undefined patch has to stay a harmless no-op rather than an empty
    // `$set` the server would reject.
    await makeInstitution("INS0001", { tagline: "Kept" });
    const profile = await InstitutionService.updateProfile(
      "INS0001",
      updateProfileSchema.parse({}),
      ACTOR,
    );
    expect(profile.tagline).toBe("Kept");
  });

  it("never deletes another institution's media when a hijacked logoUrl is replaced", async () => {
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");

    // INS0002 uploads a real logo. Its URL is public by design — every
    // published profile, hosted apply page and widget hands it out.
    const victim = await InstitutionService.addMedia(
      "INS0002",
      { kind: "LOGO", fileName: "logo.png", contentType: "image/png", bytes: PNG },
      ACTOR,
    );
    const victimUrl = victim.logoUrl!;
    expect(victimUrl).toContain("media/INS0002/");

    // The same object addressed the way the Vercel Blob adapter hands it back:
    // an absolute https URL, which is the shape `logoUrl`'s free-text schema
    // accepts on the profile PATCH.
    const hijacked = `https://store.public.blob.vercel-storage.com${victimUrl.replace("/api/media", "")}`;

    // INS0001 points its own logoUrl at INS0002's object...
    await InstitutionService.updateProfile(
      "INS0001",
      updateProfileSchema.parse({ logoUrl: hijacked }),
      ACTOR,
    );

    const deletePublic = vi.spyOn(storage, "deletePublic");
    try {
      // ...then uploads a logo of its own, which is what triggers the
      // replace-in-place cleanup of whatever `logoUrl` currently holds.
      await InstitutionService.addMedia(
        "INS0001",
        { kind: "LOGO", fileName: "new.png", contentType: "image/png", bytes: PNG },
        ACTOR,
      );

      // The spy is the assertion, not the filesystem: only the Blob adapter
      // resolves an absolute URL back to a stored object, so the local adapter
      // would no-op here whether or not the guard existed.
      expect(deletePublic).not.toHaveBeenCalledWith(hijacked);
      expect(deletePublic.mock.calls.flat()).not.toContain(victimUrl);
      expect(deletePublic).not.toHaveBeenCalled();
    } finally {
      deletePublic.mockRestore();
    }
  });

  it("still cleans up its own previous logo when a new one replaces it", async () => {
    await makeInstitution("INS0001");

    const first = await InstitutionService.addMedia(
      "INS0001",
      { kind: "LOGO", fileName: "one.png", contentType: "image/png", bytes: PNG },
      ACTOR,
    );
    const firstUrl = first.logoUrl!;
    expect(existsSync(storedPath(firstUrl))).toBe(true);

    const deletePublic = vi.spyOn(storage, "deletePublic");
    try {
      await InstitutionService.addMedia(
        "INS0001",
        { kind: "LOGO", fileName: "two.png", contentType: "image/png", bytes: PNG },
        ACTOR,
      );
      // Not too tight: an object this institution genuinely owns is still
      // cleaned up, and really leaves the store.
      expect(deletePublic).toHaveBeenCalledWith(firstUrl);
    } finally {
      deletePublic.mockRestore();
    }

    expect(existsSync(storedPath(firstUrl))).toBe(false);
  });

  it("leaves a gallery object belonging to another institution alone on delete", async () => {
    await makeInstitution("INS0001", {
      gallery: [
        {
          imageUrl: "https://store.public.blob.vercel-storage.com/media/INS0002/foreign.png",
          status: "ACTIVE",
        },
      ],
    });
    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
    const mediaId = String(row!.gallery![0]!._id);

    const deletePublic = vi.spyOn(storage, "deletePublic");
    try {
      const after = await InstitutionService.removeGalleryItem("INS0001", mediaId, ACTOR);
      expect(after.gallery ?? []).toHaveLength(0);
      expect(deletePublic).not.toHaveBeenCalled();
    } finally {
      deletePublic.mockRestore();
    }
  });

  it("keeps the platform patch away from profile content", async () => {
    await makeInstitution("INS0001", { description: "original" });
    await InstitutionService.patchPlatform(
      "INS0001",
      { institutionName: "Renamed", regionCode: "KA-MYS", active: false },
      ACTOR,
    );

    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
    expect(row!.institutionName).toBe("Renamed");
    expect(row!.regionCode).toBe("KA-MYS");
    expect(row!.active).toBe(false);
    expect(row!.description).toBe("original");
  });
});
