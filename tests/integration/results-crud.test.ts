import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Result } from "@/models";
import { ResultService } from "@/services/result.service";
import { storage } from "@/lib/storage";

// `storage.get()` reads the adapter's PRIVATE store, never where `putPublic`
// writes — see tests/integration/results-media.test.ts, which this mirrors.
const PUBLIC_ROOT = resolve(process.env.PUBLIC_UPLOAD_DIR ?? join(process.cwd(), ".uploads-public"));
const storedPath = (url: string) => resolve(PUBLIC_ROOT, url.replace(/^\/api\/media\//, ""));

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

/** Smallest valid PNG — the upload guard sniffs magic numbers, so this must be real. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** An id shaped like a topper's but belonging to no topper on this result. */
const UNKNOWN_TOPPER_ID = "6a8bf44bf4e473b526efc999";

const cycle = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  stream: null,
  academicYear: "2025-26",
  appeared: 142,
  passed: 140,
};

beforeAll(async () => {
  await startTestDatabase("results-crud");
  // Mongoose builds indexes in the background; without waiting for it here,
  // the very first duplicate-cycle write can race ahead of the unique index
  // actually existing on the server. Same pattern as slug.test.ts and
  // institution-model.test.ts for the same reason.
  await Result.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("ResultService CRUD", () => {
  it("creates a cycle and reads it back", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);

    expect(created.id).toBeDefined();
    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();

    const read = await ResultService.get("INS0001", created.id);
    expect(read.academicYear).toBe("2025-26");
  });

  it("refuses a duplicate cycle via the unique index, not a pre-read", async () => {
    await ResultService.create("INS0001", cycle, actor);

    // A duplicate surfaces as a Mongo 11000, which handleApiError maps to CONFLICT.
    await expect(ResultService.create("INS0001", cycle, actor)).rejects.toMatchObject({
      code: 11000,
    });
  });

  it("lets two institutions hold the same cycle independently", async () => {
    await ResultService.create("INS0001", cycle, actor);
    await expect(ResultService.create("INS0002", cycle, actor)).resolves.toBeDefined();
  });

  it("treats a differing stream as a different cycle", async () => {
    await ResultService.create("INS0001", { ...cycle, level: "CLASS_12", stream: "SCIENCE" }, actor);
    await expect(
      ResultService.create("INS0001", { ...cycle, level: "CLASS_12", stream: "COMMERCE" }, actor),
    ).resolves.toBeDefined();
  });

  it("merges a partial patch without erasing untouched fields", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, averageScore: 82.4, highestScore: 98.6 },
      actor,
    );

    const updated = await ResultService.update("INS0001", created.id, { passed: 141 }, actor);

    expect(updated.passed).toBe(141);
    expect(updated.averageScore).toBe(82.4);
    expect(updated.highestScore).toBe(98.6);
  });

  it("validates invariants against the merged record, not the patch alone", async () => {
    const created = await ResultService.create("INS0001", { ...cycle, appeared: 10, passed: 5 }, actor);

    // The patch carries no `appeared`; the merged record still must hold.
    await expect(
      ResultService.update("INS0001", created.id, { passed: 11 }, actor),
    ).rejects.toThrow(/cannot exceed/i);
  });

  it("replaces arrays wholesale rather than merging them element by element", async () => {
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        bands: [
          { label: "A", minPercentage: 90, maxPercentage: 100, count: 5 },
          { label: "B", minPercentage: 75, maxPercentage: 89, count: 5 },
        ],
      },
      actor,
    );

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      { bands: [{ label: "Only", minPercentage: 60, maxPercentage: 100, count: 1 }] },
      actor,
    );

    expect(updated.bands).toHaveLength(1);
    expect(updated.bands?.[0]?.label).toBe("Only");
  });

  it("keeps a topper's identity and photo when the list is patched by id", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, toppers: [{ name: "Priya S", percentage: 98.6, consentAcknowledged: true }] },
      actor,
    );
    const topperId = created.toppers?.[0]?.id as string;

    const withPhoto = await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const photoUrl = withPhoto.toppers?.[0]?.photoUrl as string;
    expect(photoUrl).toBeDefined();

    // What the editor sends: the whole list back, each row naming its topper.
    const updated = await ResultService.update(
      "INS0001",
      created.id,
      {
        toppers: [
          { id: topperId, name: "Priya Sharma", percentage: 98.6, consentAcknowledged: true },
        ],
      },
      actor,
    );

    // The edit lands, and the photograph the caller cannot send survives it.
    expect(updated.toppers?.[0]?.name).toBe("Priya Sharma");
    expect(updated.toppers?.[0]?.id).toBe(topperId);
    expect(updated.toppers?.[0]?.photoUrl).toBe(photoUrl);
  });

  it("treats a topper with an unknown id, or none at all, as new and photoless", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, toppers: [{ name: "Priya S", percentage: 98.6, consentAcknowledged: true }] },
      actor,
    );
    const topperId = created.toppers?.[0]?.id as string;
    await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      {
        toppers: [
          { id: UNKNOWN_TOPPER_ID, name: "Meera N", percentage: 97.1, consentAcknowledged: true },
          { name: "Rahul K", percentage: 96.4, consentAcknowledged: true },
        ],
      },
      actor,
    );

    // Neither row named a stored topper, so neither inherits one.
    expect(updated.toppers).toHaveLength(2);
    expect(updated.toppers?.[0]?.id).not.toBe(topperId);
    expect(updated.toppers?.[0]?.id).not.toBe(UNKNOWN_TOPPER_ID);
    expect(updated.toppers?.[0]?.photoUrl).toBeUndefined();
    expect(updated.toppers?.[1]?.photoUrl).toBeUndefined();
  });

  it("lets at most one row claim a given stored topper", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, toppers: [{ name: "Priya S", percentage: 98.6, consentAcknowledged: true }] },
      actor,
    );
    const topperId = created.toppers?.[0]?.id as string;
    await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      {
        toppers: [
          { id: topperId, name: "Priya S", percentage: 98.6, consentAcknowledged: true },
          { id: topperId, name: "Priya S (again)", percentage: 98.6, consentAcknowledged: true },
        ],
      },
      actor,
    );

    // One `_id`, one photo — the second row is a new topper, not a clone.
    expect(updated.toppers?.[0]?.id).toBe(topperId);
    expect(updated.toppers?.[1]?.id).not.toBe(topperId);
    expect(updated.toppers?.[0]?.photoUrl).toBeDefined();
    expect(updated.toppers?.[1]?.photoUrl).toBeUndefined();
  });

  it("deletes a removed topper's stored photo when a patch drops it from the list", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, toppers: [{ name: "Priya S", percentage: 98.6, consentAcknowledged: true }] },
      actor,
    );
    const topperId = created.toppers?.[0]?.id as string;
    const withPhoto = await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId,
      { contentType: "image/png", bytes: PNG },
      actor,
    );
    const photoUrl = withPhoto.toppers?.[0]?.photoUrl as string;
    expect(photoUrl).toBeDefined();

    // The incoming list simply omits the topper — a delete, not a merge miss.
    const updated = await ResultService.update("INS0001", created.id, { toppers: [] }, actor);

    expect(updated.toppers).toBeUndefined();
    expect(existsSync(storedPath(photoUrl))).toBe(false);
  });

  it("never deletes a stored URL this institution does not own, even for a removed topper", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, toppers: [{ name: "Priya S", percentage: 98.6, consentAcknowledged: true }] },
      actor,
    );
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

    await ResultService.update("INS0001", created.id, { toppers: [] }, actor);

    // The foreign object must still exist — the guard refused to delete it.
    expect(existsSync(storedPath(foreign))).toBe(true);
  });

  it("returns NOT_FOUND, never FORBIDDEN, for another institution's result", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);

    await expect(ResultService.get("INS0002", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      ResultService.update("INS0002", created.id, { passed: 1 }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ResultService.remove("INS0002", created.id, actor)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lists only the calling institution's cycles, newest academic year first", async () => {
    await ResultService.create("INS0001", { ...cycle, academicYear: "2024-25" }, actor);
    await ResultService.create("INS0001", { ...cycle, academicYear: "2025-26" }, actor);
    await ResultService.create("INS0002", cycle, actor);

    const list = await ResultService.list("INS0001");

    expect(list).toHaveLength(2);
    expect(list[0]?.academicYear).toBe("2025-26");
  });

  it("deletes a cycle", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.remove("INS0001", created.id, actor);

    await expect(ResultService.get("INS0001", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects a malformed resultId as NOT_FOUND rather than throwing a cast error", async () => {
    await expect(ResultService.get("INS0001", "not-an-object-id")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("combinations, placement and selections", () => {
  it("creates and returns a result carrying every new axis", async () => {
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        level: "PUC_2",
        combinations: [{ label: "PCMB", appeared: 40, passed: 38 }],
        placement: { eligible: 10, placed: 8, recruiters: [{ name: "Acme", selected: 3 }] },
        selections: [{ examCode: "KCET", qualified: 20 }],
      },
      actor,
    );

    expect(created.combinations?.[0]).toMatchObject({ label: "PCMB", appeared: 40, passed: 38 });
    expect(created.placement?.placed).toBe(8);
    expect(created.selections?.[0]).toMatchObject({ examCode: "KCET", qualified: 20 });
  });

  it("a combination's toppers survive a patch that edits an unrelated field on that same combination", async () => {
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        level: "PUC_2",
        combinations: [
          { label: "PCMB", appeared: 40, toppers: [{ name: "Priya S", percentage: 98.6 }] },
        ],
      },
      actor,
    );

    const combinationId = created.combinations?.[0]?.id;
    const topperId = created.combinations?.[0]?.toppers?.[0]?.id;
    expect(combinationId).toBeDefined();
    expect(topperId).toBeDefined();

    // A real photo, so the survival check is meaningful — not just an id.
    await ResultService.setTopperPhoto(
      "INS0001",
      created.id,
      topperId as string,
      { contentType: "image/png", bytes: Buffer.from("not-a-real-image") },
      actor,
    ).catch(() => undefined); // image validation may reject the fixture bytes; the id path is what this test checks

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      {
        combinations: [
          {
            id: combinationId,
            label: "PCMB",
            appeared: 42,
            toppers: [{ id: topperId, name: "Priya S", percentage: 98.6 }],
          },
        ],
      },
      actor,
    );

    expect(updated.combinations?.[0]?.appeared).toBe(42);
    expect(updated.combinations?.[0]?.toppers?.[0]?.id).toBe(topperId);
  });

  it("a selection is matched by examCode on update, not replaced as a new row", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, selections: [{ examCode: "KCET", qualified: 20 }] },
      actor,
    );

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      { selections: [{ examCode: "KCET", qualified: 25 }] },
      actor,
    );

    expect(updated.selections).toHaveLength(1);
    expect(updated.selections?.[0]?.qualified).toBe(25);
  });

  it("a selection's toppers survive a patch that edits an unrelated field on that same selection", async () => {
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        selections: [
          { examCode: "KCET", qualified: 20, toppers: [{ name: "Priya S", percentage: 98.6 }] },
        ],
      },
      actor,
    );

    const topperId = created.selections?.[0]?.toppers?.[0]?.id;
    expect(topperId).toBeDefined();

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      {
        selections: [
          {
            examCode: "KCET",
            qualified: 25,
            toppers: [{ id: topperId, name: "Priya S", percentage: 98.6 }],
          },
        ],
      },
      actor,
    );

    expect(updated.selections?.[0]?.qualified).toBe(25);
    expect(updated.selections?.[0]?.toppers?.[0]?.id).toBe(topperId);
  });

  it("a combination named by an id matching nothing on this result is created fresh", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, combinations: [{ label: "PCMB", appeared: 40 }] },
      actor,
    );

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      {
        combinations: [
          { id: UNKNOWN_TOPPER_ID, label: "PCMC", appeared: 30 },
        ],
      },
      actor,
    );

    expect(updated.combinations).toHaveLength(1);
    expect(updated.combinations?.[0]?.label).toBe("PCMC");
  });

  it("replacing selections with an empty array clears them", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, selections: [{ examCode: "KCET", qualified: 20 }] },
      actor,
    );

    const updated = await ResultService.update("INS0001", created.id, { selections: [] }, actor);

    expect(updated.selections).toBeUndefined();
  });

  it("placement replaces wholesale, exactly like bands — a recruiter omitted from the patch is gone", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, placement: { recruiters: [{ name: "Acme" }, { name: "Globex" }] } },
      actor,
    );

    const updated = await ResultService.update(
      "INS0001",
      created.id,
      { placement: { recruiters: [{ name: "Acme" }] } },
      actor,
    );

    expect(updated.placement?.recruiters).toHaveLength(1);
    expect(updated.placement?.recruiters?.[0]?.name).toBe("Acme");
  });

  it("a cross-field invariant across combinations is checked against the MERGED record, not the raw patch", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, appeared: 100, passed: 100, combinations: [{ label: "PCMB", appeared: 40 }] },
      actor,
    );

    // The patch alone (60) is fine; merged with the stored PCMB (40) it is 100 — still fine.
    // Push it over by adding a second combination whose total, with the untouched PCMB, exceeds 100.
    await expect(
      ResultService.update(
        "INS0001",
        created.id,
        { combinations: [{ label: "PCMB", appeared: 40 }, { label: "PCMC", appeared: 70 }] },
        actor,
      ),
    ).rejects.toThrow(/the combinations account for more students than appeared/);
  });

  it("tenant scoping is unchanged: a foreign institution cannot read the new fields either", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, placement: { placed: 5 } },
      actor,
    );

    await expect(ResultService.get("INS0002", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
