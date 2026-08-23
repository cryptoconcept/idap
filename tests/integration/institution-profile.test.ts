import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Institution } from "@/models";
import { InstitutionService } from "@/services/institution.service";
import { updateProfileSchema } from "@/lib/validation/institution";

const ACTOR = { id: "6a8880f3446c577c470cd06c", name: "Test Admin" };

// A real PNG header followed by padding — passes the magic-byte sniff.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

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
