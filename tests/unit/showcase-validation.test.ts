import { describe, expect, it } from "vitest";
import {
  achievementCreateSchema,
  achievementPatchSchema,
  alumnusCreateSchema,
  alumnusPatchSchema,
} from "@/lib/validation/showcase";
import {
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_LEVELS,
  ALUMNI_CATEGORIES,
  MEDIA_MAX_PDF_BYTES,
  SHOWCASE_MAX_IMAGE_BYTES,
  SHOWCASE_MAX_PDF_BYTES,
} from "@/lib/constants";
import { MAX_IMAGE_BYTES } from "@/lib/media/image";

describe("enum parity with PassPercent", () => {
  // Transcribed (not read at runtime — passpercent is a sibling checkout
  // absent on CI) from
  // /Users/automicai/Documents/GitHub/passpercent/backend/src/models/Achievement.js
  // ACHIEVEMENT_CATEGORIES / ACHIEVEMENT_LEVELS, in that file's exact source
  // order, as of the date this test was written.
  const PASSPERCENT_ACHIEVEMENT_CATEGORIES = [
    "academic", "sports", "cultural", "olympiad", "science_fair", "robotics", "community_service",
  ];
  const PASSPERCENT_ACHIEVEMENT_LEVELS = [
    "school", "taluk", "district", "state", "national", "international",
  ];

  // Transcribed from
  // /Users/automicai/Documents/GitHub/passpercent/backend/src/models/NotableAlumni.js
  // ALUMNI_CATEGORIES, in source order.
  const PASSPERCENT_ALUMNI_CATEGORIES = [
    "doctor", "engineer", "entrepreneur", "civil_services", "scientist", "artist", "sports", "other",
  ];

  it("ACHIEVEMENT_CATEGORIES matches PassPercent's list one-for-one when uppercased", () => {
    expect(ACHIEVEMENT_CATEGORIES.map((c) => c.toLowerCase())).toEqual(
      PASSPERCENT_ACHIEVEMENT_CATEGORIES,
    );
    expect(PASSPERCENT_ACHIEVEMENT_CATEGORIES.map((c) => c.toUpperCase())).toEqual([
      ...ACHIEVEMENT_CATEGORIES,
    ]);
  });

  it("ACHIEVEMENT_LEVELS matches PassPercent's list one-for-one when uppercased", () => {
    expect(ACHIEVEMENT_LEVELS.map((l) => l.toLowerCase())).toEqual(PASSPERCENT_ACHIEVEMENT_LEVELS);
    expect(PASSPERCENT_ACHIEVEMENT_LEVELS.map((l) => l.toUpperCase())).toEqual([
      ...ACHIEVEMENT_LEVELS,
    ]);
  });

  it("ALUMNI_CATEGORIES matches PassPercent's list one-for-one when uppercased", () => {
    expect(ALUMNI_CATEGORIES.map((c) => c.toLowerCase())).toEqual(PASSPERCENT_ALUMNI_CATEGORIES);
    expect(PASSPERCENT_ALUMNI_CATEGORIES.map((c) => c.toUpperCase())).toEqual([
      ...ALUMNI_CATEGORIES,
    ]);
  });
});

describe("achievementCreateSchema", () => {
  it("requires category", () => {
    expect(() => achievementCreateSchema.parse({ title: "State Chess Champion" })).toThrow();
  });

  it("requires title", () => {
    expect(() => achievementCreateSchema.parse({ category: "ACADEMIC" })).toThrow();
  });

  it("accepts a minimal valid achievement", () => {
    const parsed = achievementCreateSchema.parse({
      category: "ACADEMIC",
      title: "State Chess Champion",
    });
    expect(parsed.category).toBe("ACADEMIC");
    expect(parsed.title).toBe("State Chess Champion");
  });

  it("rejects a title over 120 characters", () => {
    expect(() =>
      achievementCreateSchema.parse({ category: "ACADEMIC", title: "a".repeat(121) }),
    ).toThrow();
  });

  it("accepts a title at the 120-character limit", () => {
    const parsed = achievementCreateSchema.parse({
      category: "ACADEMIC",
      title: "a".repeat(120),
    });
    expect(parsed.title).toHaveLength(120);
  });

  it("rejects a description over 2000 characters", () => {
    expect(() =>
      achievementCreateSchema.parse({
        category: "ACADEMIC",
        title: "State Chess Champion",
        description: "a".repeat(2001),
      }),
    ).toThrow();
  });

  it("accepts a description at the 2000-character limit", () => {
    const parsed = achievementCreateSchema.parse({
      category: "ACADEMIC",
      title: "State Chess Champion",
      description: "a".repeat(2000),
    });
    expect(parsed.description).toHaveLength(2000);
  });

  it("rejects an unknown category", () => {
    expect(() =>
      achievementCreateSchema.parse({ category: "MUSIC", title: "State Chess Champion" }),
    ).toThrow();
  });
});

