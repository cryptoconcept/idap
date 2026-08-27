import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Achievement, Alumnus } from "@/models";
import { GET as getById } from "@/app/api/public/[institutionId]/profile/route";
import { GET as getBySlug } from "@/app/api/public/institutions/[slug]/route";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";

/** Recursively asserts none of the forbidden keys appear anywhere in the payload. */
function assertNoForbiddenKeys(value: unknown, forbidden: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item, forbidden);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      expect(forbidden).not.toContain(key);
      assertNoForbiddenKeys(nested, forbidden);
    }
  }
}

/** `ip` lands in the header the rate limiter buckets on; omitted, every caller
 * shares the "unknown" bucket, which is fine for the non-limiter tests. */
function requestFor(url: string, ip?: string) {
  return new Request(url, { headers: ip ? { "x-forwarded-for": ip } : undefined });
}

async function callById(institutionId: string, ip?: string) {
  return getById(requestFor(`http://localhost/api/public/${institutionId}/profile`, ip), {
    params: Promise.resolve({ institutionId }),
  } as never);
}

async function callBySlug(slug: string, ip?: string) {
  return getBySlug(requestFor(`http://localhost/api/public/institutions/${slug}`, ip), {
    params: Promise.resolve({ slug }),
  } as never);
}

/** Achievements and alumni are separate collections, so they need their own
 * factories; `makeInstitution` does not reach them. Written through the models
 * directly rather than through the services, so a record can be planted with an
 * explicit `status` or `createdAt` that no service method would ever set. */
async function makeAchievement(institutionId: string, overrides: Record<string, unknown> = {}) {
  return Achievement.create({
    institutionId,
    category: "ACADEMIC",
    title: `${institutionId} achievement`,
    ...overrides,
  });
}

async function makeAlumnus(institutionId: string, overrides: Record<string, unknown> = {}) {
  return Alumnus.create({
    institutionId,
    name: `${institutionId} alumnus`,
    category: "OTHER",
    ...overrides,
  });
}

