import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Alumnus, Activity } from "@/models";
import { ALUMNI_MAX_RECORDS } from "@/lib/constants";
import { AlumniService } from "@/services/alumni.service";
import type { AlumnusCreateInput, AlumnusPatchInput } from "@/lib/validation/showcase";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(async () => {
  await startTestDatabase("alumni-service");
  await Alumnus.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("AlumniService round trip", () => {
  it("creates, lists, updates and removes an alumnus", async () => {
    const created = await AlumniService.create(
      "INS0001",
      {
        name: "Asha Rao",
        batch: "2012-2015",
        category: "ENGINEER",
        currentRole: "Software Engineer",
        org: "Acme Corp",
        note: "Class topper",
      },
      actor,
    );

    expect(created.id).toBeDefined();
    expect(created.name).toBe("Asha Rao");
    // Free text, not a parsed/normalised range: must survive unchanged.
    expect(created.batch).toBe("2012-2015");
    expect(created.category).toBe("ENGINEER");
    expect(created.currentRole).toBe("Software Engineer");
    expect(created.org).toBe("Acme Corp");
    expect(created.note).toBe("Class topper");
    expect(created.status).toBe("ACTIVE");

    const listed = await AlumniService.list("INS0001");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
    expect(listed[0]?.batch).toBe("2012-2015");

    const updated = await AlumniService.update(
      "INS0001",
      created.id,
      { currentRole: "Senior Software Engineer" },
      actor,
    );
    expect(updated.currentRole).toBe("Senior Software Engineer");
    // Untouched fields survive an unrelated patch.
    expect(updated.name).toBe("Asha Rao");
    expect(updated.org).toBe("Acme Corp");
    expect(updated.batch).toBe("2012-2015");

    await AlumniService.remove("INS0001", created.id, actor);
    const afterRemoval = await AlumniService.list("INS0001");
    expect(afterRemoval).toHaveLength(0);

    // `ActivityService.record` swallows every error (activity.service.ts —
    // a bad institutionId, a wrong entityType, or a call that never happened
    // is invisible at runtime), so this is the only check standing between a
    // broken audit trail and nobody noticing.
    const activityRows = await Activity.find({ institutionId: "INS0001", entityType: "ALUMNUS" })
      .sort({ createdAt: 1 })
      .lean();
    expect(activityRows.map((row) => row.action)).toEqual([
      "Alumnus created",
      "Alumnus updated",
      "Alumnus deleted",
    ]);
    expect(activityRows.every((row) => row.institutionId === "INS0001")).toBe(true);
  });

  it("defaults status to ACTIVE when not supplied", async () => {
    const created = await AlumniService.create(
      "INS0001",
      { name: "Minimal Alum", category: "OTHER" },
      actor,
    );

    // Asserted against the raw stored document, not the DTO: `serialize`
    // applies its own `row.status ?? "ACTIVE"` fallback, so checking
    // `created.status` would pass even if the model's own default were
    // removed — this must exercise the model, not the serialiser.
    const raw = await Alumnus.findById(created.id).lean();
    expect(raw?.status).toBe("ACTIVE");
  });

  it("lists sorted by batch descending then name ascending", async () => {
    await AlumniService.create("INS0001", { name: "Zara", batch: "2015", category: "OTHER" }, actor);
    await AlumniService.create("INS0001", { name: "Amit", batch: "2015", category: "OTHER" }, actor);
    await AlumniService.create("INS0001", { name: "Meera", batch: "2010", category: "OTHER" }, actor);

    const rows = await AlumniService.list("INS0001");

    expect(rows.map((row) => row.name)).toEqual(["Amit", "Zara", "Meera"]);
  });

  it("sorts batch as a raw string, descending, with no-batch alumni last — not a chronological guarantee", async () => {
    // `batch` is free text (Alumnus.ts), so `.sort({ batch: -1, ... })` is a
    // lexicographic string sort, not a calendar one. "2015" lands before
    // "2009" here only because '1' > '0' at the second character — which
    // happens to agree with chronological order for these two values, but a
    // range like "2012-2015" would sort on its leading characters and would
    // NOT reliably land where its start year implies. This test pins the
    // actual (string, missing-sorts-last) behaviour the code has today, not
    // a claim that the ordering is calendar-correct.
    const withNoBatch = await AlumniService.create(
      "INS0001",
      { name: "No Batch Alum", category: "OTHER" },
      actor,
    );
    // Confirms the fixture is genuinely field-absent, not an empty string —
    // the two sort differently.
    const raw = await Alumnus.findById(withNoBatch.id).lean();
    expect(raw).not.toHaveProperty("batch");

    await AlumniService.create(
      "INS0001",
      { name: "2015 Alum", batch: "2015", category: "OTHER" },
      actor,
    );
    await AlumniService.create(
      "INS0001",
      { name: "2009 Alum", batch: "2009", category: "OTHER" },
      actor,
    );

    const rows = await AlumniService.list("INS0001");

    expect(rows.map((row) => row.name)).toEqual(["2015 Alum", "2009 Alum", "No Batch Alum"]);
  });

  it("rejects an unknown category before any write", async () => {
    const badInput = { name: "Bad", category: "NOT_A_REAL_CATEGORY" } as unknown as AlumnusCreateInput;

    // Pinned to the model's own enum rejection, not any error: `create`
    // deliberately does not re-parse (the service does not parse — routes
    // do), so if a route ever reached this without `.parse()` first, a
    // change in *which* layer rejects should be visible here rather than
    // silently absorbed by a bare `.toThrow()`.
    await expect(AlumniService.create("INS0001", badInput, actor)).rejects.toThrow(/category/i);

    expect(await Alumnus.countDocuments({})).toBe(0);
  });

  it("rejects a malformed alumnus id as NOT_FOUND rather than a cast error", async () => {
    await expect(
      AlumniService.update("INS0001", "not-an-object-id", { name: "X" }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      AlumniService.remove("INS0001", "not-an-object-id", actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("AlumniService three-state patch: batch", () => {
  async function seed() {
    return AlumniService.create(
      "INS0001",
      { name: "Debate Champ", batch: "2012-2015", category: "OTHER" },
      actor,
    );
  }

  it("absent leaves the stored batch alone", async () => {
    const created = await seed();

    const updated = await AlumniService.update("INS0001", created.id, { name: "Renamed" }, actor);

    expect(updated.batch).toBe("2012-2015");
  });

  it("present replaces the stored batch", async () => {
    const created = await seed();

    const updated = await AlumniService.update("INS0001", created.id, { batch: "2016-2019" }, actor);

    expect(updated.batch).toBe("2016-2019");
  });

  it("explicit null clears the stored batch entirely, not to a literal null", async () => {
    const created = await seed();

    const updated = await AlumniService.update("INS0001", created.id, { batch: null }, actor);

    expect(updated.batch).toBeUndefined();

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("batch");
  });
});

describe("AlumniService three-state patch: currentRole", () => {
  async function seed() {
    return AlumniService.create(
      "INS0001",
      { name: "Debate Champ", category: "OTHER", currentRole: "Analyst" },
      actor,
    );
  }

  it("absent leaves the stored currentRole alone", async () => {
    const created = await seed();

    const updated = await AlumniService.update("INS0001", created.id, { name: "Renamed" }, actor);

    expect(updated.currentRole).toBe("Analyst");
  });

  it("present replaces the stored currentRole", async () => {
    const created = await seed();

    const updated = await AlumniService.update(
      "INS0001",
      created.id,
      { currentRole: "Director" },
      actor,
    );

    expect(updated.currentRole).toBe("Director");
  });

  it("explicit null clears the stored currentRole entirely, not to a literal null", async () => {
    const created = await seed();

    const updated = await AlumniService.update("INS0001", created.id, { currentRole: null }, actor);

    expect(updated.currentRole).toBeUndefined();

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("currentRole");
  });
});

describe("AlumniService three-state patch: org", () => {
  async function seed() {
    return AlumniService.create(
      "INS0001",
      { name: "Debate Champ", category: "OTHER", org: "Old Org" },
      actor,
    );
  }

  it("absent leaves the stored org alone", async () => {
    const created = await seed();

    const updated = await AlumniService.update("INS0001", created.id, { name: "Renamed" }, actor);

    expect(updated.org).toBe("Old Org");
  });

  it("present replaces the stored org", async () => {
    const created = await seed();

    const updated = await AlumniService.update("INS0001", created.id, { org: "New Org" }, actor);

    expect(updated.org).toBe("New Org");
  });

  it("explicit null clears the stored org entirely, not to a literal null", async () => {
    const created = await seed();

    const updated = await AlumniService.update("INS0001", created.id, { org: null }, actor);

    expect(updated.org).toBeUndefined();

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("org");
  });
});

describe("AlumniService three-state patch: note", () => {
  async function seed() {
    return AlumniService.create(
      "INS0001",
      { name: "Debate Champ", category: "OTHER", note: "Original note" },
      actor,
    );
  }

  it("absent leaves the stored note alone", async () => {
    const created = await seed();

    const updated = await AlumniService.update("INS0001", created.id, { name: "Renamed" }, actor);

    expect(updated.note).toBe("Original note");
  });

  it("present replaces the stored note", async () => {
    const created = await seed();

    const updated = await AlumniService.update("INS0001", created.id, { note: "Revised note" }, actor);

    expect(updated.note).toBe("Revised note");
  });

  it("explicit null clears the stored note entirely, not to a literal null", async () => {
    const created = await seed();

    const updated = await AlumniService.update("INS0001", created.id, { note: null }, actor);

    expect(updated.note).toBeUndefined();

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw).not.toHaveProperty("note");
  });
});

describe("AlumniService buildAlumnusUpdate: explicit undefined key", () => {
  // Every "absent" case above omits the key entirely from the patch object
  // literal (e.g. `{ name: "Renamed" }`), so `Object.entries` never even
  // produces an entry for the untouched field — `buildAlumnusUpdate`'s
  // `if (value === undefined) continue` line is never reached by those
  // tests. This test passes the key explicitly with value `undefined`
  // (`{ note: undefined }`), alongside a real change to another field so the
  // call takes the main `findOneAndUpdate` branch rather than the read-only
  // empty-patch branch, so the `continue` line is the thing standing between
  // "left alone" and "stored as literal undefined".
  it("an explicit undefined value alongside a real change is skipped, not written", async () => {
    const created = await AlumniService.create(
      "INS0001",
      { name: "Debate Champ", category: "OTHER", note: "Original note" },
      actor,
    );

    const updated = await AlumniService.update(
      "INS0001",
      created.id,
      { name: "Debate Champ Renamed", note: undefined },
      actor,
    );

    expect(updated.name).toBe("Debate Champ Renamed");
    expect(updated.note).toBe("Original note");

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw?.note).toBe("Original note");
  });
});

describe("AlumniService tenant isolation (mutation-checked)", () => {
  it("list: INS0002's alumnus never appears in INS0001's list, and INS0002's row is untouched", async () => {
    await Alumnus.create({ institutionId: "INS0001", name: "INS0001 own", category: "OTHER" });
    const foreign = await Alumnus.create({
      institutionId: "INS0002",
      name: "INS0002 own",
      category: "OTHER",
    });
    const before = await Alumnus.findById(foreign._id).lean();

    const rows = await AlumniService.list("INS0001");

    // The load-bearing assertion: with `institutionId` removed from `list`'s
    // filter, this would come back with length 2 and include "INS0002 own".
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.name)).not.toContain("INS0002 own");

    const after = await Alumnus.findById(foreign._id).lean();
    expect(after).toEqual(before);
  });

  it("create: a new row is tagged to the creating institution, and the other institution's existing row is untouched", async () => {
    // Creates for INS0002 (not INS0001, the id every other test in this file
    // defaults to) so a hardcoded-institutionId bug would be caught here too,
    // not just a dropped one.
    const other = await Alumnus.create({
      institutionId: "INS0001",
      name: "INS0001 original",
      category: "OTHER",
    });
    const before = await Alumnus.findById(other._id).lean();

    const created = await AlumniService.create(
      "INS0002",
      { name: "INS0002 new", category: "OTHER" },
      actor,
    );

    const after = await Alumnus.findById(other._id).lean();
    expect(after).toEqual(before);

    // The load-bearing assertion: with `institutionId` dropped from the
    // create payload, the stored row would not carry "INS0002" at all.
    const raw = await Alumnus.findById(created.id).lean();
    expect(raw?.institutionId).toBe("INS0002");
  });

  it("update: an INS0001-scoped update addressed by INS0002's id throws NOT_FOUND and leaves INS0002's row untouched", async () => {
    const foreign = await Alumnus.create({
      institutionId: "INS0002",
      name: "INS0002 original",
      category: "OTHER",
      note: "untouched",
    });
    const before = await Alumnus.findById(foreign._id).lean();

    // The load-bearing assertion: with `institutionId` removed from
    // `update`'s filter, this call would silently match INS0002's row (the
    // only row with this _id) and resolve instead of rejecting.
    await expect(
      AlumniService.update("INS0001", String(foreign._id), { name: "Hacked" }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Alumnus.findById(foreign._id).lean();
    expect(after).toEqual(before);
  });

  it("update (empty patch): the read-only branch is still institution-scoped, and is a genuine no-op for the owning institution", async () => {
    const foreign = await Alumnus.create({
      institutionId: "INS0002",
      name: "INS0002 original",
      category: "OTHER",
    });
    const before = await Alumnus.findById(foreign._id).lean();

    // A patch with no settable keys (`{}`, or every key explicitly
    // `undefined`) takes a SEPARATE code path — a plain `findOne` — that the
    // primary `findOneAndUpdate` mutation check above never exercises. The
    // load-bearing assertion: with `institutionId` removed from THAT
    // filter, this call would silently read back INS0002's row in full
    // instead of 404ing.
    await expect(
      AlumniService.update("INS0001", String(foreign._id), {}, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Alumnus.findById(foreign._id).lean();
    expect(after).toEqual(before);

    // Same branch, correctly scoped: an empty patch against the caller's
    // own record is a read-only no-op, not an error and not a write (the
    // returned DTO matches what `create` returned, including `updatedAt`).
    const own = await AlumniService.create(
      "INS0001",
      { name: "Own alumnus", category: "OTHER" },
      actor,
    );
    const read = await AlumniService.update("INS0001", own.id, {}, actor);
    expect(read).toEqual(own);
  });

  it("update: an allow-list keeps institutionId out of $set even if a caller-built patch smuggles it in", async () => {
    const created = await AlumniService.create(
      "INS0001",
      { name: "Own alumnus", category: "OTHER" },
      actor,
    );

    // Bypasses `AlumnusPatchInput`'s type on purpose — this proves the
    // service-level allow-list in `buildAlumnusUpdate`, not the route's
    // `alumnusPatchSchema.parse()`, which would already strip an unknown
    // key like `institutionId` before the service ever saw it.
    const smuggledPatch = {
      name: "Renamed",
      institutionId: "INS0002",
    } as unknown as AlumnusPatchInput;

    await AlumniService.update("INS0001", created.id, smuggledPatch, actor);

    const raw = await Alumnus.findById(created.id).lean();
    expect(raw?.institutionId).toBe("INS0001");
    expect(raw?.name).toBe("Renamed");
  });

  it("remove: an INS0001-scoped remove addressed by INS0002's id throws NOT_FOUND and leaves INS0002's row intact", async () => {
    const foreign = await Alumnus.create({
      institutionId: "INS0002",
      name: "INS0002 original",
      category: "OTHER",
    });
    const before = await Alumnus.findById(foreign._id).lean();

    // The load-bearing assertion: with `institutionId` removed from
    // `remove`'s filter, this call would delete INS0002's row and resolve
    // instead of rejecting.
    await expect(
      AlumniService.remove("INS0001", String(foreign._id), actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Alumnus.findById(foreign._id).lean();
    expect(after).toEqual(before);
  });
});

describe("AlumniService per-institution record cap", () => {
  /**
   * Seeds `count` alumni straight through the model, bypassing `create`.
   * Deliberate for the read tests below — the whole point of the `.limit()`
   * is to protect a collection that is already over the cap, which `create`
   * by definition refuses to produce.
   */
  async function seed(institutionId: string, count: number, status = "ACTIVE") {
    await Alumnus.insertMany(
      Array.from({ length: count }, (_, i) => ({
        institutionId,
        name: `Alumnus ${String(i).padStart(4, "0")}`,
        category: "OTHER",
        status,
      })),
    );
  }

  it("refuses the record past the cap and stores nothing", async () => {
    await seed("INS0001", ALUMNI_MAX_RECORDS);

    await expect(
      AlumniService.create("INS0001", { name: "One too many", category: "OTHER" }, actor),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(await Alumnus.countDocuments({ institutionId: "INS0001" })).toBe(ALUMNI_MAX_RECORDS);
  });

  it("still accepts the record that lands exactly on the cap", async () => {
    await seed("INS0001", ALUMNI_MAX_RECORDS - 1);

    const created = await AlumniService.create(
      "INS0001",
      { name: "The last one", category: "OTHER" },
      actor,
    );

    expect(created.id).toBeDefined();
    expect(await Alumnus.countDocuments({ institutionId: "INS0001" })).toBe(ALUMNI_MAX_RECORDS);
  });

  // MUTATION-DISTINGUISHING: drop `institutionId` from the count and this is
  // the one that fails — a full school next door must not consume this
  // school's allowance.
  it("counts only the caller's own records", async () => {
    await seed("INS0002", ALUMNI_MAX_RECORDS);

    const created = await AlumniService.create(
      "INS0001",
      { name: "First of its own", category: "OTHER" },
      actor,
    );

    expect(created.name).toBe("First of its own");
    expect(await Alumnus.countDocuments({ institutionId: "INS0002" })).toBe(ALUMNI_MAX_RECORDS);
  });

  // MUTATION-DISTINGUISHING: remove `.limit()` from `list` and this fails —
  // a collection that is already over the cap must not come back whole.
  it("caps what `list` returns even when the collection is already over the cap", async () => {
    await seed("INS0001", ALUMNI_MAX_RECORDS + 5);

    const rows = await AlumniService.list("INS0001");

    expect(rows).toHaveLength(ALUMNI_MAX_RECORDS);
  });

  // MUTATION-DISTINGUISHING: remove `.limit()` from `listPublic` and this
  // fails. This is the path that feeds the unauthenticated public profile.
  it("caps what `listPublic` returns even when the collection is already over the cap", async () => {
    await seed("INS0001", ALUMNI_MAX_RECORDS + 5);
    // HIDDEN rows are filtered at the database, so they must not eat into the
    // limit — the public list should still be full of ACTIVE ones.
    await seed("INS0001", 5, "HIDDEN");

    const rows = await AlumniService.listPublic("INS0001");

    expect(rows).toHaveLength(ALUMNI_MAX_RECORDS);
    expect(rows.every((row) => row.status === "ACTIVE")).toBe(true);
  });
});
