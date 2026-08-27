import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Achievement, Activity } from "@/models";
import { AchievementService } from "@/services/achievement.service";
import type { AchievementCreateInput, AchievementPatchInput } from "@/lib/validation/showcase";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(async () => {
  await startTestDatabase("achievement-service");
  await Achievement.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("AchievementService round trip", () => {
  it("creates, lists, updates and removes an achievement", async () => {
    const created = await AchievementService.create(
      "INS0001",
      {
        category: "ACADEMIC",
        title: "Science Olympiad Gold",
        description: "Won gold at the state science olympiad",
        eventDate: new Date("2026-01-15"),
        level: "STATE",
        students: [{ name: "Asha Rao", grade: "10" }],
      },
      actor,
    );

    expect(created.id).toBeDefined();
    expect(created.category).toBe("ACADEMIC");
    expect(created.title).toBe("Science Olympiad Gold");
    expect(created.description).toBe("Won gold at the state science olympiad");
    expect(created.level).toBe("STATE");
    expect(created.status).toBe("ACTIVE");
    expect(created.students).toEqual([{ name: "Asha Rao", grade: "10" }]);

    const listed = await AchievementService.list("INS0001");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const updated = await AchievementService.update(
      "INS0001",
      created.id,
      { title: "Science Olympiad Gold Medal", eventDate: undefined },
      actor,
    );
    expect(updated.title).toBe("Science Olympiad Gold Medal");
    // Untouched fields survive an unrelated patch.
    expect(updated.description).toBe("Won gold at the state science olympiad");
    expect(updated.level).toBe("STATE");

    await AchievementService.remove("INS0001", created.id, actor);
    const afterRemoval = await AchievementService.list("INS0001");
    expect(afterRemoval).toHaveLength(0);

    // `ActivityService.record` swallows every error (activity.service.ts —
    // a bad institutionId, a wrong entityType, or a call that never happened
    // is invisible at runtime), so this is the only check standing between a
    // broken audit trail and nobody noticing.
    const activityRows = await Activity.find({ institutionId: "INS0001", entityType: "ACHIEVEMENT" })
      .sort({ createdAt: 1 })
      .lean();
    expect(activityRows.map((row) => row.action)).toEqual([
      "Achievement created",
      "Achievement updated",
      "Achievement deleted",
    ]);
    expect(activityRows.every((row) => row.institutionId === "INS0001")).toBe(true);
  });

  it("defaults level to SCHOOL and status to ACTIVE when not supplied", async () => {
    const created = await AchievementService.create(
      "INS0001",
      { category: "SPORTS", title: "Inter-school relay", eventDate: undefined },
      actor,
    );

    // Asserted against the raw stored document, not the DTO: `serialize`
    // applies its own `row.level ?? "SCHOOL"` / `row.status ?? "ACTIVE"`
    // fallback, so checking `created.level`/`created.status` would pass even
    // if the model's own default were removed — this must exercise the
    // model, not the serialiser.
    const raw = await Achievement.findById(created.id).lean();
    expect(raw?.level).toBe("SCHOOL");
    expect(raw?.status).toBe("ACTIVE");
  });

  it("returns achievements newest first", async () => {
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    await Achievement.create({
      institutionId: "INS0001",
      category: "SPORTS",
      title: "Older win",
      createdAt: older,
    });
    await Achievement.create({
      institutionId: "INS0001",
      category: "ACADEMIC",
      title: "Newer win",
      createdAt: newer,
    });

    const rows = await AchievementService.list("INS0001");

    expect(rows.map((row) => row.title)).toEqual(["Newer win", "Older win"]);
  });

  it("rejects an unknown category before any write", async () => {
    const badInput = { category: "NOT_A_REAL_CATEGORY", title: "Bad" } as unknown as AchievementCreateInput;

    // Pinned to the model's own enum rejection, not any error: `create`
    // deliberately does not re-parse (see the comment at achievement.service.ts),
    // so if a route ever reached this without `.parse()` first, a change in
    // *which* layer rejects (e.g. surfacing as some unrelated 500) should be
    // visible here rather than silently absorbed by a bare `.toThrow()`.
    await expect(AchievementService.create("INS0001", badInput, actor)).rejects.toThrow(/category/i);

    expect(await Achievement.countDocuments({})).toBe(0);
  });

  it("rejects a malformed achievement id as NOT_FOUND rather than a cast error", async () => {
    await expect(
      AchievementService.update(
        "INS0001",
        "not-an-object-id",
        { title: "X", eventDate: undefined },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      AchievementService.remove("INS0001", "not-an-object-id", actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("AchievementService three-state patch: description", () => {
  async function seed() {
    return AchievementService.create(
      "INS0001",
      {
        category: "ACADEMIC",
        title: "Debate Championship",
        description: "Original description",
        eventDate: undefined,
      },
      actor,
    );
  }

  it("absent leaves the stored description alone", async () => {
    const created = await seed();

    const updated = await AchievementService.update(
      "INS0001",
      created.id,
      { title: "Debate Championship Renamed", eventDate: undefined },
      actor,
    );

    expect(updated.description).toBe("Original description");
  });

  it("present replaces the stored description", async () => {
    const created = await seed();

    const updated = await AchievementService.update(
      "INS0001",
      created.id,
      { description: "Revised description", eventDate: undefined },
      actor,
    );

    expect(updated.description).toBe("Revised description");
  });

  it("explicit null clears the stored description entirely, not to a literal null", async () => {
    const created = await seed();

    const updated = await AchievementService.update(
      "INS0001",
      created.id,
      { description: null, eventDate: undefined },
      actor,
    );

    expect(updated.description).toBeUndefined();

    const raw = await Achievement.findById(created.id).lean();
    expect(raw).not.toHaveProperty("description");
  });
});

describe("AchievementService three-state patch: eventDate", () => {
  async function seed() {
    return AchievementService.create(
      "INS0001",
      { category: "ACADEMIC", title: "Debate Championship", eventDate: new Date("2026-02-01") },
      actor,
    );
  }

  it("absent leaves the stored eventDate alone", async () => {
    const created = await seed();

    const updated = await AchievementService.update(
      "INS0001",
      created.id,
      { title: "Debate Championship Renamed", eventDate: undefined },
      actor,
    );

    expect(updated.eventDate).toBe(new Date("2026-02-01").toISOString());
  });

  it("present replaces the stored eventDate", async () => {
    const created = await seed();

    const updated = await AchievementService.update(
      "INS0001",
      created.id,
      { eventDate: new Date("2026-03-10") },
      actor,
    );

    expect(updated.eventDate).toBe(new Date("2026-03-10").toISOString());
  });

  it("explicit null clears the stored eventDate entirely, not to a literal null", async () => {
    const created = await seed();

    const updated = await AchievementService.update(
      "INS0001",
      created.id,
      { eventDate: null },
      actor,
    );

    expect(updated.eventDate).toBeUndefined();

    const raw = await Achievement.findById(created.id).lean();
    expect(raw).not.toHaveProperty("eventDate");
  });
});

describe("AchievementService tenant isolation (mutation-checked)", () => {
  it("list: INS0002's achievement never appears in INS0001's list, and INS0002's row is untouched", async () => {
    await Achievement.create({ institutionId: "INS0001", category: "ACADEMIC", title: "INS0001 own" });
    const foreign = await Achievement.create({
      institutionId: "INS0002",
      category: "SPORTS",
      title: "INS0002 own",
    });
    const before = await Achievement.findById(foreign._id).lean();

    const rows = await AchievementService.list("INS0001");

    // The load-bearing assertion: with `institutionId` removed from `list`'s
    // filter, this would come back with length 2 and include "INS0002 own".
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.title)).not.toContain("INS0002 own");

    const after = await Achievement.findById(foreign._id).lean();
    expect(after).toEqual(before);
  });

  it("create: a new row is tagged to the creating institution, and the other institution's existing row is untouched", async () => {
    // Creates for INS0002 (not INS0001, the id every other test in this file
    // defaults to) so a hardcoded-institutionId bug would be caught here too,
    // not just a dropped one.
    const other = await Achievement.create({
      institutionId: "INS0001",
      category: "SPORTS",
      title: "INS0001 original",
    });
    const before = await Achievement.findById(other._id).lean();

    const created = await AchievementService.create(
      "INS0002",
      { category: "ACADEMIC", title: "INS0002 new", eventDate: undefined },
      actor,
    );

    const after = await Achievement.findById(other._id).lean();
    expect(after).toEqual(before);

    // The load-bearing assertion: with `institutionId` dropped from the
    // create payload, the stored row would not carry "INS0002" at all.
    const raw = await Achievement.findById(created.id).lean();
    expect(raw?.institutionId).toBe("INS0002");
  });

  it("update: an INS0001-scoped update addressed by INS0002's id throws NOT_FOUND and leaves INS0002's row untouched", async () => {
    const foreign = await Achievement.create({
      institutionId: "INS0002",
      category: "SPORTS",
      title: "INS0002 original",
      description: "untouched",
    });
    const before = await Achievement.findById(foreign._id).lean();

    // The load-bearing assertion: with `institutionId` removed from
    // `update`'s filter, this call would silently match INS0002's row (the
    // only row with this _id) and resolve instead of rejecting.
    await expect(
      AchievementService.update(
        "INS0001",
        String(foreign._id),
        { title: "Hacked", eventDate: undefined },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Achievement.findById(foreign._id).lean();
    expect(after).toEqual(before);
  });

  it("update (empty patch): the read-only branch is still institution-scoped, and is a genuine no-op for the owning institution", async () => {
    const foreign = await Achievement.create({
      institutionId: "INS0002",
      category: "SPORTS",
      title: "INS0002 original",
    });
    const before = await Achievement.findById(foreign._id).lean();

    // A patch with no settable keys (`{}`, or every key explicitly
    // `undefined`) takes a SEPARATE code path — a plain `findOne` — that the
    // primary `findOneAndUpdate` mutation check below never exercises. The
    // load-bearing assertion: with `institutionId` removed from THAT
    // filter, this call would silently read back INS0002's row in full
    // instead of 404ing.
    await expect(
      AchievementService.update("INS0001", String(foreign._id), { eventDate: undefined }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Achievement.findById(foreign._id).lean();
    expect(after).toEqual(before);

    // Same branch, correctly scoped: an empty patch against the caller's
    // own record is a read-only no-op, not an error and not a write (the
    // returned DTO matches what `create` returned, including `updatedAt`).
    const own = await AchievementService.create(
      "INS0001",
      { category: "ACADEMIC", title: "Own achievement", eventDate: undefined },
      actor,
    );
    const read = await AchievementService.update("INS0001", own.id, { eventDate: undefined }, actor);
    expect(read).toEqual(own);
  });

  it("update: an allow-list keeps institutionId out of $set even if a caller-built patch smuggles it in", async () => {
    const created = await AchievementService.create(
      "INS0001",
      { category: "ACADEMIC", title: "Own achievement", eventDate: undefined },
      actor,
    );

    // Bypasses `AchievementPatchInput`'s type on purpose — this proves the
    // service-level allow-list in `buildAchievementUpdate`, not the route's
    // `achievementPatchSchema.parse()`, which would already strip an unknown
    // key like `institutionId` before the service ever saw it.
    const smuggledPatch = {
      title: "Renamed",
      institutionId: "INS0002",
    } as unknown as AchievementPatchInput;

    await AchievementService.update("INS0001", created.id, smuggledPatch, actor);

    const raw = await Achievement.findById(created.id).lean();
    expect(raw?.institutionId).toBe("INS0001");
    expect(raw?.title).toBe("Renamed");
  });

  it("remove: an INS0001-scoped remove addressed by INS0002's id throws NOT_FOUND and leaves INS0002's row intact", async () => {
    const foreign = await Achievement.create({
      institutionId: "INS0002",
      category: "SPORTS",
      title: "INS0002 original",
    });
    const before = await Achievement.findById(foreign._id).lean();

    // The load-bearing assertion: with `institutionId` removed from
    // `remove`'s filter, this call would delete INS0002's row and resolve
    // instead of rejecting.
    await expect(
      AchievementService.remove("INS0001", String(foreign._id), actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await Achievement.findById(foreign._id).lean();
    expect(after).toEqual(before);
  });
});
