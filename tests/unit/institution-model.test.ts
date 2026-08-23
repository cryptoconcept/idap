import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { Institution } from "@/models";
import { GALLERY_MAX_ITEMS, INSTITUTION_TYPES } from "@/lib/constants";

describe("Institution profile schema", () => {
  beforeAll(async () => {
    await startTestDatabase("institutionmodel");
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("defaults a new institution to an unpublished profile on a live account", async () => {
    // The two flags are independent: a school runs admissions while its
    // profile is still a draft. Conflating them would take every existing
    // institution offline on the day this ships.
    const created = await Institution.create({
      institutionId: "INS0001",
      institutionName: "Sri Vivekananda School",
      institutionType: "SCHOOL",
    });

    expect(created.profileStatus).toBe("DRAFT");
    expect(created.active).toBe(true);
    expect(created.publishedAt).toBeUndefined();
  });

  it("stores every new profile block", async () => {
    await Institution.create({
      institutionId: "INS0001",
      institutionName: "Sri Vivekananda School",
      institutionType: "SCHOOL",
      slug: "sri-vivekananda-school-hanur",
      regionCode: "KA-MYS",
      legalName: "Sri Vivekananda Education Trust",
      shortName: "SVS Hanur",
      establishedYear: 1994,
      tagline: "Learning without limits",
      description: "A co-educational school in Hanur.",
      contact: { secondaryPhone: "9876543211", whatsapp: "9876543210" },
      district: "Chamarajanagar",
      taluk: "Hanur",
      country: "India",
      geo: { latitude: 12.09, longitude: 77.05 },
      academic: {
        board: "State",
        genderType: "CO_ED",
        medium: ["English", "Kannada"],
        classesOffered: ["1", "2", "3"],
      },
      management: { managementType: "TRUST", principalName: "R. Shashidhar" },
      facilities: [{ code: "LIBRARY", label: "Library", note: "8,000 titles" }],
      social: { instagram: "https://instagram.com/svshanur" },
      gallery: [{ imageUrl: "https://cdn.test/1.jpg", title: "Campus" }],
    });

    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();

    expect(row!.slug).toBe("sri-vivekananda-school-hanur");
    expect(row!.regionCode).toBe("KA-MYS");
    expect(row!.academic!.medium).toEqual(["English", "Kannada"]);
    expect(row!.facilities![0]!.available).toBe(true); // defaults to available
    expect(row!.gallery![0]!.status).toBe("ACTIVE");
    expect(row!.gallery![0]!._id).toBeDefined(); // addressable for delete
  });

  it("accepts an institution with no slug, so un-backfilled records still save", async () => {
    // The unique index is sparse on purpose. A required slug would make every
    // existing institution fail validation the moment its admin pressed Save.
    await Institution.create({
      institutionId: "INS0001",
      institutionName: "No Slug Yet",
      institutionType: "SCHOOL",
    });
    await Institution.create({
      institutionId: "INS0002",
      institutionName: "Also No Slug",
      institutionType: "SCHOOL",
    });

    expect(await Institution.countDocuments({ slug: { $exists: false } })).toBe(2);
  });

  it("rejects a duplicate slug", async () => {
    await Institution.create({
      institutionId: "INS0001",
      institutionName: "A",
      institutionType: "SCHOOL",
      slug: "taken",
    });
    await Institution.syncIndexes();

    await expect(
      Institution.create({
        institutionId: "INS0002",
        institutionName: "B",
        institutionType: "SCHOOL",
        slug: "taken",
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("carries the five new institution types without disturbing the old seven", async () => {
    expect(INSTITUTION_TYPES).toContain("SCHOOL");
    expect(INSTITUTION_TYPES).toContain("POLYTECHNIC");
    expect(INSTITUTION_TYPES).toContain("NURSING_COLLEGE");
    expect(INSTITUTION_TYPES).toHaveLength(12);
    expect(GALLERY_MAX_ITEMS).toBe(60);
  });
});
