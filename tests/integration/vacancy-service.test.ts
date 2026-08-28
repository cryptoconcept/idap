import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Vacancy, Activity } from "@/models";
import { VACANCY_MAX_RECORDS } from "@/lib/constants";
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
    // Same swallowed-error reasoning as above: a row written against the
    // wrong entity is invisible at runtime, so `entityId` must be pinned
    // too, not just `institutionId`/`entityType`/`action`. All three rows
    // describe the same vacancy across its lifecycle.
    expect(activityRows.every((row) => String(row.entityId) === created.id)).toBe(true);
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

describe("Vacancy model: listing block", () => {
  it("stores a listing block and returns it on the DTO", async () => {
    const v = await Vacancy.create({
      institutionId: "INS0001", title: "Maths Teacher", subject: "Mathematics",
      description: "Teach maths", status: "OPEN",
      listing: {
        jobId: "job-1", externalJobId: String(new Types.ObjectId()),
        contract: "AGGREGATED", lastPushedAt: new Date(), claimState: "unclaimed",
      },
    });
    const found = await Vacancy.findById(v._id).lean();
    expect(found?.listing?.jobId).toBe("job-1");
    expect(found?.listing?.contract).toBe("AGGREGATED");
    // eduFleet's own vocabulary, and the default that matters: a listing is
    // live until a close says otherwise.
    expect(found?.listing?.remoteStatus).toBe("active");
  });

  it("MUTATION-DISTINGUISHING: rejects a listing with no externalJobId", async () => {
    // The id eduFleet dedupes on is stored, never derived: it is the vacancy
    // id only until the first republish. A listing that omits it would send a
    // later reader back to deriving it, and the derived value would address
    // the previous, closed advert.
    await expect(
      Vacancy.create({
        institutionId: "INS0001", title: "T", subject: "Mathematics", description: "d",
        listing: { jobId: "j", contract: "AGGREGATED", lastPushedAt: new Date() },
      }),
    ).rejects.toThrow(/externalJobId/);
  });

  it("rejects a remote status outside eduFleet's own enum", async () => {
    await expect(
      Vacancy.create({
        institutionId: "INS0001", title: "T", subject: "Mathematics", description: "d",
        listing: {
          jobId: "j", externalJobId: "x", contract: "AGGREGATED",
          lastPushedAt: new Date(), remoteStatus: "paused",
        },
      }),
    ).rejects.toThrow(/remoteStatus/);
  });

  it("MUTATION-DISTINGUISHING: rejects a listing contract outside the enum", async () => {
    await expect(
      Vacancy.create({
        institutionId: "INS0001", title: "T", subject: "Mathematics", description: "d",
        listing: { jobId: "j", externalJobId: "x", contract: "NOT_A_CONTRACT", lastPushedAt: new Date() },
      }),
    ).rejects.toThrow(/contract/);
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

  // Symmetric with `salaryMin`'s and `experienceRequired`'s zero cases: `0`
  // is a legitimate salaryMax, and a `??`/truthiness bug would silently drop
  // this update rather than storing it.
  it("present replaces the stored salaryMax, including with a legitimate zero", async () => {
    const created = await seed();

    const updated = await VacancyService.update("INS0001", created.id, { salaryMax: 0 }, actor);

    expect(updated.salaryMax).toBe(0);

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.salaryMax).toBe(0);
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

describe("VacancyService salary-order validation on update", () => {
  it("rejects a patch that raises salaryMin above an already-stored salaryMax", async () => {
    const created = await VacancyService.create(
      "INS0001",
      { title: "Teacher", subject: "Mathematics", description: "Grades 6-10", salaryMax: 40000 },
      actor,
    );

    // The load-bearing assertion: `vacancyPatchSchema`'s `salaryOrder` refine
    // only sees this ONE payload ({ salaryMin: 90000 }) and has no way to
    // know a lower `salaryMax` is already stored — only the service, which
    // can read the stored document, can catch this.
    await expect(
      VacancyService.update("INS0001", created.id, { salaryMin: 90000 }, actor),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "salary: the minimum may not exceed the maximum",
    });

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.salaryMin).toBeUndefined();
  });

  // The load-bearing zero: `0` is a legitimate `salaryMax`, and a `!= null`
  // -> truthiness regression (`if (effectiveMin && effectiveMax && ...)`)
  // would treat a stored `0` as absent and silently accept this patch
  // instead of rejecting it — exactly the hazard `serialize` already guards
  // against, now on the comparison side, and unreached by every other test
  // in this block (none of them put a `0` on either side of the merge).
  it("rejects a patch that raises salaryMin above a stored salaryMax of zero", async () => {
    const created = await VacancyService.create(
      "INS0001",
      { title: "Teacher", subject: "Mathematics", description: "Grades 6-10", salaryMax: 0 },
      actor,
    );

    await expect(
      VacancyService.update("INS0001", created.id, { salaryMin: 100 }, actor),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "salary: the minimum may not exceed the maximum",
    });

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.salaryMin).toBeUndefined();
  });

  it("accepts a patch that sets both bounds in the same call, correctly ordered", async () => {
    const created = await VacancyService.create(
      "INS0001",
      { title: "Teacher", subject: "Mathematics", description: "Grades 6-10" },
      actor,
    );

    const updated = await VacancyService.update(
      "INS0001",
      created.id,
      { salaryMin: 90000, salaryMax: 120000 },
      actor,
    );

    expect(updated.salaryMin).toBe(90000);
    expect(updated.salaryMax).toBe(120000);
  });

  it("accepts raising salaryMin above the stored salaryMax when that same patch clears salaryMax", async () => {
    const created = await VacancyService.create(
      "INS0001",
      { title: "Teacher", subject: "Mathematics", description: "Grades 6-10", salaryMax: 40000 },
      actor,
    );

    const updated = await VacancyService.update(
      "INS0001",
      created.id,
      { salaryMin: 90000, salaryMax: null },
      actor,
    );

    expect(updated.salaryMin).toBe(90000);
    expect(updated.salaryMax).toBeUndefined();
  });

  it("accepts clearing salaryMax alone on a record whose stored salaryMin is already high", async () => {
    const created = await VacancyService.create(
      "INS0001",
      {
        title: "Teacher",
        subject: "Mathematics",
        description: "Grades 6-10",
        salaryMin: 90000,
        salaryMax: 150000,
      },
      actor,
    );

    const updated = await VacancyService.update(
      "INS0001",
      created.id,
      { salaryMax: null },
      actor,
    );

    expect(updated.salaryMin).toBe(90000);
    expect(updated.salaryMax).toBeUndefined();
  });

  // Isolation for the pre-read this check adds: `update`'s salary-order
  // check reads the stored record before the real write does, and that read
  // is its own `{ _id, institutionId }` filter, separate from the ones
  // already covered in the tenant-isolation block below. If it were not
  // scoped by `institutionId`, a cross-tenant call whose id belongs to a
  // DIFFERENT institution would read that institution's real salaryMax,
  // find an (leaked) order violation, and throw VALIDATION_ERROR instead of
  // NOT_FOUND — leaking the shape of a record the caller has no access to.
  it("a cross-tenant update against a foreign vacancy 404s rather than leaking a validation error from its stored salary", async () => {
    const foreign = await Vacancy.create({
      institutionId: "INS0002",
      title: "INS0002 original",
      subject: "Clerk",
      description: "Original",
      salaryMax: 10000,
    });
    const before = await Vacancy.findById(foreign._id).lean();

    await expect(
      VacancyService.update("INS0001", String(foreign._id), { salaryMin: 90000 }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Vacancy.findById(foreign._id).lean();
    expect(after).toEqual(before);
  });
});

describe("VacancyService update: previously-untested allow-listed fields", () => {
  // `subject` and `facilities` were in `PATCHABLE_FIELDS` from the start but
  // no test ever patched either — dropping one from the set would have been
  // a silent no-op with a green suite. These pin both against the raw
  // stored document.
  it("patches subject", async () => {
    const created = await VacancyService.create(
      "INS0001",
      { title: "Teacher", subject: "Mathematics", description: "Grades 6-10" },
      actor,
    );

    const updated = await VacancyService.update(
      "INS0001",
      created.id,
      { subject: "Physics" },
      actor,
    );
    expect(updated.subject).toBe("Physics");

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.subject).toBe("Physics");
  });

  it("patches facilities", async () => {
    const created = await VacancyService.create(
      "INS0001",
      {
        title: "Teacher",
        subject: "Mathematics",
        description: "Grades 6-10",
        facilities: ["Paid leave"],
      },
      actor,
    );

    const updated = await VacancyService.update(
      "INS0001",
      created.id,
      { facilities: ["Health insurance", "Gratuity"] },
      actor,
    );
    expect(updated.facilities).toEqual(["Health insurance", "Gratuity"]);

    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.facilities).toEqual(["Health insurance", "Gratuity"]);
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

  // Create-side counterpart of the patch test above. Since `vacancyCreateSchema`
  // gained `.strict()` (src/lib/validation/vacancy.ts), a route-level create
  // carrying `institutionId` in the body now 400s before it ever reaches
  // `VacancyService.create` — see tests/integration/vacancy-routes.test.ts's
  // "rejects a create body naming another institution". That means the
  // service's own defense-in-depth (`{ ...input, institutionId }` in
  // `create`, re-assigning AFTER the spread) is no longer exercised by any
  // route-level test. This proves it directly, the same way the patch test
  // above bypasses `VacancyPatchInput`'s type to reach the service straight.
  it("ignores an institutionId key smuggled into create input even if a caller-built input carries it", async () => {
    const smuggledInput = {
      title: "Own vacancy",
      subject: "Clerk",
      description: "Front office",
      institutionId: "INS0002",
    } as unknown as VacancyCreateInput;

    const created = await VacancyService.create("INS0001", smuggledInput, actor);

    expect(created.id).toBeDefined();
    const raw = await Vacancy.findById(created.id).lean();
    expect(raw?.institutionId).toBe("INS0001");
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

describe("VacancyService per-institution record cap", () => {
  /**
   * Seeds `count` vacancies straight through the model, bypassing `create`.
   * Deliberate for the read tests below — the whole point of `list`'s
   * `.limit()` is to protect a collection that is already over the cap,
   * which `create` by definition refuses to produce.
   */
  async function seed(institutionId: string, count: number) {
    await Vacancy.insertMany(
      Array.from({ length: count }, (_, i) => ({
        institutionId,
        title: `Vacancy ${String(i).padStart(4, "0")}`,
        subject: "Clerk",
        description: "Front office",
      })),
    );
  }

  it("refuses the record past the cap and stores nothing", async () => {
    await seed("INS0001", VACANCY_MAX_RECORDS);

    await expect(
      VacancyService.create(
        "INS0001",
        { title: "One too many", subject: "Clerk", description: "Front office" },
        actor,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: `You can keep up to ${VACANCY_MAX_RECORDS} vacancies. Delete one to add another.`,
    });

    expect(await Vacancy.countDocuments({ institutionId: "INS0001" })).toBe(VACANCY_MAX_RECORDS);
  });

  it("still accepts the record that lands exactly on the cap", async () => {
    await seed("INS0001", VACANCY_MAX_RECORDS - 1);

    const created = await VacancyService.create(
      "INS0001",
      { title: "The last one", subject: "Clerk", description: "Front office" },
      actor,
    );

    expect(created.id).toBeDefined();
    expect(await Vacancy.countDocuments({ institutionId: "INS0001" })).toBe(VACANCY_MAX_RECORDS);
  });

  // MUTATION-DISTINGUISHING: drop `institutionId` from the count and this is
  // the one that fails — a full school next door must not consume this
  // school's allowance.
  it("counts only the caller's own records", async () => {
    await seed("INS0002", VACANCY_MAX_RECORDS);

    const created = await VacancyService.create(
      "INS0001",
      { title: "First of its own", subject: "Clerk", description: "Front office" },
      actor,
    );

    expect(created.title).toBe("First of its own");
    expect(await Vacancy.countDocuments({ institutionId: "INS0002" })).toBe(VACANCY_MAX_RECORDS);
  });

  // MUTATION-DISTINGUISHING: remove `.limit()` from `list` and this fails —
  // a collection that is already over the cap must not come back whole.
  it("caps what `list` returns even when the collection is already over the cap", async () => {
    await seed("INS0001", VACANCY_MAX_RECORDS + 5);

    const rows = await VacancyService.list("INS0001");

    expect(rows).toHaveLength(VACANCY_MAX_RECORDS);
  });
});
