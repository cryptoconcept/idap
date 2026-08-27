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
  SHOWCASE_MAX_PDF_BYTES,
} from "@/lib/constants";
// The image cap has exactly one name. Showcase images are uploaded through
// `validateImage`, so this is the limit these tests must exceed to be refused —
// a showcase-specific alias would only be a second name for the same number.
import { MAX_IMAGE_BYTES } from "@/lib/media/image";

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
    const oversized = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);

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

    // Seeded FIRST, deliberately — keep it here rather than moving it after
    // the cap fills, because this ordering catches strictly more.
    //
    // Two mutations can break a per-kind cap, and they are not equivalent:
    //
    //   (i)  the shared `$expr` in `storeAsset` counts photos + certificates.
    //        Either ordering catches this. With the certificate seeded first
    //        the failure lands early and precisely, on the TENTH photo fill
    //        ("An achievement can hold at most 10 photos"); with it seeded
    //        last, the failure lands at the end instead, when the certificate
    //        is evaluated against `max = 5` on a record holding ten photos.
    //   (ii) only the PHOTO branch miscounts — the certificate path keeps its
    //        own field. Seeding the certificate first catches this, because
    //        the tenth photo fill still fails. Seeding it last does NOT: ten
    //        photos alone trip a photo-only cap at the eleventh exactly as a
    //        correct cap does, and the trailing certificate is unaffected, so
    //        the whole test passes.
    //
    // So this ordering is the strictly stronger one. An earlier version of
    // this comment claimed the natural ordering missed (i) as well; it does
    // not, and the reviewer was right to check. The real reason to keep the
    // certificate here is (ii).
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

  it("returns the post-write updatedAt, not the pre-image's", async () => {
    const created = await makeAlumnus("INS0001");

    const after = await AlumniService.setPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );

    // `setPhoto` writes with `{ new: false }` so it can see the key it
    // displaced, which means the document it holds afterwards is the
    // PRE-image. Serializing that directly would report a "last updated" that
    // predates the upload the caller just performed. Pins the scoped re-read
    // that avoids it — without this, simplifying the re-read away looks free.
    expect(new Date(after.updatedAt!).getTime()).toBeGreaterThan(
      new Date(created.updatedAt!).getTime(),
    );
  });

  it("deletes the object its own write displaced, not the one it read beforehand", async () => {
    const created = await makeAlumnus("INS0001");
    const first = await AlumniService.setPhoto(
      "INS0001",
      created.id,
      { contentType: "image/png", bytes: PNG },
      actor,
    );

    // A second writer lands between this call's pre-read and its write. Its
    // photo is the one this call will actually displace — `first.photo` is
    // already gone from the record by then, and is now the OTHER writer's to
    // clean up, not this one's.
    const rival = await storage.putPublic({
      key: "showcase/INS0001/alumni/rival.png",
      body: PNG,
      contentType: "image/png",
    });
    const realPutPublic = storage.putPublic.bind(storage);
    const putPublic = vi.spyOn(storage, "putPublic").mockImplementation(async (file) => {
      await Alumnus.updateOne({ _id: created.id }, { $set: { photo: rival.key } });
      return realPutPublic(file);
    });

    let second;
    try {
      second = await AlumniService.setPhoto(
        "INS0001",
        created.id,
        { contentType: "image/png", bytes: PNG },
        actor,
      );
    } finally {
      putPublic.mockRestore();
    }

    expect(second.photo).not.toBe(rival.key);
    expect(existsSync(storedPath(second.photo!))).toBe(true);
    // The key this write displaced is cleaned up...
    expect(existsSync(storedPath(rival.key))).toBe(false);
    // ...and the key it merely read beforehand is left alone. Reading the
    // displaced key from the write instead of from the pre-read is the whole
    // difference: `{ new: true }` plus `before.photo` would have it backwards,
    // deleting an object this call did not displace and orphaning the one it
    // did.
    expect(existsSync(storedPath(first.photo!))).toBe(true);
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
    const oversized = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);

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

/**
 * Both failure modes of the write that follows a storage put, for both
 * services. Every assertion here is `existsSync` on the path the adapter
 * actually wrote — a call-count assertion would prove the service asked for a
 * delete, not that the object is gone.
 */
describe("a store that is not followed by a successful write leaves nothing behind", () => {
  it("rolls the stored object back when the achievement write throws", async () => {
    const created = await makeAchievement("INS0001");

    const boom = new Error("simulated write failure");
    const putPublic = vi.spyOn(storage, "putPublic");
    const write = vi
      .spyOn(Achievement, "findOneAndUpdate")
      .mockReturnValueOnce({ lean: () => Promise.reject(boom) } as never);
    try {
      await expect(
        AchievementService.addPhoto(
          "INS0001",
          created.id,
          { contentType: "image/png", bytes: PNG },
          actor,
        ),
      ).rejects.toThrow("simulated write failure");

      // A rollback confined to `if (!updated)` never runs on this path, and
      // the object is left in storage with nothing in the database pointing
      // at it — unfindable, because the key was never persisted anywhere.
      const stored = (await putPublic.mock.results[0]!.value) as StoredObject;
      expect(existsSync(storedPath(stored.key))).toBe(false);
    } finally {
      write.mockRestore();
      putPublic.mockRestore();
    }
  });

  it("rolls the stored object back when the alumnus write throws", async () => {
    const created = await makeAlumnus("INS0001");

    const boom = new Error("simulated write failure");
    const putPublic = vi.spyOn(storage, "putPublic");
    const write = vi
      .spyOn(Alumnus, "findOneAndUpdate")
      .mockReturnValueOnce({ lean: () => Promise.reject(boom) } as never);
    try {
      await expect(
        AlumniService.setPhoto(
          "INS0001",
          created.id,
          { contentType: "image/png", bytes: PNG },
          actor,
        ),
      ).rejects.toThrow("simulated write failure");

      const stored = (await putPublic.mock.results[0]!.value) as StoredObject;
      expect(existsSync(storedPath(stored.key))).toBe(false);
    } finally {
      write.mockRestore();
      putPublic.mockRestore();
    }
  });

  it("reports NOT_FOUND, not a cap conflict, when the achievement is deleted mid-upload", async () => {
    const created = await makeAchievement("INS0001");

    // The record vanishes between the pre-read and the write — the genuine
    // race the `!updated` branch has to tell apart from a cap rejection. The
    // storage put is the injection point because it is the one place the
    // service yields between those two queries.
    const realPutPublic = storage.putPublic.bind(storage);
    const putPublic = vi.spyOn(storage, "putPublic").mockImplementation(async (file) => {
      await Achievement.deleteOne({ _id: created.id });
      return realPutPublic(file);
    });

    try {
      await expect(
        AchievementService.addPhoto(
          "INS0001",
          created.id,
          { contentType: "image/png", bytes: PNG },
          actor,
        ),
        // Not CONFLICT: "an achievement can hold at most 10 photos" would be a
        // flatly wrong explanation for a record that no longer exists.
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const stored = (await putPublic.mock.results[0]!.value) as StoredObject;
      expect(existsSync(storedPath(stored.key))).toBe(false);
    } finally {
      putPublic.mockRestore();
    }
  });

  it("reports NOT_FOUND and stores nothing when the alumnus is deleted mid-upload", async () => {
    const created = await makeAlumnus("INS0001");

    const realPutPublic = storage.putPublic.bind(storage);
    const putPublic = vi.spyOn(storage, "putPublic").mockImplementation(async (file) => {
      await Alumnus.deleteOne({ _id: created.id });
      return realPutPublic(file);
    });

    try {
      await expect(
        AlumniService.setPhoto(
          "INS0001",
          created.id,
          { contentType: "image/png", bytes: PNG },
          actor,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const stored = (await putPublic.mock.results[0]!.value) as StoredObject;
      expect(existsSync(storedPath(stored.key))).toBe(false);
    } finally {
      putPublic.mockRestore();
    }
  });
});
