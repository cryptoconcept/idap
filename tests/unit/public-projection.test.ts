import { describe, expect, it } from "vitest";
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
});
