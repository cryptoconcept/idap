import { describe, expect, it, vi } from "vitest";
import { toPublicProfile, PublicProfile } from "@/lib/profile/public-projection";

const DOC = {
  _id: "6a8880f3446c577c470cd06c",
  institutionId: "INS0001",
  slug: "sri-vivekananda-school-hanur",
  institutionName: "Sri Vivekananda School",
  institutionType: "SCHOOL",
  regionCode: "KA-MYS",
  legalName: "Sri Vivekananda Education Trust",
  tagline: "Learning without limits",
  description: "A co-educational school in Hanur.",
  establishedYear: 1994,
  logoUrl: "https://cdn.test/logo.png",
  coverImageUrl: "https://cdn.test/cover.jpg",
  address: "Main Road",
  city: "Hanur",
  district: "Chamarajanagar",
  state: "Karnataka",
  pincode: "571439",
  country: "India",
  geo: { latitude: 12.09, longitude: 77.05 },
  phone: "9876543210",
  email: "office@svs.test",
  website: "https://svs.test",
  contactPerson: "R. Shashidhar",
  contact: { secondaryPhone: "9876543211", whatsapp: "9876543210" },
  academic: { board: "State", genderType: "CO_ED", classesOffered: ["1", "2"] },
  management: {
    managementType: "TRUST",
    principalName: "R. Shashidhar",
    headDesignation: "Principal",
    headEmail: "principal@svs.test",
    headPhone: "9876543212",
  },
  facilities: [{ code: "LIBRARY", label: "Library", available: true }],
  social: { instagram: "https://instagram.com/svshanur" },
  media: [
    {
      _id: "1",
      kind: "IMAGE",
      url: "https://cdn.test/1.jpg",
      title: "Campus",
      status: "ACTIVE",
      sortOrder: 1,
      uploadedAt: new Date("2026-01-02"),
    },
    {
      _id: "2",
      kind: "IMAGE",
      url: "https://cdn.test/2.jpg",
      title: "Hidden",
      status: "HIDDEN",
      sortOrder: 2,
      uploadedAt: new Date("2026-01-03"),
    },
    {
      _id: "3",
      kind: "VIDEO",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Campus tour",
      provider: "YOUTUBE",
      videoId: "dQw4w9WgXcQ",
      status: "ACTIVE",
      sortOrder: 1,
      uploadedAt: new Date("2026-01-01"),
    },
    {
      _id: "4",
      kind: "BROCHURE",
      url: "/api/media/INS0001/brochure.pdf",
      title: "Admissions brochure",
      status: "ACTIVE",
      sortOrder: 3,
      uploadedAt: new Date("2026-01-04"),
    },
  ],

  // --- none of the following may ever appear in the output ---
  active: true,
  profileStatus: "PUBLISHED",
  publishedAt: new Date("2026-08-23"),
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-08-23"),
  __v: 0,
};

/**
 * What `AchievementService.listPublic` and `AlumniService.listPublic` hand to
 * the projection: their ordinary DTOs, already filtered to ACTIVE and already
 * sorted, by the database. `status`, `createdAt` and `updatedAt` ride along on
 * those DTOs, and the assertions below pin that none of them survives the
 * projection's allow-list.
 */
const SHOWCASE = {
  achievements: [
    {
      id: "ach-1",
      category: "SPORTS",
      title: "State Kabaddi Champions",
      description: "Under-16 team",
      eventDate: "2026-02-01T00:00:00.000Z",
      level: "STATE",
      students: [{ name: "Asha Rao", grade: "10" }, { name: "Vikram N" }],
      photos: ["/api/media/showcase/INS0001/achievements/team.jpg", "https://cdn.test/podium.jpg"],
      certificates: ["/api/media/showcase/INS0001/achievements/award.pdf"],
      status: "ACTIVE",
      createdAt: "2026-02-02T00:00:00.000Z",
      updatedAt: "2026-02-03T00:00:00.000Z",
    },
    {
      id: "ach-2",
      category: "ACADEMIC",
      title: "Olympiad Gold",
      level: "SCHOOL",
      status: "ACTIVE",
    },
  ],
  alumni: [
    {
      id: "alum-1",
      name: "Dr. Meera Iyer",
      batch: "2012-2015",
      category: "DOCTOR",
      currentRole: "Cardiologist",
      org: "Apollo Hospitals",
      photo: "/api/media/showcase/INS0001/alumni/meera.jpg",
      note: "Heads the alumni association.",
      status: "ACTIVE",
      createdAt: "2026-02-02T00:00:00.000Z",
      updatedAt: "2026-02-03T00:00:00.000Z",
    },
    {
      id: "alum-2",
      name: "Ravi Kumar",
      category: "ENGINEER",
      status: "ACTIVE",
    },
  ],
};

