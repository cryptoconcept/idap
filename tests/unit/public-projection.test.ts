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
  gallery: [
    { _id: "1", imageUrl: "https://cdn.test/1.jpg", title: "Campus", status: "ACTIVE", sortOrder: 1 },
    { _id: "2", imageUrl: "https://cdn.test/2.jpg", title: "Hidden", status: "HIDDEN", sortOrder: 2 },
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

  it("omits hidden gallery items", () => {
    const out = toPublicProfile(DOC) as PublicProfile;
    expect(out.gallery).toHaveLength(1);
    expect(out.gallery[0].title).toBe("Campus");
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
    expect(out.gallery).toEqual([]);
    expect(out.academic).toBeUndefined();
  });
});