describe("public profile API", () => {
  beforeAll(async () => {
    await startTestDatabase("publicprofile");
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("returns 200 for a published institution looked up by id", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
      facilities: [{ code: "LIBRARY", label: "Library", available: true }],
    });

    const response = await callById("INS0001");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.profile.institutionName).toBe("INS0001 Institute");
    expect(body.profile.slug).toBe("sunrise-academy");
    expect(body.profile.facilities).toEqual([
      { code: "LIBRARY", label: "Library", available: true },
    ]);
  });

  it("returns the identical institution when looked up by slug, normalising case", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
    });

    // Mixed-case slug in the URL still resolves — the route lowercases before lookup.
    const response = await callBySlug("Sunrise-Academy");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.profile.institutionId).toBe("INS0001");
  });

  it("returns 404 for a draft institution, by id and by slug", async () => {
    await makeInstitution("INS0001", {
      slug: "draft-school",
      profileStatus: "DRAFT",
    });

    const byId = await callById("INS0001");
    expect(byId.status).toBe(404);

    const bySlug = await callBySlug("draft-school");
    expect(bySlug.status).toBe(404);
  });

  it("returns 404 for a deactivated institution even though it is published", async () => {
    await makeInstitution("INS0001", {
      slug: "deactivated-school",
      profileStatus: "PUBLISHED",
      active: false,
    });

    const byId = await callById("INS0001");
    expect(byId.status).toBe(404);

    const bySlug = await callBySlug("deactivated-school");
    expect(bySlug.status).toBe(404);
  });

  it("returns 404 for an unknown id or slug, never 403", async () => {
    const byId = await callById("INS9999");
    expect(byId.status).toBe(404);

    const bySlug = await callBySlug("no-such-school");
    expect(bySlug.status).toBe(404);
  });

  it("never leaks active, profileStatus, or publishedAt in the response body", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
    });

    const response = await callById("INS0001");
    const body = await response.json();
    assertNoForbiddenKeys(body, ["active", "profileStatus", "publishedAt"]);
  });

  it("blocks a burst of reads from one IP once the limit is spent", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
    });

    const attacker = "203.0.113.7";
    for (let index = 0; index < PUBLIC_READ_RATE_LIMIT.limit; index += 1) {
      expect((await callById("INS0001", attacker)).status).toBe(200);
    }

    const blocked = await callById("INS0001", attacker);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    // A shared cache must not hold on to one visitor's 429.
    expect(blocked.headers.get("Cache-Control")).toBe("no-store");

    // The bucket is per IP, not per institution: inventing a different id or
    // reaching for the slug route buys no fresh allowance, which is the whole
    // point on an endpoint whose 200s are cacheable.
    expect((await callById("INS0002", attacker)).status).toBe(429);
    expect((await callBySlug("sunrise-academy", attacker)).status).toBe(429);

    // Another visitor is untouched.
    expect((await callById("INS0001", "198.51.100.4")).status).toBe(200);
  });

  it("omits hidden media items from the payload", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
      media: [
        { kind: "IMAGE", url: "https://cdn.test/visible.jpg", status: "ACTIVE" },
        { kind: "IMAGE", url: "https://cdn.test/hidden.jpg", status: "HIDDEN" },
      ],
    });

    const response = await callById("INS0001");
    const body = await response.json();
    expect(body.profile.media).toHaveLength(1);
    expect(body.profile.media[0].url).toBe("https://cdn.test/visible.jpg");
    expect(body.profile.media[0].kind).toBe("IMAGE");
    expect(typeof body.profile.media[0].id).toBe("string");
    expect(body.profile.media[0].id.length).toBeGreaterThan(0);
  });

  // Mutation check (see task-7-report.md): deleting the `status !== "HIDDEN"`
  // filter in public-projection.ts makes exactly this test fail — the hidden
  // item's id reappears in the response body.
  it("MUTATION-DISTINGUISHING: hidden media never leaves the building", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
      media: [
        { kind: "IMAGE", url: "https://cdn.test/visible.jpg", status: "ACTIVE" },
        { kind: "IMAGE", url: "https://cdn.test/hidden.jpg", status: "HIDDEN" },
      ],
    });

    const response = await callById("INS0001");
    const body = await response.json();
    const urls = (body.profile.media as { url: string }[]).map((item) => item.url);
    expect(urls).not.toContain("https://cdn.test/hidden.jpg");
  });

  it("resolves a relative stored media key to an absolute URL", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
      media: [
        { kind: "BROCHURE", url: "/api/media/INS0001/brochure.pdf", status: "ACTIVE" },
      ],
    });

    const response = await callById("INS0001");
    const body = await response.json();
    expect(body.profile.media[0].url).toBe(
      "https://admissions.test/api/media/INS0001/brochure.pdf",
    );
  });

  it("returns media: [] for a published institution with no media", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
    });

    const response = await callById("INS0001");
    const body = await response.json();
    expect(body.profile.media).toEqual([]);
  });

  it("sorts media by sortOrder, then uploadedAt to break ties, and exposes provider/videoId", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
      media: [
        {
          kind: "IMAGE",
          url: "https://cdn.test/second.jpg",
          status: "ACTIVE",
          sortOrder: 1,
          uploadedAt: new Date("2026-01-02"),
        },
        {
          kind: "VIDEO",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          provider: "YOUTUBE",
          videoId: "dQw4w9WgXcQ",
          status: "ACTIVE",
          sortOrder: 1,
          uploadedAt: new Date("2026-01-01"),
        },
      ],
    });

    const response = await callById("INS0001");
    const body = await response.json();
    expect(body.profile.media).toHaveLength(2);
    expect(body.profile.media[0].kind).toBe("VIDEO");
    expect(body.profile.media[0].provider).toBe("YOUTUBE");
    expect(body.profile.media[0].videoId).toBe("dQw4w9WgXcQ");
    expect(body.profile.media[1].kind).toBe("IMAGE");
  });
  // --- Achievements and alumni ----------------------------------------------
  //
  // Unlike media, these are separate collections. The ACTIVE-only filter and
  // the institution scope both live in the services' `listPublic` queries —
  // at the database, so a projection bug cannot leak a record that was never
  // fetched — which is why the tests that pin them have to run through a real
  // database rather than against the pure projection.

  it("includes active achievements and alumni, with absolute asset URLs", async () => {
    await makeInstitution("INS0001", { slug: "sunrise-academy", profileStatus: "PUBLISHED" });
    await makeAchievement("INS0001", {
      category: "SPORTS",
      title: "State Kabaddi Champions",
      description: "Under-16 team",
      eventDate: new Date("2026-02-01"),
      level: "STATE",
      students: [{ name: "Asha Rao", grade: "10" }],
      photos: ["/api/media/showcase/INS0001/achievements/team.jpg"],
      certificates: ["/api/media/showcase/INS0001/achievements/award.pdf"],
    });
    await makeAlumnus("INS0001", {
      name: "Dr. Meera Iyer",
      batch: "2012-2015",
      category: "DOCTOR",
      currentRole: "Cardiologist",
      org: "Apollo Hospitals",
      note: "Heads the alumni association.",
      photo: "/api/media/showcase/INS0001/alumni/meera.jpg",
    });

    const response = await callById("INS0001");
    const body = await response.json();

    expect(body.profile.achievements).toHaveLength(1);
    const achievement = body.profile.achievements[0];
    expect(typeof achievement.id).toBe("string");
    expect(achievement.id.length).toBeGreaterThan(0);
    expect(achievement.category).toBe("SPORTS");
    expect(achievement.title).toBe("State Kabaddi Champions");
    expect(achievement.description).toBe("Under-16 team");
    expect(achievement.eventDate).toBe("2026-02-01T00:00:00.000Z");
    expect(achievement.level).toBe("STATE");
    expect(achievement.students).toEqual([{ name: "Asha Rao", grade: "10" }]);
    expect(achievement.photos).toEqual([
      "https://admissions.test/api/media/showcase/INS0001/achievements/team.jpg",
    ]);
    expect(achievement.certificates).toEqual([
      "https://admissions.test/api/media/showcase/INS0001/achievements/award.pdf",
    ]);
    expect(achievement).not.toHaveProperty("status");
    expect(achievement).not.toHaveProperty("institutionId");

    expect(body.profile.alumni).toHaveLength(1);
    const alumnus = body.profile.alumni[0];
    expect(typeof alumnus.id).toBe("string");
    expect(alumnus.id.length).toBeGreaterThan(0);
    expect(alumnus.name).toBe("Dr. Meera Iyer");
    expect(alumnus.batch).toBe("2012-2015");
    expect(alumnus.category).toBe("DOCTOR");
    expect(alumnus.currentRole).toBe("Cardiologist");
    expect(alumnus.org).toBe("Apollo Hospitals");
    expect(alumnus.note).toBe("Heads the alumni association.");
    expect(alumnus.photo).toBe("https://admissions.test/api/media/showcase/INS0001/alumni/meera.jpg");
    expect(alumnus).not.toHaveProperty("status");
    expect(alumnus).not.toHaveProperty("institutionId");
  });

  // Mutation check (see task-10-report.md): removing `status: "ACTIVE"` from
  // `AchievementService.listPublic`'s filter makes exactly this test fail — the
  // hidden achievement's title reappears in the response body.
  it("MUTATION-DISTINGUISHING: hidden showcase records never leave the building (achievements)", async () => {
    await makeInstitution("INS0001", { slug: "sunrise-academy", profileStatus: "PUBLISHED" });
    await makeAchievement("INS0001", { title: "Visible achievement", status: "ACTIVE" });
    await makeAchievement("INS0001", { title: "Hidden achievement", status: "HIDDEN" });

    const response = await callById("INS0001");
    const body = await response.json();
    const titles = (body.profile.achievements as { title: string }[]).map((row) => row.title);
    expect(titles).not.toContain("Hidden achievement");
    // Second, so the assertion above is the one a leak trips: over-filtering is
    // a different bug and gets its own failure.
    expect(titles).toContain("Visible achievement");
  });

  // Mutation check (see task-10-report.md): removing `status: "ACTIVE"` from
  // `AlumniService.listPublic`'s filter makes exactly this test fail — the
  // hidden alumnus's name reappears in the response body.
  it("MUTATION-DISTINGUISHING: hidden showcase records never leave the building (alumni)", async () => {
    await makeInstitution("INS0001", { slug: "sunrise-academy", profileStatus: "PUBLISHED" });
    await makeAlumnus("INS0001", { name: "Visible alumnus", status: "ACTIVE" });
    await makeAlumnus("INS0001", { name: "Hidden alumnus", status: "HIDDEN" });

    const response = await callById("INS0001");
    const body = await response.json();
    const names = (body.profile.alumni as { name: string }[]).map((row) => row.name);
    expect(names).not.toContain("Hidden alumnus");
    expect(names).toContain("Visible alumnus");
  });

  // Mutation check (see task-10-report.md): removing `institutionId` from
  // `AchievementService.listPublic`'s filter fails the first assertion;
  // removing it from `AlumniService.listPublic`'s fails the second, which the
  // first leaves reachable.
  it("MUTATION-DISTINGUISHING: another institution's showcase records never appear in the payload", async () => {
    await makeInstitution("INS0001", { slug: "sunrise-academy", profileStatus: "PUBLISHED" });
    await makeInstitution("INS0002", { slug: "moonrise-academy", profileStatus: "PUBLISHED" });
    await makeAchievement("INS0001", { title: "Our achievement" });
    await makeAchievement("INS0002", { title: "Their achievement" });
    await makeAlumnus("INS0001", { name: "Our alumnus" });
    await makeAlumnus("INS0002", { name: "Their alumnus" });

    const response = await callById("INS0001");
    const body = await response.json();
    expect((body.profile.achievements as { title: string }[]).map((row) => row.title)).toEqual([
      "Our achievement",
    ]);
    expect((body.profile.alumni as { name: string }[]).map((row) => row.name)).toEqual([
      "Our alumnus",
    ]);
  });

  it("sorts achievements by eventDate descending, then createdAt descending, with undated ones last", async () => {
    await makeInstitution("INS0001", { slug: "sunrise-academy", profileStatus: "PUBLISHED" });
    // Same eventDate as "Newest", older createdAt — so it breaks the tie below it.
    await makeAchievement("INS0001", {
      title: "Same day, created earlier",
      eventDate: new Date("2026-03-01"),
      createdAt: new Date("2026-06-01"),
    });
    await makeAchievement("INS0001", {
      title: "Newest",
      eventDate: new Date("2026-03-01"),
      createdAt: new Date("2026-06-02"),
    });
    await makeAchievement("INS0001", { title: "Older", eventDate: new Date("2026-01-01") });
    // No eventDate at all. MongoDB sorts a missing field before every value
    // ascending, so descending puts it last — which is what a public page
    // wants, and is the same behaviour the alumni sort relies on for `batch`.
    await makeAchievement("INS0001", { title: "Undated" });

    const response = await callById("INS0001");
    const body = await response.json();
    expect((body.profile.achievements as { title: string }[]).map((row) => row.title)).toEqual([
      "Newest",
      "Same day, created earlier",
      "Older",
      "Undated",
    ]);
  });

  it("sorts alumni by batch descending as raw text, then name ascending, with batch-less ones last", async () => {
    await makeInstitution("INS0001", { slug: "sunrise-academy", profileStatus: "PUBLISHED" });
    // `batch` is free text (`Alumnus.ts`), so this is a lexicographic string
    // sort and NOT a chronological guarantee: "2015" sorts above "2012-2015"
    // because they first differ at the fourth character.
    await makeAlumnus("INS0001", { name: "Bala", batch: "2015" });
    await makeAlumnus("INS0001", { name: "Anita", batch: "2015" });
    await makeAlumnus("INS0001", { name: "Zoya", batch: "2012-2015" });
    await makeAlumnus("INS0001", { name: "Chandra" });

    const response = await callById("INS0001");
    const body = await response.json();
    expect((body.profile.alumni as { name: string }[]).map((row) => row.name)).toEqual([
      "Anita",
      "Bala",
      "Zoya",
      "Chandra",
    ]);
  });

  it("returns achievements: [] and alumni: [] for a published institution with neither", async () => {
    await makeInstitution("INS0001", { slug: "sunrise-academy", profileStatus: "PUBLISHED" });

    const response = await callById("INS0001");
    const body = await response.json();
    expect(body.profile.achievements).toEqual([]);
    expect(body.profile.alumni).toEqual([]);
  });
});
