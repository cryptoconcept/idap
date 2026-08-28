import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Vacancy, Activity } from "@/models";
import { VacancyService } from "@/services/vacancy.service";
import type { VacancyCreateInput, VacancyPatchInput } from "@/lib/validation/vacancy";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(async () => {
  await startTestDatabase("vacancy-service");
  await Vacancy.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("VacancyService round trip", () => {
  it("creates, lists, updates and removes a vacancy", async () => {
    const created = await VacancyService.create(
      "INS0001",
      {
        title: "Maths Teacher",
        subject: "Mathematics",
        description: "Teach grades 6-10",
        salaryMin: 25000,
        salaryMax: 40000,
        experienceRequired: 2,
        facilities: ["Provident Fund (PF)", "Paid leave"],
      },
      actor,
    );

    expect(created.id).toBeDefined();
    expect(created.title).toBe("Maths Teacher");
    expect(created.subject).toBe("Mathematics");
    expect(created.description).toBe("Teach grades 6-10");
    expect(created.salaryMin).toBe(25000);
    expect(created.salaryMax).toBe(40000);
    expect(created.experienceRequired).toBe(2);
    expect(created.facilities).toEqual(["Provident Fund (PF)", "Paid leave"]);
    expect(created.status).toBe("DRAFT");

    const listed = await VacancyService.list("INS0001");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const updated = await VacancyService.update(
      "INS0001",
      created.id,
      { status: "OPEN" },
      actor,
    );
    expect(updated.status).toBe("OPEN");
    // Untouched fields survive an unrelated patch.
    expect(updated.title).toBe("Maths Teacher");
    expect(updated.salaryMin).toBe(25000);

    await VacancyService.remove("INS0001", created.id, actor);
    const afterRemoval = await VacancyService.list("INS0001");
    expect(afterRemoval).toHaveLength(0);

    // `ActivityService.record` swallows every error (activity.service.ts —
    // a bad institutionId, a wrong entityType, or a call that never happened
    // is invisible at runtime), so this is the only check standing between a
    // broken audit trail and nobody noticing.
    const activityRows = await Activity.find({ institutionId: "INS0001", entityType: "VACANCY" })
      .sort({ createdAt: 1 })
      .lean();
    expect(activityRows.map((row) => row.action)).toEqual([
      "Vacancy created",
      "Vacancy updated",
      "Vacancy deleted",
    ]);
    expect(activityRows.every((row) => row.institutionId === "INS0001")).toBe(true);
  });

  it("defaults status to DRAFT when not supplied", async () => {
    const created = await VacancyService.create(
      "INS0001",
      { title: "Clerk", subject: "Clerk", description: "Front office" },
      actor,
    );

    // Asserted against the raw stored document, not the DTO: `serialize`
    // applies its own `row.status ?? "DRAFT"` fallback, so checking
    // `created.status` would pass even if the model's own default were
    // removed — this must exercise the model, not the serialiser.
    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.status).toBe("DRAFT");
  });

  it("returns vacancies newest first", async () => {
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    await Vacancy.create({
      institutionId: "INS0001",
      title: "Older posting",
      subject: "Clerk",
      description: "Old",
      createdAt: older,
    });
    await Vacancy.create({
      institutionId: "INS0001",
      title: "Newer posting",
      subject: "Clerk",
      description: "New",
      createdAt: newer,
    });

    const rows = await VacancyService.list("INS0001");

    expect(rows.map((row) => row.title)).toEqual(["Newer posting", "Older posting"]);
  });

  it("rejects an unknown subject before any write", async () => {
    const badInput = {
      title: "Bad",
      subject: "NOT_A_REAL_SUBJECT",
      description: "Bad",
    } as unknown as VacancyCreateInput;

    // Pinned to the model's own enum rejection, not any error: `create`
    // deliberately does not re-parse (the service does not parse — routes
    // do), so if a route ever reached this without `.parse()` first, a
    // change in *which* layer rejects should be visible here rather than
    // silently absorbed by a bare `.toThrow()`.
    await expect(VacancyService.create("INS0001", badInput, actor)).rejects.toThrow(/subject/i);

    expect(await Vacancy.countDocuments({})).toBe(0);
  });

  it("rejects a malformed vacancy id as NOT_FOUND rather than a cast error", async () => {
    await expect(
      VacancyService.update("INS0001", "not-an-object-id", { title: "X" }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      VacancyService.remove("INS0001", "not-an-object-id", actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("VacancyService three-state patch: salaryMin", () => {
  async function seed() {
    return VacancyService.create(
      "INS0001",
      { title: "Science Teacher", subject: "Physics", description: "Grades 9-10", salaryMin: 20000 },
      actor,
    );
  }

  it("absent leaves the stored salaryMin alone", async () => {
    const created = await seed();

    const updated = await VacancyService.update("INS0001", created.id, { title: "Renamed" }, actor);

    expect(updated.salaryMin).toBe(20000);
  });

  // Deliberately 0, not a nonzero value: `0` is a legitimate salaryMin, and a
  // `??`/truthiness bug (`patch.salaryMin ?? 0` treating absence as zero, or
  // `if (patch.salaryMin)` treating zero as absence) would silently drop this
  // update — this is the case that catches it.
  it("present replaces the stored salaryMin, including with a legitimate zero", async () => {
    const created = await seed();

    const updated = await VacancyService.update("INS0001", created.id, { salaryMin: 0 }, actor);

    expect(updated.salaryMin).toBe(0);

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.salaryMin).toBe(0);
  });

  it("explicit null clears the stored salaryMin entirely, not to a literal null", async () => {
    const created = await seed();

    const updated = await VacancyService.update("INS0001", created.id, { salaryMin: null }, actor);

    expect(updated.salaryMin).toBeUndefined();

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw).not.toHaveProperty("salaryMin");
  });
});

describe("VacancyService three-state patch: salaryMax", () => {
  async function seed() {
    return VacancyService.create(
      "INS0001",
      { title: "Science Teacher", subject: "Physics", description: "Grades 9-10", salaryMax: 40000 },
      actor,
    );
  }

  it("absent leaves the stored salaryMax alone", async () => {
    const created = await seed();

    const updated = await VacancyService.update("INS0001", created.id, { title: "Renamed" }, actor);

    expect(updated.salaryMax).toBe(40000);
  });

  it("present replaces the stored salaryMax", async () => {
    const created = await seed();

    const updated = await VacancyService.update("INS0001", created.id, { salaryMax: 55000 }, actor);

    expect(updated.salaryMax).toBe(55000);
  });

  it("explicit null clears the stored salaryMax entirely, not to a literal null", async () => {
    const created = await seed();

    const updated = await VacancyService.update("INS0001", created.id, { salaryMax: null }, actor);

    expect(updated.salaryMax).toBeUndefined();

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw).not.toHaveProperty("salaryMax");
  });
});

describe("VacancyService three-state patch: experienceRequired", () => {
  async function seed() {
    return VacancyService.create(
      "INS0001",
      {
        title: "Science Teacher",
        subject: "Physics",
        description: "Grades 9-10",
        experienceRequired: 3,
      },
      actor,
    );
  }

  it("absent leaves the stored experienceRequired alone", async () => {
    const created = await seed();

    const updated = await VacancyService.update("INS0001", created.id, { title: "Renamed" }, actor);

    expect(updated.experienceRequired).toBe(3);
  });

  it("present replaces the stored experienceRequired, including with a legitimate zero", async () => {
    const created = await seed();

    const updated = await VacancyService.update(
      "INS0001",
      created.id,
      { experienceRequired: 0 },
      actor,
    );

    expect(updated.experienceRequired).toBe(0);

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.experienceRequired).toBe(0);
  });

  it("explicit null clears the stored experienceRequired entirely, not to a literal null", async () => {
    const created = await seed();

    const updated = await VacancyService.update(
      "INS0001",
      created.id,
      { experienceRequired: null },
      actor,
    );

    expect(updated.experienceRequired).toBeUndefined();

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw).not.toHaveProperty("experienceRequired");
  });
});

describe("VacancyService PATCHABLE_FIELDS allow-list", () => {
  it("ignores an institutionId key smuggled into a patch even if a caller-built patch carries it", async () => {
    const created = await VacancyService.create(
      "INS0001",
      { title: "Own vacancy", subject: "Clerk", description: "Front office" },
      actor,
    );

    // Bypasses `VacancyPatchInput`'s type on purpose — this proves the
    // service-level allow-list in `buildVacancyUpdate`, not the route's
    // `vacancyPatchSchema.parse()`, which would already strip an unknown key
    // like `institutionId` before the service ever saw it.
    const smuggledPatch = {
      title: "Renamed",
      institutionId: "INS0002",
    } as unknown as VacancyPatchInput;

    await VacancyService.update("INS0001", created.id, smuggledPatch, actor);

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.institutionId).toBe("INS0001");
    expect(raw?.title).toBe("Renamed");
  });
});

describe("VacancyService tenant isolation (mutation-checked)", () => {
  it("list: INS0002's vacancy never appears in INS0001's list, and INS0002's row is untouched", async () => {
    await Vacancy.create({
      institutionId: "INS0001",
      title: "INS0001 own",
      subject: "Clerk",
      description: "Own",
    });
    const foreign = await Vacancy.create({
      institutionId: "INS0002",
      title: "INS0002 own",
      subject: "Clerk",
      description: "Foreign",
    });
    const before = await Vacancy.findById(foreign._id).lean();

    const rows = await VacancyService.list("INS0001");

    // The load-bearing assertion: with `institutionId` removed from `list`'s
    // filter, this would come back with length 2 and include "INS0002 own".
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.title)).not.toContain("INS0002 own");

    const after = await Vacancy.findById(foreign._id).lean();
    expect(after).toEqual(before);
  });

  it("create: a new row is tagged to the creating institution, and the other institution's existing row is untouched", async () => {
    // Creates for INS0002 (not INS0001, the id every other test in this file
    // defaults to) so a hardcoded-institutionId bug would be caught here too,
    // not just a dropped one.
    const other = await Vacancy.create({
      institutionId: "INS0001",
      title: "INS0001 original",
      subject: "Clerk",
      description: "Original",
    });
    const before = await Vacancy.findById(other._id).lean();

    const created = await VacancyService.create(
      "INS0002",
      { title: "INS0002 new", subject: "Clerk", description: "New" },
      actor,
    );

    const after = await Vacancy.findById(other._id).lean();
    expect(after).toEqual(before);

    // The load-bearing assertion: with `institutionId` dropped from the
    // create payload, the stored row would not carry "INS0002" at all — and a
    // hardcoded-wrong-tenant bug would not either.
    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.institutionId).toBe("INS0002");
  });

  it("update: an INS0001-scoped update addressed by INS0002's id throws NOT_FOUND and leaves INS0002's row untouched", async () => {
    const foreign = await Vacancy.create({
      institutionId: "INS0002",
      title: "INS0002 original",
      subject: "Clerk",
      description: "Original",
      salaryMin: 15000,
    });
    const before = await Vacancy.findById(foreign._id).lean();

    // The load-bearing assertion: with `institutionId` removed from
    // `update`'s write filter, this call would silently match INS0002's row
    // (the only row with this _id) and resolve instead of rejecting.
    await expect(
      VacancyService.update("INS0001", String(foreign._id), { title: "Hacked" }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Vacancy.findById(foreign._id).lean();
    expect(after).toEqual(before);
  });

  it("update (empty patch): the read-only branch is still institution-scoped, and is a genuine no-op for the owning institution", async () => {
    const foreign = await Vacancy.create({
      institutionId: "INS0002",
      title: "INS0002 original",
      subject: "Clerk",
      description: "Original",
    });
    const before = await Vacancy.findById(foreign._id).lean();

    // A patch with no settable keys (`{}`, or every key explicitly
    // `undefined`) takes a SEPARATE code path — a plain `findOne` — that the
    // primary `findOneAndUpdate` mutation check above never exercises. The
    // load-bearing assertion: with `institutionId` removed from THAT filter,
    // this call would silently read back INS0002's row in full instead of
    // 404ing.
    await expect(
      VacancyService.update("INS0001", String(foreign._id), {}, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Vacancy.findById(foreign._id).lean();
    expect(after).toEqual(before);

    // Same branch, correctly scoped: an empty patch against the caller's own
    // record is a read-only no-op, not an error and not a write (the
    // returned DTO matches what `create` returned, including `updatedAt`).
    const own = await VacancyService.create(
      "INS0001",
      { title: "Own vacancy", subject: "Clerk", description: "Own" },
      actor,
    );
    const read = await VacancyService.update("INS0001", own.id, {}, actor);
    expect(read).toEqual(own);
  });

  it("remove: an INS0001-scoped remove addressed by INS0002's id throws NOT_FOUND and leaves INS0002's row intact", async () => {
    const foreign = await Vacancy.create({
      institutionId: "INS0002",
      title: "INS0002 original",
      subject: "Clerk",
      description: "Original",
    });
    const before = await Vacancy.findById(foreign._id).lean();

    // The load-bearing assertion: with `institutionId` removed from
    // `remove`'s filter, this call would delete INS0002's row and resolve
    // instead of rejecting.
    await expect(
      VacancyService.remove("INS0001", String(foreign._id), actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Vacancy.findById(foreign._id).lean();
    expect(after).toEqual(before);
  });
});
