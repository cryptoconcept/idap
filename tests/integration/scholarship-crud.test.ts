import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit, Scholarship } from "@/models";
import { AcademicStructureService, type AcademicUnitDTO } from "@/services/academic-structure.service";
import { ScholarshipService } from "@/services/scholarship.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

let unit: AcademicUnitDTO;
let foreignUnit: AcademicUnitDTO;

beforeAll(async () => {
  await startTestDatabase("scholarship-crud");
  await Scholarship.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
  await AcademicUnit.syncIndexes();
  unit = await AcademicStructureService.create(
    "INS0001",
    { segment: "SCHOOL", name: "Grade 10" },
    actor,
  );
  foreignUnit = await AcademicStructureService.create(
    "INS0002",
    { segment: "SCHOOL", name: "Grade 10" },
    actor,
  );
});

describe("ScholarshipService", () => {
  it("creates an institution-wide scholarship and reads it back", async () => {
    const created = await ScholarshipService.create(
      "INS0001",
      { name: "Merit Scholarship", criteria: "Top 10 ranks", amount: "100% tuition" },
      actor,
    );

    expect(created.id).toBeDefined();
    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();
    expect(created.classOrCourse).toBeUndefined();

    const read = await ScholarshipService.get("INS0001", created.id);
    expect(read.name).toBe("Merit Scholarship");
  });

  it("derives classOrCourse live from the academic unit", async () => {
    const created = await ScholarshipService.create(
      "INS0001",
      { name: "Science Merit", academicUnitId: unit.id },
      actor,
    );

    expect(created.classOrCourse).toBe("Grade 10");

    await AcademicStructureService.update("INS0001", unit.id, { name: "Class 10" }, actor);

    const read = await ScholarshipService.get("INS0001", created.id);
    expect(read.classOrCourse).toBe("Class 10");
  });

  it("refuses another institution's academic unit as NOT_FOUND", async () => {
    await expect(
      ScholarshipService.create(
        "INS0001",
        { name: "Merit", academicUnitId: foreignUnit.id },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists only the calling institution's scholarships", async () => {
    await ScholarshipService.create("INS0001", { name: "Mine" }, actor);
    await ScholarshipService.create("INS0002", { name: "Theirs" }, actor);

    const list = await ScholarshipService.list("INS0001");

    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("Mine");
  });

  it("treats another institution's scholarship as NOT_FOUND, never FORBIDDEN", async () => {
    const theirs = await ScholarshipService.create("INS0002", { name: "Theirs" }, actor);

    await expect(ScholarshipService.get("INS0001", theirs.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects a malformed id as NOT_FOUND rather than a cast error", async () => {
    await expect(ScholarshipService.get("INS0001", "not-an-object-id")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("updates a scholarship and can move it between units", async () => {
    const created = await ScholarshipService.create("INS0001", { name: "Merit" }, actor);

    const updated = await ScholarshipService.update(
      "INS0001",
      created.id,
      { amount: "Up to ₹50,000", academicUnitId: unit.id },
      actor,
    );

    expect(updated.amount).toBe("Up to ₹50,000");
    expect(updated.classOrCourse).toBe("Grade 10");
  });

  it("clears an existing scope back to institution-wide when academicUnitId is explicitly null", async () => {
    const created = await ScholarshipService.create(
      "INS0001",
      { name: "Scoped Merit", academicUnitId: unit.id },
      actor,
    );
    expect(created.classOrCourse).toBe("Grade 10");

    const cleared = await ScholarshipService.update(
      "INS0001",
      created.id,
      { academicUnitId: null },
      actor,
    );

    expect(cleared.academicUnitId).toBeUndefined();
    expect(cleared.classOrCourse).toBeUndefined();
  });

  it("leaves an existing scope intact when a patch omits academicUnitId entirely — null clears, absent preserves", async () => {
    const created = await ScholarshipService.create(
      "INS0001",
      { name: "Scoped Merit", academicUnitId: unit.id },
      actor,
    );

    const patched = await ScholarshipService.update(
      "INS0001",
      created.id,
      { amount: "Up to ₹20,000" },
      actor,
    );

    expect(patched.amount).toBe("Up to ₹20,000");
    expect(patched.academicUnitId).toBe(unit.id);
    expect(patched.classOrCourse).toBe("Grade 10");
  });

  it("publishes, stamps publishedAt, and keeps it across a republish", async () => {
    const created = await ScholarshipService.create("INS0001", { name: "Merit" }, actor);

    const published = await ScholarshipService.setStatus("INS0001", created.id, "publish", actor);
    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).toBeDefined();

    await ScholarshipService.setStatus("INS0001", created.id, "unpublish", actor);
    const republished = await ScholarshipService.setStatus(
      "INS0001",
      created.id,
      "publish",
      actor,
    );

    expect(republished.publishedAt).toBe(published.publishedAt);
  });

  it("fix round 1: publishes locally even with no Scholarship Hub connection — succeeds, does not throw, and writes no listing", async () => {
    // Local scholarship actions are IDAP-owned and must always succeed
    // regardless of Scholarship Hub connection/readiness — Hub syndication
    // is a best-effort side-effect only. No PlatformConnection row exists
    // for INS0001 at all here, and this bare `{ name: "Merit" }` scholarship
    // is nowhere near Hub-publishable either, so the real (unmocked)
    // `ScholarshipPublishService.publish` returns `SKIPPED` internally —
    // this asserts the OUTWARD-FACING contract: local publish still
    // succeeds, and nothing was ever written to `listing`.
    const created = await ScholarshipService.create("INS0001", { name: "Merit" }, actor);

    const published = await ScholarshipService.setStatus("INS0001", created.id, "publish", actor);

    expect(published.status).toBe("PUBLISHED");
    const stored = await Scholarship.findById(created.id).lean();
    expect(stored?.listing).toBeUndefined();
  });

  it("Task 10: DTO gap fix — surfaces structured fields and the Hub listing (blockedReason included)", async () => {
    // Carried note from the Task 10 brief: `ScholarshipDTO` used to expose
    // none of Task 3/4's structured fields and no `listing` at all, so the
    // dashboard editor and the Hub listing panel had nothing to read back.
    // This is a mutation-distinguishing check on `serialize()`, not the DB —
    // the structured fields and the listing are written directly here so a
    // regression in `serialize()`'s mapping (not in `create`/Mongoose) is
    // what would fail this.
    const created = await ScholarshipService.create(
      "INS0001",
      {
        name: "Merit",
        summary: "Merit award",
        categories: ["merit"],
        benefits: { amountMin: 1000 },
        applicationMode: "external",
        externalUrl: "https://example.org/apply",
      },
      actor,
    );
    expect(created.summary).toBe("Merit award");
    expect(created.categories).toEqual(["merit"]);
    expect(created.benefits?.amountMin).toBe(1000);
    // Also a regression test for a real Task 3 gap this task found: `externalUrl`
    // was validated by `createScholarshipSchema` and read by
    // `toHubScholarshipPayload`, but never declared on the Mongoose schema, so
    // Mongoose's default `strict: true` silently dropped it on write.
    expect(created.externalUrl).toBe("https://example.org/apply");
    const persisted = await Scholarship.findById(created.id).lean();
    expect(persisted?.externalUrl).toBe("https://example.org/apply");

    // A BLOCKED push (Task 8/9's forward contract) can be recorded with
    // `remoteStatus: "published"` and `hubId: ""` alongside a `blockedReason` —
    // the DTO must carry it through untouched so the UI can treat it as
    // authoritative over `remoteStatus` (see `listing-display.ts`).
    await Scholarship.updateOne(
      { _id: created.id },
      {
        $set: {
          listing: {
            hubId: "",
            externalRef: `IDAP:INS0001:${created.id}`,
            remoteStatus: "published",
            lastPushedAt: new Date(),
            blockedReason: "Scholarship Hub moderation hold",
          },
        },
      },
    );

    const read = await ScholarshipService.get("INS0001", created.id);
    expect(read.listing?.remoteStatus).toBe("published");
    expect(read.listing?.blockedReason).toBe("Scholarship Hub moderation hold");
    expect(read.listing?.hubId).toBe("");
  });

  it("refuses to publish a scholarship whose name was blanked by a patch", async () => {
    const created = await ScholarshipService.create("INS0001", { name: "Merit" }, actor);
    await Scholarship.updateOne({ _id: created.id }, { $set: { name: "  " } });

    await expect(
      ScholarshipService.setStatus("INS0001", created.id, "publish", actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("refuses to create beyond the per-institution cap", async () => {
    for (let i = 0; i < 40; i += 1) {
      await ScholarshipService.create("INS0001", { name: `Scholarship ${i}` }, actor);
    }

    await expect(
      ScholarshipService.create("INS0001", { name: "One too many" }, actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("deletes a scholarship", async () => {
    const created = await ScholarshipService.create("INS0001", { name: "Merit" }, actor);
    await ScholarshipService.remove("INS0001", created.id, actor);

    await expect(ScholarshipService.get("INS0001", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
