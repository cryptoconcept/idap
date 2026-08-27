import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDatabase, stopTestDatabase } from "../helpers/db";
import { Institution } from "@/models";
import { makeInstitution } from "../helpers/factories";
import { migrateGalleryToMedia } from "@/../scripts/migrate-gallery-to-media";

describe("gallery → media migration", () => {
  beforeAll(async () => {
    await startTestDatabase("migrategallerytomedia");
    await Institution.syncIndexes();
  });
  afterAll(stopTestDatabase);
  beforeEach(async () => {
    await Institution.deleteMany({});
  });

  it("moves a legacy gallery item into media as an IMAGE", async () => {
    await makeInstitution("INS0001");
    await Institution.collection.updateOne(
      { institutionId: "INS0001" },
      {
        $set: {
          gallery: [
            {
              _id: new (await import("mongoose")).Types.ObjectId(),
              imageUrl: "/api/media/media/INS0001/a.png",
              title: "Campus",
              description: "The main block",
              sortOrder: 2,
              status: "HIDDEN",
              uploadedAt: new Date("2026-01-01"),
            },
          ],
        },
      },
    );

    const report = await migrateGalleryToMedia({ apply: true });

    expect(report.migrated).toBe(1);
    const row = await Institution.collection.findOne({ institutionId: "INS0001" });
    expect(row?.gallery).toBeUndefined();
    expect(row?.media).toHaveLength(1);
    expect(row?.media[0]).toMatchObject({
      kind: "IMAGE",
      url: "/api/media/media/INS0001/a.png",
      title: "Campus",
      caption: "The main block",
      sortOrder: 2,
      status: "HIDDEN",
    });
  });

  it("is idempotent — a second run migrates nothing", async () => {
    await makeInstitution("INS0002");
    await Institution.collection.updateOne(
      { institutionId: "INS0002" },
      { $set: { gallery: [{ imageUrl: "/api/media/x.png", status: "ACTIVE" }] } },
    );

    await migrateGalleryToMedia({ apply: true });
    const second = await migrateGalleryToMedia({ apply: true });

    expect(second.migrated).toBe(0);
  });

  // MUTATION-DISTINGUISHING: silent truncation would satisfy every other test
  // here. This is the one that fails if the script shortens instead of refusing.
  it("refuses a description longer than the caption cap, without writing", async () => {
    await makeInstitution("INS0003");
    const long = "x".repeat(241);
    await Institution.collection.updateOne(
      { institutionId: "INS0003" },
      { $set: { gallery: [{ imageUrl: "/api/media/x.png", description: long, status: "ACTIVE" }] } },
    );

    const report = await migrateGalleryToMedia({ apply: true });

    expect(report.migrated).toBe(0);
    expect(report.overlong).toHaveLength(1);
    expect(report.overlong[0]).toMatchObject({ institutionId: "INS0003", length: 241 });

    const row = await Institution.collection.findOne({ institutionId: "INS0003" });
    expect(row?.media).toBeUndefined();
    expect(row?.gallery).toHaveLength(1);
  });

  it("does not write anything in dry-run mode", async () => {
    await makeInstitution("INS0004");
    await Institution.collection.updateOne(
      { institutionId: "INS0004" },
      { $set: { gallery: [{ imageUrl: "/api/media/x.png", status: "ACTIVE" }] } },
    );

    const report = await migrateGalleryToMedia({ apply: false });

    expect(report.migrated).toBe(1);
    const row = await Institution.collection.findOne({ institutionId: "INS0004" });
    expect(row?.media).toBeUndefined();
  });

  // MUTATION-DISTINGUISHING: the migration writes `media` with a full
  // `$set`, which would silently destroy an institution's real content if the
  // migration ran after the new upload flow had already populated it. This is
  // the test that fails if that guard is removed.
  it("refuses to touch an institution whose media array is already populated", async () => {
    await makeInstitution("INS0005");
    await Institution.collection.updateOne(
      { institutionId: "INS0005" },
      {
        $set: {
          media: [
            {
              _id: new (await import("mongoose")).Types.ObjectId(),
              kind: "VIDEO",
              url: "https://youtube.com/watch?v=abc123",
              status: "ACTIVE",
            },
          ],
          gallery: [{ imageUrl: "/api/media/x.png", status: "ACTIVE" }],
        },
      },
    );

    const report = await migrateGalleryToMedia({ apply: true });

    expect(report.migrated).toBe(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ institutionId: "INS0005" });

    const row = await Institution.collection.findOne({ institutionId: "INS0005" });
    expect(row?.media).toHaveLength(1);
    expect(row?.media[0]).toMatchObject({
      kind: "VIDEO",
      url: "https://youtube.com/watch?v=abc123",
      status: "ACTIVE",
    });
    expect(row?.gallery).toHaveLength(1);
  });

  it("still migrates normally when gallery has no media field alongside it", async () => {
    await makeInstitution("INS0006");
    await Institution.collection.updateOne(
      { institutionId: "INS0006" },
      { $set: { gallery: [{ imageUrl: "/api/media/x.png", status: "ACTIVE" }] } },
    );

    const report = await migrateGalleryToMedia({ apply: true });

    expect(report.migrated).toBe(1);
    expect(report.skipped).toHaveLength(0);
    const row = await Institution.collection.findOne({ institutionId: "INS0006" });
    expect(row?.gallery).toBeUndefined();
    expect(row?.media).toHaveLength(1);
  });
});