describe("public profile projection", () => {
  it("exposes the institution's public identity", () => {
    const out = toPublicProfile(DOC) as Record<string, unknown>;
    expect(out.institutionId).toBe("INS0001");
    expect(out.slug).toBe("sri-vivekananda-school-hanur");
    expect(out.institutionName).toBe("Sri Vivekananda School");
    expect(out.regionCode).toBe("KA-MYS");
  });

  it("never exposes operational or internal fields", () => {
    const out = toPublicProfile(DOC) as Record<string, unknown>;
    for (const key of ["active", "profileStatus", "publishedAt", "createdAt", "updatedAt", "_id", "__v"]) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it("withholds the head's direct email and phone", () => {
    const out = toPublicProfile(DOC) as PublicProfile;
    expect(out.management!.principalName).toBe("R. Shashidhar");
    expect(out.management!.headDesignation).toBe("Principal");
    expect(out.management).not.toHaveProperty("headEmail");
    expect(out.management).not.toHaveProperty("headPhone");
  });

  it("omits hidden media items", () => {
    const out = toPublicProfile(DOC) as PublicProfile;
    expect(out.media).toHaveLength(3);
    expect(out.media.some((item) => item.title === "Hidden")).toBe(false);
  });

  // Mutation check (see task-7-report.md): deleting the `status !== "HIDDEN"`
  // filter in public-projection.ts makes exactly this test fail — the hidden
  // item's id reappears in the output.
  it("MUTATION-DISTINGUISHING: hidden media never leaves the building", () => {
    const out = toPublicProfile(DOC) as PublicProfile;
    const ids = out.media.map((item) => item.id);
    expect(ids).not.toContain("2");
  });

  it("sorts media by sortOrder, then uploadedAt to break ties", () => {
    const out = toPublicProfile(DOC) as PublicProfile;
    // Items "3" and "1" tie on sortOrder (1); "3" was uploaded earlier and
    // sorts first. Item "4" has the highest sortOrder (3) and sorts last.
    expect(out.media.map((item) => item.id)).toEqual(["3", "1", "4"]);
  });

  it("exposes id, kind, provider and videoId alongside url/title/caption", () => {
    const out = toPublicProfile(DOC) as PublicProfile;
    const video = out.media.find((item) => item.id === "3")!;
    expect(video.kind).toBe("VIDEO");
    expect(video.provider).toBe("YOUTUBE");
    expect(video.videoId).toBe("dQw4w9WgXcQ");
    expect(video.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("resolves a relative stored key to an absolute URL", () => {
    const out = toPublicProfile(DOC) as PublicProfile;
    const brochure = out.media.find((item) => item.id === "4")!;
    expect(brochure.kind).toBe("BROCHURE");
    expect(brochure.url).toBe("https://admissions.test/api/media/INS0001/brochure.pdf");
  });

  it("does not leak a field that was added to the schema but not to the allow-list", () => {
    // The guarantee: private by default. If this fails, someone has replaced
    // the allow-list with a spread, and every future field leaks on the day it
    // is added.
    const out = toPublicProfile({
      ...DOC,
      internalRiskNote: "school is behind on payment",
      subscriptionPlan: "TRIAL",
    }) as Record<string, unknown>;

    expect(out).not.toHaveProperty("internalRiskNote");
    expect(out).not.toHaveProperty("subscriptionPlan");
  });

  it("survives a sparse document without inventing values", () => {
    const out = toPublicProfile({
      institutionId: "INS0002",
      institutionName: "Bare",
      institutionType: "SCHOOL",
      slug: "bare",
    }) as PublicProfile;

    expect(out.institutionName).toBe("Bare");
    expect(out.facilities).toEqual([]);
    expect(out.media).toEqual([]);
    expect(out.academic).toBeUndefined();
  });

  // MUTATION-DISTINGUISHING: pins the deliberate half of the two-guard
  // asymmetry (I5). `assertExternallyReachable` is called on the FeesBasket
  // path (`feesbasket-mapping.ts`) but MUST NOT be called here — a localhost
  // `NEXT_PUBLIC_APP_URL` is IDAP's own default dev configuration
  // (`src/lib/env.ts`), and this endpoint is IDAP serving its own API to
  // itself. Every other test in this file resolves against
  // `tests/helpers/setup.ts`'s fixed `https://admissions.test`, so none of
  // them would notice if someone "fixed the inconsistency" by adding the
  // guard here too — this is the one that would fail: it would start
  // throwing a 400 instead of returning the resolved localhost URL.
  it("MUTATION-DISTINGUISHING: resolves a relative media url against a localhost APP_URL without throwing", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    try {
      const out = toPublicProfile({
        ...DOC,
        media: [
          {
            _id: "5",
            kind: "IMAGE",
            url: "/api/media/INS0001/local.jpg",
            status: "ACTIVE",
            sortOrder: 0,
            uploadedAt: new Date("2026-01-01"),
          },
        ],
      }) as PublicProfile;

      expect(out.media).toHaveLength(1);
      expect(out.media[0].url).toBe("http://localhost:3000/api/media/INS0001/local.jpg");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  // --- Achievements and alumni ----------------------------------------------
  //
  // Both arrive as a THIRD argument rather than off the institution document:
  // they are separate collections, so `InstitutionService.getPublicProfile`
  // fetches them — ACTIVE-only and institution-scoped, in the services'
  // `listPublic` — and hands them in. This projection stays pure over what it
  // is given: it does not filter by status and does not sort, so the tests
  // pinning those two guarantees live in
  // `tests/integration/public-profile.test.ts`, where the database query that
  // makes them true actually runs.

  it("projects the achievements it is handed, without their internal fields", () => {
    const out = toPublicProfile(DOC, undefined, SHOWCASE);
    expect(out.achievements).toHaveLength(2);

    const [first, second] = out.achievements;
    expect(first.id).toBe("ach-1");
    expect(first.category).toBe("SPORTS");
    expect(first.title).toBe("State Kabaddi Champions");
    expect(first.description).toBe("Under-16 team");
    expect(first.eventDate).toBe("2026-02-01T00:00:00.000Z");
    expect(first.level).toBe("STATE");
    expect(first.students).toEqual([{ name: "Asha Rao", grade: "10" }, { name: "Vikram N" }]);

    for (const key of ["status", "createdAt", "updatedAt", "institutionId"]) {
      expect(first).not.toHaveProperty(key);
    }

    // Nothing stored, and still an array — a consumer never has to guard.
    expect(second.photos).toEqual([]);
    expect(second.certificates).toEqual([]);
    expect(second.students).toEqual([]);
  });

  it("projects the alumni it is handed, without their internal fields", () => {
    const out = toPublicProfile(DOC, undefined, SHOWCASE);
    expect(out.alumni).toHaveLength(2);

    const [first, second] = out.alumni;
    expect(first.id).toBe("alum-1");
    expect(first.name).toBe("Dr. Meera Iyer");
    expect(first.batch).toBe("2012-2015");
    expect(first.category).toBe("DOCTOR");
    expect(first.currentRole).toBe("Cardiologist");
    expect(first.org).toBe("Apollo Hospitals");
    expect(first.note).toBe("Heads the alumni association.");

    for (const key of ["status", "createdAt", "updatedAt", "institutionId"]) {
      expect(first).not.toHaveProperty(key);
    }

    expect(second.name).toBe("Ravi Kumar");
    expect(second.photo).toBeUndefined();
  });

  it("resolves showcase asset keys to absolute URLs, passing an already-absolute one through", () => {
    const out = toPublicProfile(DOC, undefined, SHOWCASE);
    expect(out.achievements[0].photos).toEqual([
      "https://admissions.test/api/media/showcase/INS0001/achievements/team.jpg",
      "https://cdn.test/podium.jpg",
    ]);
    expect(out.achievements[0].certificates).toEqual([
      "https://admissions.test/api/media/showcase/INS0001/achievements/award.pdf",
    ]);
    expect(out.alumni[0].photo).toBe(
      "https://admissions.test/api/media/showcase/INS0001/alumni/meera.jpg",
    );
  });

  it("keeps the order it is handed — ordering is the services' job, at the database", () => {
    const out = toPublicProfile(DOC, undefined, {
      achievements: [...SHOWCASE.achievements].reverse(),
      alumni: [...SHOWCASE.alumni].reverse(),
    });
    expect(out.achievements.map((row) => row.id)).toEqual(["ach-2", "ach-1"]);
    expect(out.alumni.map((row) => row.id)).toEqual(["alum-2", "alum-1"]);
  });

  it("returns empty achievement and alumni arrays when it is handed neither", () => {
    const out = toPublicProfile(DOC);
    expect(out.achievements).toEqual([]);
    expect(out.alumni).toEqual([]);
  });

  // MUTATION-DISTINGUISHING: the showcase half of the same asymmetry the media
  // test above pins (I5). `assertExternallyReachable` MUST NOT be called on
  // this path: `http://localhost:3000` is IDAP's own default `APP_URL`
  // (`src/lib/env.ts`), and this endpoint is IDAP serving its own API to
  // itself, so a localhost URL here is harmless — unlike the FeesBasket push,
  // where the URL is handed to a partner that only ever links to it. Every
  // other test in this file resolves against the fixed `https://admissions.test`
  // of `tests/helpers/setup.ts`, so none of them would notice if someone
  // "fixed the inconsistency" by adding the guard here too; this is the one
  // that would fail, by throwing a 400 instead of resolving the URL.
  it("MUTATION-DISTINGUISHING: resolves showcase asset keys against a localhost APP_URL without throwing", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    try {
      const out = toPublicProfile(DOC, undefined, SHOWCASE);
      expect(out.achievements[0].photos[0]).toBe(
        "http://localhost:3000/api/media/showcase/INS0001/achievements/team.jpg",
      );
      expect(out.achievements[0].certificates[0]).toBe(
        "http://localhost:3000/api/media/showcase/INS0001/achievements/award.pdf",
      );
      expect(out.alumni[0].photo).toBe(
        "http://localhost:3000/api/media/showcase/INS0001/alumni/meera.jpg",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
