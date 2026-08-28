import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Vacancy, Activity, PlatformCredential, PlatformConnection } from "@/models";
import { VACANCY_MAX_RECORDS } from "@/lib/constants";
import { VacancyService } from "@/services/vacancy.service";
import { encryptCredential } from "@/lib/security/credentials";
import type { VacancyCreateInput, VacancyPatchInput } from "@/lib/validation/vacancy";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

// ---------------------------------------------------------------------------
// Task 5 fixtures — `remove` now closes a published listing through
// `VacancyPublishService.pushClose` before it deletes, so these tests need
// the same `fetch`-stubbing setup `vacancy-publish-service.test.ts` uses
// (see that file's header comment for why: stubbing `fetch` keeps the real
// adapter and the real URL/method construction in the path, so "no HTTP
// call" means no HTTP call, not "no adapter call").
// ---------------------------------------------------------------------------

const PLATFORM_KEY = "ef_pkey_test_platform";
const BASE_URL = "https://api.edufleet.test";
const VALID_VAULT_KEY = Buffer.alloc(32, 9).toString("base64");

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stubs `fetch` with one queued response per call, in order. */
function stubFetch(...responses: Response[]) {
  const mock = vi.fn();
  for (const response of responses) mock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function makeCredential() {
  return PlatformCredential.create({
    platform: "EDUFLEET",
    keyEncrypted: encryptCredential(PLATFORM_KEY),
    baseUrl: BASE_URL,
    active: true,
  });
}

/** A vacancy already carrying a `listing` block — the shape `remove` now has
 *  to close before it may delete. `jobId`/`externalJobId` default to values
 *  derived from the vacancy's own id, matching what a real first listing
 *  looks like. */
async function makeListedVacancy(
  institutionId: string,
  listingOverrides: Record<string, unknown> = {},
  vacancyOverrides: Record<string, unknown> = {},
) {
  const vacancy = await Vacancy.create({
    institutionId,
    title: "Mathematics Teacher",
    subject: "Mathematics",
    description: "Teach Mathematics to Grades 8-10.",
    status: "OPEN",
    ...vacancyOverrides,
  });
  const updated = await Vacancy.findByIdAndUpdate(
    vacancy._id,
    {
      $set: {
        listing: {
          jobId: `ef-job-${String(vacancy._id)}`,
          externalJobId: String(vacancy._id),
          contract: "AGGREGATED",
          lastPushedAt: new Date(),
          claimState: "unclaimed",
          remoteStatus: "active",
          ...listingOverrides,
        },
      },
    },
    { new: true, runValidators: true },
  );
  return updated!;
}

beforeAll(async () => {
  await startTestDatabase("vacancy-service");
  await Vacancy.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
  process.env.IDAP_CREDENTIAL_KEY = VALID_VAULT_KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
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

describe("VacancyService.remove closes the eduFleet listing before deleting (Task 5)", () => {
  it("closes a published listing first, then deletes the vacancy", async () => {
    await makeCredential();
    const vacancy = await makeListedVacancy("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(200, { jobId: `ef-job-${String(vacancy._id)}`, status: "closed" }),
    );

    await VacancyService.remove("INS0001", String(vacancy._id), actor);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body?: string }];
    expect(String(url)).toBe(`${BASE_URL}/api/partner/jobs/${String(vacancy._id)}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body ?? "{}")).toEqual({ status: "closed" });

    expect(await Vacancy.findById(vacancy._id).lean()).toBeNull();

    // The audit trail records both halves of what just happened, in order:
    // the close eduFleet confirmed, then the delete IDAP performed.
    const activityRows = await Activity.find({ institutionId: "INS0001", entityType: "VACANCY" })
      .sort({ createdAt: 1 })
      .lean();
    expect(activityRows.map((row) => row.action)).toEqual([
      "Vacancy closed on eduFleet",
      "Vacancy deleted",
    ]);
  });

  // MUTATION-DISTINGUISHING: `pushClose` never creates a listing, so a
  // vacancy with none should delete with no HTTP call at all. This is the
  // case that would catch `remove` reaching for the wrong method — `publish`
  // or `repush` instead of `pushClose` — because either of those WOULD
  // create a listing for an OPEN vacancy with none yet: the wrong call
  // issues an HTTP POST here, where the right one issues nothing. (A DRAFT
  // vacancy would not distinguish this: `publish` refuses a DRAFT before any
  // HTTP call either, so the mutation would go unnoticed — OPEN is
  // load-bearing.)
  it("MUTATION-DISTINGUISHING: a vacancy with no listing block deletes without any HTTP call at all", async () => {
    // A real, active credential IS present here — deliberately, unlike the
    // other tests in this block that omit one. If `remove` ever reached for
    // `publish`/`repush` instead of `pushClose`, this OPEN, fully-valid
    // vacancy (title/subject/description/city all present) would clear
    // `preflight` and actually reach `ctx.http`: the missing-credential
    // shortcut that would otherwise mask that bug is removed on purpose.
    await makeCredential();
    const vacancy = await Vacancy.create({
      institutionId: "INS0001",
      title: "Never published",
      subject: "Clerk",
      description: "Front office",
      status: "OPEN",
    });
    const fetchMock = stubFetch();

    await VacancyService.remove("INS0001", String(vacancy._id), actor);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await Vacancy.findById(vacancy._id).lean()).toBeNull();
  });

  it("refuses to delete when eduFleet blocks the close, and leaves the vacancy and its listing intact", async () => {
    await makeCredential();
    const vacancy = await makeListedVacancy("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(403, { error: "claimed", reason: "claimed" }),
      // The free list read that follows a Contract One `403 claimed`. This
      // one reports `claim_pending`, which is NOT terminal — an admin
      // rejecting the claim returns the job to `unclaimed` and the advert
      // becomes IDAP's problem again — so the delete must still be refused.
      jsonResponse(200, {
        jobs: [{ externalJobId: String(vacancy._id), claimStatus: "claim_pending" }],
      }),
    );

    await expect(
      VacancyService.remove("INS0001", String(vacancy._id), actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // The single most valuable rule this plan produced: when a guard exists
    // to prevent an action, assert the action did not happen — not merely
    // that an error came back. A 403 has already been answered by the time
    // this rejects; what matters is that the DELETE itself never landed.
    // Two HTTP calls now: the close, then the free GET that reads the true
    // claim state. Neither is a retry of the close.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const survived = await Vacancy.findById(vacancy._id).lean();
    expect(survived).not.toBeNull();
    expect(survived?.listing?.jobId).toBe(`ef-job-${String(vacancy._id)}`);
  });

  it("MUTATION-DISTINGUISHING: a revoked grant on DELETE disconnects the row and refuses in words that name the fix", async () => {
    // H3, third entry point. The refusal itself is right — a live advert with
    // no id left to close it is worse than a row that will not delete yet —
    // but before the fix wave it disconnected nothing, so the card kept
    // reading Connected over a ciphertext eduFleet had already refused, and
    // the reason repeated the adapter's description of the fault rather than
    // naming the one thing the school can do about it.
    await makeCredential();
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "EDUFLEET",
      status: "CONNECTED",
      externalRef: "INS0001",
      grantTokenEncrypted: encryptCredential("ef_pgrant_dead"),
      scopes: ["jobs:write"],
    });
    const vacancy = await makeListedVacancy("INS0001", { contract: "SCHOOL_POSTED" });
    stubFetch(jsonResponse(401, { error: "Grant revoked", reason: "revoked" }));

    const error = await VacancyService.remove("INS0001", String(vacancy._id), actor).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toMatch(/reconnect/i);
    // The action that must not happen: the row is still here, unclosed
    // advert and all.
    expect(await Vacancy.findById(vacancy._id).lean()).not.toBeNull();
    // ...and the action that must: the dead credential is gone.
    const row = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "EDUFLEET" })
      .select("+grantTokenEncrypted")
      .lean();
    expect(row?.status).toBe("DISCONNECTED");
    expect(row?.grantTokenEncrypted).toBeUndefined();
  });

  it("refuses to delete when eduFleet reports the id already belongs to another listing, and leaves the vacancy intact", async () => {
    await makeCredential();
    const vacancy = await makeListedVacancy("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(409, {
        error: "already exists",
        reason: "duplicate_external_job",
        jobId: "ef-job-elsewhere",
        contract: "platform",
      }),
    );

    await expect(
      VacancyService.remove("INS0001", String(vacancy._id), actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await Vacancy.findById(vacancy._id).lean()).not.toBeNull();
  });

  // The trap this task exists to close: a SCHOOL_POSTED listing whose school
  // has since disconnected from eduFleet is unreachable through IDAP (the
  // grant is gone), and Contract One cannot rescue it (its PATCH filters
  // `origin: "aggregated"`, and a school-posted job is not). Refusing the
  // delete here is still correct — an orphaned public advert is worse than a
  // vacancy that will not delete yet — but the refusal must name a way out,
  // or it is a trap rather than a guard.
  it("MUTATION-DISTINGUISHING: names both eduFleet Exchange routes when a disconnected school's listing cannot be closed", async () => {
    await makeCredential();
    // No PlatformConnection at all: exactly what "disconnected" looks like.
    const vacancy = await makeListedVacancy("INS0001", { contract: "SCHOOL_POSTED" });
    const fetchMock = stubFetch();

    const error = await VacancyService.remove("INS0001", String(vacancy._id), actor).catch(
      (e: unknown) => e as Error & { code?: string },
    );

    expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
    // No HTTP call: the refusal happens before eduFleet is even reached —
    // there is no grant left to authenticate a close with.
    expect(fetchMock).not.toHaveBeenCalled();
    // Route one: fix IDAP's side of the connection.
    expect(error?.message).toMatch(/reconnect/i);
    // Route two: the job belongs to the school directly on eduFleet, so they
    // are never stuck even if they never reconnect.
    expect(error?.message).toMatch(/dashboard/i);

    expect(await Vacancy.findById(vacancy._id).lean()).not.toBeNull();
  });

  it("closes a SCHOOL_POSTED listing (a reconnected school) addressed by eduFleet's own job id, not the vacancy id", async () => {
    await makeCredential();
    const vacancy = await makeListedVacancy("INS0001", {
      contract: "SCHOOL_POSTED",
      jobId: "ef-school-job-9",
    });
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "EDUFLEET",
      status: "CONNECTED",
      externalRef: "INS0001",
      grantTokenEncrypted: encryptCredential("ef_pgrant_test"),
      scopes: ["jobs:write"],
    });
    const fetchMock = stubFetch(jsonResponse(200, { jobId: "ef-school-job-9", status: "closed" }));

    await VacancyService.remove("INS0001", String(vacancy._id), actor);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(`${BASE_URL}/api/partner/school/jobs/ef-school-job-9`);
    expect(await Vacancy.findById(vacancy._id).lean()).toBeNull();
  });

  // MUTATION-DISTINGUISHING (tenant): the read `remove` performs purely to
  // learn whether a listing exists is a SEPARATE filter from the delete
  // below it — same reasoning as the update-side tenant tests above. If that
  // read's `institutionId` filter were dropped, this call would read
  // INS0002's listed vacancy under an INS0001 request and could push a close
  // to eduFleet on INS0002's behalf, before the (still correctly scoped)
  // delete below caught the mismatch and 404s. Without this test, that bug
  // would surface only as the SAME plausible NOT_FOUND the correct code
  // produces — exactly the failure mode the brief warns a later write filter
  // can mask on a dropped read filter — while a foreign vacancy had already
  // been pushed to.
  it("MUTATION-DISTINGUISHING: removing INS0002's listed vacancy under INS0001 never reaches eduFleet and leaves the row untouched", async () => {
    await makeCredential();
    const foreign = await makeListedVacancy("INS0002");
    const before = await Vacancy.findById(foreign._id).lean();
    const fetchMock = stubFetch(jsonResponse(200, { jobId: "leak", status: "closed" }));

    await expect(
      VacancyService.remove("INS0001", String(foreign._id), actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(fetchMock).not.toHaveBeenCalled();
    const after = await Vacancy.findById(foreign._id).lean();
    expect(after).toEqual(before);
  });

  // ---------------------------------------------------------------------------
  // Fix round 1 — the non-atomic window between the pre-check read and the
  // delete. Both races below use the same technique
  // `results-media.test.ts`/`fee-bulk-create.test.ts` already use: patch the
  // Mongoose query's own `exec` so a competing write is awaited to completion
  // BEFORE the real query reaches the database, reproducing the landing order
  // a genuine race would produce, deterministically rather than by timing.
  // ---------------------------------------------------------------------------

  it("MUTATION-DISTINGUISHING (race): a listing published between the pre-check and the delete leaves the vacancy undeleted and the new listing un-closed", async () => {
    await makeCredential();
    // Observed with NO listing at pre-check time.
    const vacancy = await Vacancy.create({
      institutionId: "INS0001",
      title: "Race condition teacher",
      subject: "Clerk",
      description: "Front office",
      status: "OPEN",
    });
    const fetchMock = stubFetch();
    const raceListing = {
      jobId: "ef-job-race",
      externalJobId: String(vacancy._id),
      contract: "AGGREGATED",
      lastPushedAt: new Date(),
      claimState: "unclaimed",
      remoteStatus: "active",
    };

    const originalFindOneAndDelete = Vacancy.findOneAndDelete.bind(Vacancy) as (
      filter?: Record<string, unknown>,
    ) => ReturnType<typeof Vacancy.findOneAndDelete>;
    const spy = vi.spyOn(Vacancy, "findOneAndDelete").mockImplementation(((
      filter?: Record<string, unknown>,
    ) => {
      const query = originalFindOneAndDelete(filter);
      const patched = query as unknown as { exec: (...execArgs: unknown[]) => Promise<unknown> };
      const originalExec = patched.exec.bind(patched);
      patched.exec = async (...execArgs: unknown[]) => {
        // A concurrent publish lands here — after `remove`'s pre-check read
        // observed no listing, before its conditional delete reaches Mongo.
        await Vacancy.updateOne({ _id: vacancy._id }, { $set: { listing: raceListing } });
        return originalExec(...execArgs);
      };
      return query;
    }) as typeof Vacancy.findOneAndDelete);

    try {
      await expect(
        VacancyService.remove("INS0001", String(vacancy._id), actor),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    } finally {
      spy.mockRestore();
    }

    // Not deleted...
    const survivor = await Vacancy.findById(vacancy._id).lean();
    expect(survivor).not.toBeNull();
    // ...and the listing that landed mid-flight is untouched: nobody closed
    // it (no HTTP call at all) and nobody deleted the vacancy out from under
    // a live, un-closed advert.
    expect(survivor?.listing?.jobId).toBe("ef-job-race");
    expect(survivor?.listing?.remoteStatus).toBe("active");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(race) a listing replaced by a fresh republish between closing the old one and the delete leaves the vacancy undeleted", async () => {
    await makeCredential();
    // Observed WITH a listing at pre-check time; this one gets closed.
    const vacancy = await makeListedVacancy("INS0001", { jobId: "ef-job-old" });
    const fetchMock = stubFetch(jsonResponse(200, { jobId: "ef-job-old", status: "closed" }));
    const freshListing = {
      jobId: "ef-job-fresh",
      externalJobId: `${String(vacancy._id)}-2`,
      contract: "AGGREGATED",
      lastPushedAt: new Date(),
      claimState: "unclaimed",
      remoteStatus: "active",
    };

    const originalFindOneAndDelete = Vacancy.findOneAndDelete.bind(Vacancy) as (
      filter?: Record<string, unknown>,
    ) => ReturnType<typeof Vacancy.findOneAndDelete>;
    const spy = vi.spyOn(Vacancy, "findOneAndDelete").mockImplementation(((
      filter?: Record<string, unknown>,
    ) => {
      const query = originalFindOneAndDelete(filter);
      const patched = query as unknown as { exec: (...execArgs: unknown[]) => Promise<unknown> };
      const originalExec = patched.exec.bind(patched);
      patched.exec = async (...execArgs: unknown[]) => {
        // A second, fresh publish replaces the just-closed listing wholesale
        // (exactly what `recordSuccess`'s create branch does on a republish)
        // after the close succeeded but before the delete reaches Mongo.
        await Vacancy.updateOne({ _id: vacancy._id }, { $set: { listing: freshListing } });
        return originalExec(...execArgs);
      };
      return query;
    }) as typeof Vacancy.findOneAndDelete);

    try {
      await expect(
        VacancyService.remove("INS0001", String(vacancy._id), actor),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    } finally {
      spy.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1); // the close that DID happen, against the old listing
    const survivor = await Vacancy.findById(vacancy._id).lean();
    expect(survivor).not.toBeNull();
    expect(survivor?.listing?.jobId).toBe("ef-job-fresh");
  });
});

/**
 * Fix round 1 — a claimed listing is the one exception to Task 5's
 * close-first rule.
 *
 * Task 5 refuses a delete it cannot close first, because destroying IDAP's row
 * destroys the only id that could ever take the advert down. A claim removes
 * both halves of that reasoning at once: the advert has moved onto the
 * school's own eduFleet account, where they can close it themselves, and
 * `claimed` is terminal — every `pushClose` IDAP will ever make against it is
 * a `403`. Refusing therefore protects nothing and traps the row forever.
 */
describe("VacancyService.remove and a claimed eduFleet listing (fix round 1)", () => {
  /**
   * MUTATION CHECK: remove the `if (!claimedByTheSchool)` guard around
   * `closeListingBeforeDelete` in `vacancy.service.ts` and this fails on the
   * first two assertions — the close is attempted, `stubFetch()` has no queued
   * answer, the connector reports a failure, and the delete is refused with
   * the vacancy still there. Asserting only "it deleted" would be weaker: the
   * point is that no close was even attempted, because none can ever succeed.
   */
  it("MUTATION-DISTINGUISHING: deletes a claimed listing's vacancy without attempting a close", async () => {
    await makeCredential();
    const vacancy = await makeListedVacancy("INS0001", { claimState: "claimed" });
    const fetchMock = stubFetch();

    await VacancyService.remove("INS0001", String(vacancy._id), actor);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await Vacancy.findById(vacancy._id).lean()).toBeNull();
  });

  /**
   * The delete is allowed, but it is not silent: the advert outlives the row,
   * and the audit trail has to say so. The school is told the same thing
   * before they press Delete, in the confirmation dialog.
   */
  it("records that the claimed advert was left live under the school's own account", async () => {
    await makeCredential();
    const vacancy = await makeListedVacancy("INS0001", { claimState: "claimed" });
    stubFetch();

    await VacancyService.remove("INS0001", String(vacancy._id), actor);

    const entry = await Activity.findOne({
      institutionId: "INS0001",
      entityId: vacancy._id,
      action: "Vacancy deleted",
    }).lean();
    expect(entry?.description).toMatch(/left live under the school's own eduFleet Exchange account/i);
  });

  /**
   * The exception is deliberately narrower than "a push was refused".
   * `claim_pending` reverts to `unclaimed` the moment an administrator rejects
   * the claim, so a listing in that state is still IDAP's to close and still
   * has to be closed before the row goes — otherwise a rejected claim leaves a
   * live advert with nothing left to address it.
   */
  it("still closes the listing first when the claim is only pending", async () => {
    await makeCredential();
    const vacancy = await makeListedVacancy("INS0001", { claimState: "claim_pending" });
    const fetchMock = stubFetch(jsonResponse(200, { jobId: "ef-job-pending", status: "closed" }));

    await VacancyService.remove("INS0001", String(vacancy._id), actor);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await Vacancy.findById(vacancy._id).lean()).toBeNull();
  });

  /**
   * H1. The stored `claimState` cannot lead the claim: nothing in IDAP learns
   * a school claimed its advert until a push is refused, so the FIRST delete
   * after a claim always arrives with the listing still reading `unclaimed`.
   * The close 403s, the adapter's free list read establishes the true state,
   * and this attempt has to succeed — refusing and telling the school to try
   * the same thing again is a trap with an extra step, not an exit.
   *
   * MUTATION CHECK: make `withClaimState` in `edufleet.ts` return its result
   * unchanged (skip the list read) and this fails — the outcome is BLOCKED
   * with no claim state, `closeListingBeforeDelete` refuses, and the row
   * survives. Asserting only "it rejected/resolved" would be weaker; what is
   * asserted is that the ROW IS GONE and that the claim was recorded from the
   * read rather than assumed.
   */
  it("MUTATION-DISTINGUISHING: a claim discovered BY the close deletes on this attempt, not the next one", async () => {
    await makeCredential();
    const vacancy = await makeListedVacancy("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(403, {
        error: "This listing has been claimed by the school and can no longer be edited by a partner key",
        reason: "claimed",
      }),
      jsonResponse(200, {
        jobs: [{ externalJobId: String(vacancy._id), claimStatus: "claimed", status: "active" }],
      }),
    );

    await VacancyService.remove("INS0001", String(vacancy._id), actor);

    // The close was attempted once (it had to be — that is how the claim was
    // discovered), then the free GET, and no third call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await Vacancy.findById(vacancy._id).lean()).toBeNull();
    // ...and the audit trail says the advert outlived the row, exactly as it
    // does when the claim was already known.
    const entry = await Activity.findOne({
      institutionId: "INS0001",
      entityId: vacancy._id,
      action: "Vacancy deleted",
    }).lean();
    expect(entry?.description).toMatch(/left live under the school's own eduFleet Exchange account/i);
  });

  /**
   * `withdrawn` — an admin-approved takedown — is refused by
   * `updatePartnerJob` under the same one `403 claimed` reason and is equally
   * permanent, with even less to protect: the advert is already down. Before
   * the fix wave IDAP's enum had no value for it at all, so it was recorded
   * as nothing and the row would have been trapped.
   */
  it("deletes a withdrawn listing's vacancy without attempting a close", async () => {
    await makeCredential();
    const vacancy = await makeListedVacancy("INS0001", { claimState: "withdrawn" });
    const fetchMock = stubFetch();

    await VacancyService.remove("INS0001", String(vacancy._id), actor);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await Vacancy.findById(vacancy._id).lean()).toBeNull();
  });

  /**
   * A claimed listing eduFleet has already closed still skips the close — the
   * `403` is answered on the claim, not on the status, so attempting one would
   * burn a write unit to be refused for a listing that is already down.
   */
  it("skips the close for a claimed listing that is already closed on eduFleet", async () => {
    await makeCredential();
    const vacancy = await makeListedVacancy("INS0001", {
      claimState: "claimed",
      remoteStatus: "closed",
    });
    const fetchMock = stubFetch();

    await VacancyService.remove("INS0001", String(vacancy._id), actor);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await Vacancy.findById(vacancy._id).lean()).toBeNull();
  });
});