describe("achievementPatchSchema", () => {
  it("makes every field optional", () => {
    const parsed = achievementPatchSchema.parse({});
    expect(parsed).toEqual({});
  });

  it("accepts a patch touching a single field", () => {
    const parsed = achievementPatchSchema.parse({ title: "Updated Title" });
    expect(parsed.title).toBe("Updated Title");
  });

  it("distinguishes an explicit null description (clear) from an absent one (leave alone)", () => {
    const cleared = achievementPatchSchema.parse({ description: null });
    expect(cleared.description).toBeNull();

    const untouched = achievementPatchSchema.parse({ title: "Renamed only" });
    expect(untouched.description).toBeUndefined();
    expect("description" in untouched).toBe(false);
  });

  it("distinguishes an explicit null eventDate (clear) from an absent one (leave alone)", () => {
    const cleared = achievementPatchSchema.parse({ eventDate: null });
    expect(cleared.eventDate).toBeNull();

    const untouched = achievementPatchSchema.parse({ title: "Renamed only" });
    expect(untouched.eventDate).toBeUndefined();
    expect("eventDate" in untouched).toBe(false);
  });

  it("rejects an explicit null level — the model defaults level to SCHOOL, so there is no 'no level' state to clear back to", () => {
    expect(() => achievementPatchSchema.parse({ level: null })).toThrow();
  });

  it("accepts a level patch that changes it, leaving it absent when untouched", () => {
    const changed = achievementPatchSchema.parse({ level: "STATE" });
    expect(changed.level).toBe("STATE");

    const untouched = achievementPatchSchema.parse({ title: "Renamed only" });
    expect(untouched.level).toBeUndefined();
    expect("level" in untouched).toBe(false);
  });
});

describe("alumnusCreateSchema", () => {
  it("requires name", () => {
    expect(() => alumnusCreateSchema.parse({ category: "DOCTOR" })).toThrow();
  });

  it("requires category", () => {
    expect(() => alumnusCreateSchema.parse({ name: "Dr. Asha Rao" })).toThrow();
  });

  it("accepts a minimal valid alumnus", () => {
    const parsed = alumnusCreateSchema.parse({ name: "Dr. Asha Rao", category: "DOCTOR" });
    expect(parsed.name).toBe("Dr. Asha Rao");
    expect(parsed.category).toBe("DOCTOR");
  });

  it("accepts a single graduation year as batch", () => {
    const parsed = alumnusCreateSchema.parse({
      name: "Dr. Asha Rao",
      category: "DOCTOR",
      batch: "2015",
    });
    expect(parsed.batch).toBe("2015");
  });

  it("accepts a batch range as batch", () => {
    const parsed = alumnusCreateSchema.parse({
      name: "Dr. Asha Rao",
      category: "DOCTOR",
      batch: "2012-2015",
    });
    expect(parsed.batch).toBe("2012-2015");
  });

  it("rejects a name over 100 characters", () => {
    expect(() =>
      alumnusCreateSchema.parse({ name: "a".repeat(101), category: "DOCTOR" }),
    ).toThrow();
  });

  it("accepts a name at the 100-character limit", () => {
    const parsed = alumnusCreateSchema.parse({ name: "a".repeat(100), category: "DOCTOR" });
    expect(parsed.name).toHaveLength(100);
  });

  it("rejects an unknown category", () => {
    expect(() =>
      alumnusCreateSchema.parse({ name: "Dr. Asha Rao", category: "ASTRONAUT" }),
    ).toThrow();
  });
});

describe("alumnusPatchSchema", () => {
  it("makes every field optional", () => {
    const parsed = alumnusPatchSchema.parse({});
    expect(parsed).toEqual({});
  });

  it("accepts a patch touching a single field", () => {
    const parsed = alumnusPatchSchema.parse({ currentRole: "Chief Surgeon" });
    expect(parsed.currentRole).toBe("Chief Surgeon");
  });

  it("distinguishes an explicit null org (clear) from an absent one (leave alone)", () => {
    const cleared = alumnusPatchSchema.parse({ org: null });
    expect(cleared.org).toBeNull();

    const untouched = alumnusPatchSchema.parse({ currentRole: "Renamed only" });
    expect(untouched.org).toBeUndefined();
    expect("org" in untouched).toBe(false);
  });
});

/**
 * The showcase upload guards do not implement their own size checks — they
 * reuse the media phase's. `AchievementService.addPhoto` and
 * `AlumniService.setPhoto` call `validateImage`, which enforces
 * `MAX_IMAGE_BYTES`; `addCertificate` reuses `addMediaDocument`'s inline
 * `%PDF-` + size check. A second, showcase-owned size check would be
 * duplicated validation — worse than a duplicated constant, and exactly how
 * the two limits would drift apart in behaviour as well as in name.
 *
 * So the showcase constants are pinned to the media ones they actually
 * enforce. They agree today; nothing else keeps them in step. Without these
 * assertions, changing one would silently enforce a limit different from the
 * one the showcase constant advertises. With them, a divergence fails loudly
 * here instead of taking effect.
 */
describe("showcase byte caps pin the media constants they actually enforce", () => {
  it("SHOWCASE_MAX_IMAGE_BYTES is the limit validateImage enforces", () => {
    expect(SHOWCASE_MAX_IMAGE_BYTES).toBe(MAX_IMAGE_BYTES);
  });

  it("SHOWCASE_MAX_PDF_BYTES is the limit the media document guard enforces", () => {
    expect(SHOWCASE_MAX_PDF_BYTES).toBe(MEDIA_MAX_PDF_BYTES);
  });
});
