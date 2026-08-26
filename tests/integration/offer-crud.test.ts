import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeProfiledInstitution } from "../helpers/factories";
import { AcademicUnit, Offer } from "@/models";
import { AcademicStructureService, type AcademicUnitDTO } from "@/services/academic-structure.service";
import { OfferService } from "@/services/offer.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

let unit: AcademicUnitDTO;
let foreignUnit: AcademicUnitDTO;

beforeAll(async () => {
  await startTestDatabase("offer-crud");
  await Offer.syncIndexes();
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

describe("OfferService", () => {
  it("creates an institution-wide offer and reads it back", async () => {
    const created = await OfferService.create(
      "INS0001",
      { title: "Early Bird Offer", kind: "PERCENTAGE", value: 10, code: "EARLY10" },
      actor,
    );

    expect(created.id).toBeDefined();
    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();
    expect(created.classOrCourse).toBeUndefined();

    const read = await OfferService.get("INS0001", created.id);
    expect(read.title).toBe("Early Bird Offer");
  });

  it("derives classOrCourse live from the academic unit", async () => {
    const created = await OfferService.create(
      "INS0001",
      { title: "Science Offer", kind: "PERCENTAGE", value: 15, academicUnitId: unit.id },
      actor,
    );

    expect(created.classOrCourse).toBe("Grade 10");

    await AcademicStructureService.update("INS0001", unit.id, { name: "Class 10" }, actor);

    const read = await OfferService.get("INS0001", created.id);
    expect(read.classOrCourse).toBe("Class 10");
  });

  it("clears an existing scope back to institution-wide when academicUnitId is explicitly null", async () => {
    const created = await OfferService.create(
      "INS0001",
      { title: "Scoped Offer", kind: "PERCENTAGE", value: 10, academicUnitId: unit.id },
      actor,
    );
    expect(created.classOrCourse).toBe("Grade 10");

    const cleared = await OfferService.update(
      "INS0001",
      created.id,
      { academicUnitId: null },
      actor,
    );

    expect(cleared.academicUnitId).toBeUndefined();
    expect(cleared.classOrCourse).toBeUndefined();
  });

  it("leaves an existing scope intact when a patch omits academicUnitId entirely — null clears, absent preserves", async () => {
    const created = await OfferService.create(
      "INS0001",
      { title: "Scoped Offer", kind: "PERCENTAGE", value: 10, academicUnitId: unit.id },
      actor,
    );

    const patched = await OfferService.update("INS0001", created.id, { value: 20 }, actor);

    expect(patched.value).toBe(20);
    expect(patched.academicUnitId).toBe(unit.id);
    expect(patched.classOrCourse).toBe("Grade 10");
  });

  it("clears a previously-set end date when validUntil is explicitly null", async () => {
    const created = await OfferService.create(
      "INS0001",
      {
        title: "Time-Limited Offer",
        kind: "FLAT",
        value: 1000,
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      actor,
    );
    expect(created.validUntil).toBeDefined();

    const cleared = await OfferService.update(
      "INS0001",
      created.id,
      { validUntil: null },
      actor,
    );

    expect(cleared.validUntil).toBeUndefined();
  });

  it("leaves an existing end date intact when a patch omits validUntil entirely — null clears, absent preserves", async () => {
    const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const created = await OfferService.create(
      "INS0001",
      { title: "Time-Limited Offer", kind: "FLAT", value: 1000, validUntil },
      actor,
    );

    const patched = await OfferService.update("INS0001", created.id, { value: 2000 }, actor);

    expect(patched.value).toBe(2000);
    expect(patched.validUntil).toBe(validUntil.toISOString());
  });

  it("refuses another institution's academic unit as NOT_FOUND", async () => {
    await expect(
      OfferService.create(
        "INS0001",
        { title: "Offer", kind: "PERCENTAGE", value: 10, academicUnitId: foreignUnit.id },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists only the calling institution's offers", async () => {
    await OfferService.create("INS0001", { title: "Mine", kind: "FLAT", value: 1000 }, actor);
    await OfferService.create("INS0002", { title: "Theirs", kind: "FLAT", value: 1000 }, actor);

    const list = await OfferService.list("INS0001");

    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("Mine");
  });

  it("treats another institution's offer as NOT_FOUND, never FORBIDDEN", async () => {
    const theirs = await OfferService.create(
      "INS0002",
      { title: "Theirs", kind: "FLAT", value: 1000 },
      actor,
    );

    await expect(OfferService.get("INS0001", theirs.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects a malformed id as NOT_FOUND rather than a cast error", async () => {
    await expect(OfferService.get("INS0001", "not-an-object-id")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses a create with a percentage value over 100", async () => {
    await expect(
      OfferService.create(
        "INS0001",
        { title: "Too Much", kind: "PERCENTAGE", value: 101 },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("refuses a create where validUntil precedes validFrom", async () => {
    await expect(
      OfferService.create(
        "INS0001",
        {
          title: "Backwards",
          kind: "FLAT",
          value: 1000,
          validFrom: new Date(Date.now()),
          validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("publishes, stamps publishedAt, and keeps it across a republish", async () => {
    const created = await OfferService.create(
      "INS0001",
      { title: "Merit Offer", kind: "FLAT", value: 5000 },
      actor,
    );

    const published = await OfferService.setStatus("INS0001", created.id, "publish", actor);
    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).toBeDefined();

    await OfferService.setStatus("INS0001", created.id, "unpublish", actor);
    const republished = await OfferService.setStatus("INS0001", created.id, "publish", actor);

    expect(republished.publishedAt).toBe(published.publishedAt);
  });

  it("refuses to publish an offer whose value is 0", async () => {
    const created = await OfferService.create(
      "INS0001",
      { title: "Zero Value", kind: "FLAT", value: 0 },
      actor,
    );

    await expect(
      OfferService.setStatus("INS0001", created.id, "publish", actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("refuses to patch a PUBLISHED offer's value down to 0", async () => {
    // value: 0 is a valid payload under the create/update schema
    // (z.number().min(0)), so only the PUBLISHED branch of `update`'s publish
    // gate — assertOfferPublishable, not assertOfferInvariants — stops a
    // live discount from being patched down to nothing while staying public.
    const created = await OfferService.create(
      "INS0001",
      { title: "Half Off", kind: "PERCENTAGE", value: 50 },
      actor,
    );
    await OfferService.setStatus("INS0001", created.id, "publish", actor);

    await expect(
      OfferService.update("INS0001", created.id, { value: 0 }, actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("allows patching a DRAFT offer's value down to 0 — a draft may be incomplete", async () => {
    // Proves the value: 0 gate is status-dependent, not a blanket rule on
    // `update`: a DRAFT offer is not required to be publishable yet.
    const created = await OfferService.create(
      "INS0001",
      { title: "Half Off", kind: "PERCENTAGE", value: 50 },
      actor,
    );

    const patched = await OfferService.update("INS0001", created.id, { value: 0 }, actor);

    expect(patched.value).toBe(0);
    expect(patched.status).toBe("DRAFT");
  });

  it("refuses to create beyond the per-institution cap", async () => {
    for (let i = 0; i < 40; i += 1) {
      await OfferService.create(
        "INS0001",
        { title: `Offer ${i}`, kind: "FLAT", value: 1000 },
        actor,
      );
    }

    await expect(
      OfferService.create("INS0001", { title: "One too many", kind: "FLAT", value: 1000 }, actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("deletes an offer", async () => {
    const created = await OfferService.create(
      "INS0001",
      { title: "Merit Offer", kind: "FLAT", value: 5000 },
      actor,
    );
    await OfferService.remove("INS0001", created.id, actor);

    await expect(OfferService.get("INS0001", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("listPublic includes an offer whose validUntil is in the future", async () => {
    await makeProfiledInstitution("INS0003", { profileStatus: "PUBLISHED" });
    const created = await OfferService.create(
      "INS0003",
      {
        title: "Future",
        kind: "PERCENTAGE",
        value: 10,
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      actor,
    );
    await OfferService.setStatus("INS0003", created.id, "publish", actor);

    const list = await OfferService.listPublic({ institutionId: "INS0003" });

    expect(list).toHaveLength(1);
    expect(list?.[0]?.title).toBe("Future");
  });

  it("listPublic drops an expired offer while the dashboard list keeps it", async () => {
    await makeProfiledInstitution("INS0003", { profileStatus: "PUBLISHED" });
    const created = await OfferService.create(
      "INS0003",
      { title: "Expired", kind: "PERCENTAGE", value: 10 },
      actor,
    );
    await OfferService.setStatus("INS0003", created.id, "publish", actor);
    // Set the past date directly: creating with it would be refused only if a
    // validFrom were also present, but writing it here keeps the test honest
    // about what it is exercising — the READ filter, not the write rules.
    await Offer.updateOne(
      { _id: created.id },
      { $set: { validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    );

    expect(await OfferService.listPublic({ institutionId: "INS0003" })).toHaveLength(0);
    // The institution still needs to see and re-date it.
    expect(await OfferService.list("INS0003")).toHaveLength(1);
  });

  it("listPublic includes an offer with no validUntil at all", async () => {
    await makeProfiledInstitution("INS0003", { profileStatus: "PUBLISHED" });
    const created = await OfferService.create(
      "INS0003",
      { title: "Evergreen", kind: "FLAT", value: 5000 },
      actor,
    );
    await OfferService.setStatus("INS0003", created.id, "publish", actor);

    const list = await OfferService.listPublic({ institutionId: "INS0003" });

    expect(list).toHaveLength(1);
  });

  it("listPublic includes an offer whose validUntil was cleared to null — it never expires now", async () => {
    await makeProfiledInstitution("INS0003", { profileStatus: "PUBLISHED" });
    const created = await OfferService.create(
      "INS0003",
      {
        title: "Formerly Time-Limited",
        kind: "FLAT",
        value: 5000,
        // Expired already — if the clear didn't take, listPublic's filter
        // would exclude this row, and this test would fail for the wrong
        // reason instead of proving the clear itself.
        validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
      actor,
    );
    await OfferService.setStatus("INS0003", created.id, "publish", actor);

    await OfferService.update("INS0003", created.id, { validUntil: null }, actor);

    const list = await OfferService.listPublic({ institutionId: "INS0003" });

    expect(list).toHaveLength(1);
    expect(list?.[0]?.title).toBe("Formerly Time-Limited");
  });
});
