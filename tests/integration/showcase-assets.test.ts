import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Achievement, Alumnus } from "@/models";
import { AchievementService } from "@/services/achievement.service";
import { AlumniService } from "@/services/alumni.service";
import { storage, type StoredObject } from "@/lib/storage";
import {
  ACHIEVEMENT_MAX_CERTIFICATES,
  ACHIEVEMENT_MAX_PHOTOS,
  SHOWCASE_MAX_IMAGE_BYTES,
  SHOWCASE_MAX_PDF_BYTES,
} from "@/lib/constants";

// `storage.get()` reads the adapter's PRIVATE store, never where `putPublic`
// writes — same helper as tests/integration/results-crud.test.ts, which this
// mirrors.
const PUBLIC_ROOT = resolve(process.env.PUBLIC_UPLOAD_DIR ?? join(process.cwd(), ".uploads-public"));
const storedPath = (key: string) => resolve(PUBLIC_ROOT, key.replace(/^\/api\/media\//, ""));

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

/** Smallest valid PNG — the upload guard sniffs magic numbers, so this must be real. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A minimal but real PDF header — passes the `%PDF-` magic-byte sniff. */
const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< >>\nendobj\n%%EOF", "binary");

/** An id shaped like an achievement's but belonging to no record. */
const UNKNOWN_ID = "6a8bf44bf4e473b526efc999";

// `eventDate: undefined` is explicit because `optionalDateSchema` infers the
// key as required-but-possibly-undefined rather than `?:` — the same quirk
// tests/integration/achievement-service.test.ts works around.
const achievementInput = {
  category: "ACADEMIC" as const,
  title: "Science Olympiad Gold",
  eventDate: undefined,
  level: "STATE" as const,
};

const alumnusInput = {
  name: "Asha Rao",
  category: "SCIENTIST" as const,
};

async function makeAchievement(institutionId: string) {
  return AchievementService.create(institutionId, achievementInput, actor);
}

async function makeAlumnus(institutionId: string) {
  return AlumniService.create(institutionId, alumnusInput, actor);
}

beforeAll(async () => {
  await startTestDatabase("showcase-assets");
  await Achievement.syncIndexes();
  await Alumnus.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("AchievementService.addPhoto", () => {
  it("stores a valid image under the institution's showcase prefix and appends its key", async () => {
    const created = await makeAchievement("INS0001");

    const after = await AchievementService.addPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );

    expect(after.photos).toHaveLength(1);
    const key = after.photos![0]!;
    expect(key).toContain("showcase/INS0001/achievements/");
    expect(key.endsWith(".png")).toBe(true);
    // The key is minted here, never derived from anything a client supplied.
    expect(key).not.toContain("upload");
    expect(existsSync(storedPath(key))).toBe(true);
  });

  it("MUTATION-DISTINGUISHING: magic bytes, not the declared content type", async () => {
    const created = await makeAchievement("INS0001");

    // A multipart form's declared contentType and filename are both
    // client-supplied and prove nothing. Only the bytes prove anything: this
    // payload claims to be a PNG and is a shell script.
    await expect(
      AchievementService.addPhoto(
        "INS0001",
        created.id,
        { contentType: "image/png", bytes: Buffer.from("#!/bin/sh\nrm -rf /\n") },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const row = await Achievement.findById(created.id).lean();
    expect(row!.photos ?? []).toHaveLength(0);
  });

  it("refuses an image over the size cap with the storage adapter never invoked", async () => {
    const created = await makeAchievement("INS0001");
    const oversized = Buffer.concat([PNG, Buffer.alloc(SHOWCASE_MAX_IMAGE_BYTES)]);

    const putPublic = vi.spyOn(storage, "putPublic");
    try {
      await expect(
        AchievementService.addPhoto(
          "INS0001",
          created.id,
          { contentType: "image/png", bytes: oversized },
          actor,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

      // The size check must run before anything is stored. A check placed
      // after the upload would satisfy a throws-only assertion while still
      // burning storage on every rejected file.
      expect(putPublic).not.toHaveBeenCalled();
    } finally {
      putPublic.mockRestore();
    }

    const row = await Achievement.findById(created.id).lean();
    expect(row!.photos ?? []).toHaveLength(0);
  });

  it("caps photos per asset kind: a certificate on the record never counts against the photo cap", async () => {
    const created = await makeAchievement("INS0001");

    // Seeded FIRST, deliberately. If the photo cap counted every asset rather
    // than only photos, this one certificate would make the LAST of the
    // ACHIEVEMENT_MAX_PHOTOS fills below fail — which is what makes this test
    // distinguish a per-kind cap from a shared one. Filling photos first and
    // adding the certificate afterwards would pass either way.
    await AchievementService.addCertificate(
      "INS0001",
      created.id,
      { contentType: "application/pdf", bytes: PDF },
      actor,
    );

    for (let i = 0; i < ACHIEVEMENT_MAX_PHOTOS; i += 1) {
      const after = await AchievementService.addPhoto(
        "INS0001",
        created.id,
        { contentType: "image/png", bytes: PNG },
        actor,
      );
      expect(after.photos).toHaveLength(i + 1);
    }

    await expect(
      AchievementService.addPhoto(
        "INS0001",
        created.id,
        { contentType: "image/png", bytes: PNG },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // ...and a full photo array does not close the certificate path either.
    const after = await AchievementService.addCertificate(
      "INS0001",
      created.id,
      { contentType: "application/pdf", bytes: PDF },
      actor,
    );
    expect(after.photos).toHaveLength(ACHIEVEMENT_MAX_PHOTOS);
    expect(after.certificates).toHaveLength(2);
  });

  it("deletes the just-stored object when the cap refuses the push, rather than orphaning it", async () => {
    const created = await makeAchievement("INS0001");
    for (let i = 0; i < ACHIEVEMENT_MAX_PHOTOS; i += 1) {
      await AchievementService.addPhoto(
        "INS0001",
        created.id,
        { contentType: "image/png", bytes: PNG },
        actor,
      );
    }

    const putPublic = vi.spyOn(storage, "putPublic");
    try {
      await expect(
        AchievementService.addPhoto(
          "INS0001",
          created.id,
          { contentType: "image/png", bytes: PNG },
          actor,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      // The cap lives inside the update filter, so the object is written
      // before the filter can reject it. Without the rollback that object
      // stays in storage forever, referenced by nothing.
      expect(putPublic).toHaveBeenCalledTimes(1);
      const stored = (await putPublic.mock.results[0]!.value) as StoredObject;
      expect(existsSync(storedPath(stored.key))).toBe(false);
    } finally {
      putPublic.mockRestore();
    }
  });

  it("MUTATION-DISTINGUISHING: an INS0001-scoped addPhoto never reaches INS0002's achievement", async () => {
    const victim = await makeAchievement("INS0002");
    const before = await Achievement.findById(victim.id).lean();

    await expect(
      AchievementService.addPhoto(
        "INS0001",
        victim.id,
        { contentType: "image/png", bytes: PNG },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Not merely "it threw": a correctly-scoped query that finds nothing
    // throws the same NOT_FOUND a broken filter's later read would.
    const after = await Achievement.findById(victim.id).lean();
    expect(after).toEqual(before);
  });

  it("rejects an unknown achievement id as NOT_FOUND without storing anything", async () => {
    const putPublic = vi.spyOn(storage, "putPublic");
    try {
      await expect(
        AchievementService.addPhoto(
          "INS0001",
          UNKNOWN_ID,
          { contentType: "image/png", bytes: PNG },
          actor,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(putPublic).not.toHaveBeenCalled();
    } finally {
      putPublic.mockRestore();
    }
  });
});

describe("AchievementService.addCertificate", () => {
  it("stores a valid PDF under the institution's showcase prefix and appends its key", async () => {
    const created = await makeAchievement("INS0001");

    const after = await AchievementService.addCertificate(
      "INS0001",
      created.id,
      { contentType: "application/pdf", bytes: PDF },
      actor,
    );

    expect(after.certificates).toHaveLength(1);
    const key = after.certificates![0]!;
    expect(key).toContain("showcase/INS0001/achievements/");
    expect(key.endsWith(".pdf")).toBe(true);
    expect(existsSync(storedPath(key))).toBe(true);
    // A certificate is not a photo.
    expect(after.photos).toBeUndefined();
  });

  it("MUTATION-DISTINGUISHING: certificate magic bytes, not the declared content type", async () => {
    const created = await makeAchievement("INS0001");

    await expect(
      AchievementService.addCertificate(
        "INS0001",
        created.id,
        { contentType: "application/pdf", bytes: Buffer.from("#!/bin/sh\nrm -rf /\n") },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const row = await Achievement.findById(created.id).lean();
    expect(row!.certificates ?? []).toHaveLength(0);
  });

  it("refuses a PDF over the size cap with the storage adapter never invoked", async () => {
    const created = await makeAchievement("INS0001");
    const oversized = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.alloc(SHOWCASE_MAX_PDF_BYTES),
    ]);

    const putPublic = vi.spyOn(storage, "putPublic");
    try {
      await expect(
        AchievementService.addCertificate(
          "INS0001",
          created.id,
          { contentType: "application/pdf", bytes: oversized },
          actor,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(putPublic).not.toHaveBeenCalled();
    } finally {
      putPublic.mockRestore();
    }

    const row = await Achievement.findById(created.id).lean();
    expect(row!.certificates ?? []).toHaveLength(0);
  });

  it("caps certificates at ACHIEVEMENT_MAX_CERTIFICATES", async () => {
    const created = await makeAchievement("INS0001");
    for (let i = 0; i < ACHIEVEMENT_MAX_CERTIFICATES; i += 1) {
      await AchievementService.addCertificate(
        "INS0001",
        created.id,
        { contentType: "application/pdf", bytes: PDF },
        actor,
      );
    }

    await expect(
      AchievementService.addCertificate(
        "INS0001",
        created.id,
        { contentType: "application/pdf", bytes: PDF },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("MUTATION-DISTINGUISHING: an INS0001-scoped addCertificate never reaches INS0002's achievement", async () => {
    const victim = await makeAchievement("INS0002");
    const before = await Achievement.findById(victim.id).lean();

    await expect(
      AchievementService.addCertificate(
        "INS0001",
        victim.id,
        { contentType: "application/pdf", bytes: PDF },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Achievement.findById(victim.id).lean();
    expect(after).toEqual(before);
  });
});

describe("AchievementService.removeAsset", () => {
  it("drops a photo from the record and deletes its stored object", async () => {
    const created = await makeAchievement("INS0001");
    const withPhoto = await AchievementService.addPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const key = withPhoto.photos![0]!;
    expect(existsSync(storedPath(key))).toBe(true);

    const after = await AchievementService.removeAsset(
      "INS0001",
      created.id,
      { kind: "PHOTO", key },
      actor,
    );

    expect(after.photos).toBeUndefined();
    expect(existsSync(storedPath(key))).toBe(false);
  });

  it("drops a certificate from the record and deletes its stored object", async () => {
    const created = await makeAchievement("INS0001");
    const withCert = await AchievementService.addCertificate(
      "INS0001",
      created.id,
      { contentType: "application/pdf", bytes: PDF },
      actor,
    );
    const key = withCert.certificates![0]!;

    const after = await AchievementService.removeAsset(
      "INS0001",
      created.id,
      { kind: "CERTIFICATE", key },
      actor,
    );

    expect(after.certificates).toBeUndefined();
    expect(existsSync(storedPath(key))).toBe(false);
  });

  it("refuses a key that is not on the record, and deletes nothing from storage", async () => {
    const created = await makeAchievement("INS0001");
    const withPhoto = await AchievementService.addPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const key = withPhoto.photos![0]!;

    const deletePublic = vi.spyOn(storage, "deletePublic");
    try {
      await expect(
        AchievementService.removeAsset(
          "INS0001",
          created.id,
          // The right shape, on the right record, naming an object this
          // record does not hold.
          { kind: "PHOTO", key: "/api/media/showcase/INS0001/achievements/deadbeef.png" },
          actor,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(deletePublic).not.toHaveBeenCalled();
    } finally {
      deletePublic.mockRestore();
    }

    expect(existsSync(storedPath(key))).toBe(true);
  });

  it("refuses a photo key addressed as a certificate, so one kind cannot delete the other's object", async () => {
    const created = await makeAchievement("INS0001");
    const withPhoto = await AchievementService.addPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const key = withPhoto.photos![0]!;

    await expect(
      AchievementService.removeAsset("INS0001", created.id, { kind: "CERTIFICATE", key }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(existsSync(storedPath(key))).toBe(true);
  });

  it("MUTATION-DISTINGUISHING: an INS0001-scoped removeAsset never reaches INS0002's achievement", async () => {
    const victim = await makeAchievement("INS0002");
    const withPhoto = await AchievementService.addPhoto(
      "INS0002",
      victim.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const key = withPhoto.photos![0]!;
    const before = await Achievement.findById(victim.id).lean();

    await expect(
      AchievementService.removeAsset("INS0001", victim.id, { kind: "PHOTO", key }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Achievement.findById(victim.id).lean();
    expect(after).toEqual(before);
    expect(existsSync(storedPath(key))).toBe(true);
  });
});

describe("AchievementService.remove cleans up storage", () => {
  it("deletes every photo and certificate the record held", async () => {
    const created = await makeAchievement("INS0001");
    const withPhotos = await AchievementService.addPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    await AchievementService.addPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const withAll = await AchievementService.addCertificate(
      "INS0001",
      created.id,
      { contentType: "application/pdf", bytes: PDF },
      actor,
    );
    const keys = [...withAll.photos!, ...withAll.certificates!];
    expect(keys).toHaveLength(3);
    expect(withPhotos.photos).toHaveLength(1);
    for (const key of keys) expect(existsSync(storedPath(key))).toBe(true);

    const deletePublic = vi.spyOn(storage, "deletePublic");
    try {
      await AchievementService.remove("INS0001", created.id, actor);
      // Exactly the record's own keys, nothing else.
      expect(deletePublic.mock.calls.map((call) => call[0]).sort()).toEqual([...keys].sort());
    } finally {
      deletePublic.mockRestore();
    }

    for (const key of keys) expect(existsSync(storedPath(key))).toBe(false);
  });

  it("deletes nothing when a foreign-scoped remove is refused", async () => {
    const victim = await makeAchievement("INS0002");
    const withPhoto = await AchievementService.addPhoto(
      "INS0002",
      victim.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const key = withPhoto.photos![0]!;

    await expect(
      AchievementService.remove("INS0001", victim.id, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(existsSync(storedPath(key))).toBe(true);
  });
});

describe("AlumniService.setPhoto", () => {
  it("stores a valid image under the institution's alumni prefix and sets it on the record", async () => {
    const created = await makeAlumnus("INS0001");

    const after = await AlumniService.setPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );

    expect(after.photo).toBeDefined();
    expect(after.photo!).toContain("showcase/INS0001/alumni/");
    expect(after.photo!.endsWith(".png")).toBe(true);
    expect(existsSync(storedPath(after.photo!))).toBe(true);
  });

  it("deletes the previous object when a photo is replaced, rather than orphaning it", async () => {
    const created = await makeAlumnus("INS0001");
    const first = await AlumniService.setPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const second = await AlumniService.setPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );

    expect(second.photo).not.toBe(first.photo);
    expect(existsSync(storedPath(first.photo!))).toBe(false);
    expect(existsSync(storedPath(second.photo!))).toBe(true);
  });

  it("MUTATION-DISTINGUISHING: magic bytes, not the declared content type", async () => {
    const created = await makeAlumnus("INS0001");

    await expect(
      AlumniService.setPhoto(
        "INS0001",
        created.id,
        { contentType: "image/jpeg", bytes: Buffer.from("#!/bin/sh\nrm -rf /\n") },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const row = await Alumnus.findById(created.id).lean();
    expect(row!.photo).toBeUndefined();
  });

  it("refuses an image over the size cap with the storage adapter never invoked", async () => {
    const created = await makeAlumnus("INS0001");
    const oversized = Buffer.concat([PNG, Buffer.alloc(SHOWCASE_MAX_IMAGE_BYTES)]);

    const putPublic = vi.spyOn(storage, "putPublic");
    try {
      await expect(
        AlumniService.setPhoto(
          "INS0001",
          created.id,
          { contentType: "image/png", bytes: oversized },
          actor,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(putPublic).not.toHaveBeenCalled();
    } finally {
      putPublic.mockRestore();
    }

    const row = await Alumnus.findById(created.id).lean();
    expect(row!.photo).toBeUndefined();
  });

  it("MUTATION-DISTINGUISHING: an INS0001-scoped setPhoto never reaches INS0002's alumnus", async () => {
    const victim = await makeAlumnus("INS0002");
    const before = await Alumnus.findById(victim.id).lean();

    await expect(
      AlumniService.setPhoto(
        "INS0001",
        victim.id,
        { contentType: "image/png", bytes: PNG },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Alumnus.findById(victim.id).lean();
    expect(after).toEqual(before);
  });

  it("rejects an unknown alumnus id as NOT_FOUND without storing anything", async () => {
    const putPublic = vi.spyOn(storage, "putPublic");
    try {
      await expect(
        AlumniService.setPhoto(
          "INS0001",
          UNKNOWN_ID,
          { contentType: "image/png", bytes: PNG },
          actor,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(putPublic).not.toHaveBeenCalled();
    } finally {
      putPublic.mockRestore();
    }
  });
});

describe("AlumniService.remove cleans up storage", () => {
  it("deletes the alumnus's stored photo", async () => {
    const created = await makeAlumnus("INS0001");
    const withPhoto = await AlumniService.setPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const key = withPhoto.photo!;
    expect(existsSync(storedPath(key))).toBe(true);

    const deletePublic = vi.spyOn(storage, "deletePublic");
    try {
      await AlumniService.remove("INS0001", created.id, actor);
      expect(deletePublic.mock.calls.map((call) => call[0])).toEqual([key]);
    } finally {
      deletePublic.mockRestore();
    }

    expect(existsSync(storedPath(key))).toBe(false);
  });

  it("removes a photoless alumnus without asking storage to delete anything", async () => {
    const created = await makeAlumnus("INS0001");

    const deletePublic = vi.spyOn(storage, "deletePublic");
    try {
      await AlumniService.remove("INS0001", created.id, actor);
      expect(deletePublic).not.toHaveBeenCalled();
    } finally {
      deletePublic.mockRestore();
    }
  });

  it("deletes nothing when a foreign-scoped remove is refused", async () => {
    const victim = await makeAlumnus("INS0002");
    const withPhoto = await AlumniService.setPhoto(
      "INS0002",
      victim.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const key = withPhoto.photo!;

    await expect(AlumniService.remove("INS0001", victim.id, actor)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    expect(existsSync(storedPath(key))).toBe(true);
  });
});
