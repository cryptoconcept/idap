import { describe, expect, it } from "vitest";
import {
  platformInstitutionPatchSchema,
  updateProfileSchema,
} from "@/lib/validation/institution";

describe("profile validation", () => {
  it("accepts a partial section update", () => {
    const parsed = updateProfileSchema.parse({
      academic: { board: "CBSE", classesOffered: ["1", "2"] },
    });
    expect(parsed.academic?.board).toBe("CBSE");
  });

  it("strips fields the institute admin may not set", () => {
    const parsed = updateProfileSchema.parse({
      institutionName: "New Name",
      institutionId: "INS9999",
      active: false,
      profileStatus: "PUBLISHED",
    }) as Record<string, unknown>;

    expect(parsed.institutionName).toBe("New Name");
    expect(parsed).not.toHaveProperty("institutionId");
    expect(parsed).not.toHaveProperty("active");
    expect(parsed).not.toHaveProperty("profileStatus");
  });

  it("keeps the platform admin out of profile content", () => {
    // The boundary is enforced by this schema, not by the UI.
    const parsed = platformInstitutionPatchSchema.parse({
      institutionName: "Renamed",
      active: false,
      regionCode: "KA-MYS",
      description: "trying to edit the profile",
      academic: { board: "CBSE" },
      logoUrl: "https://cdn.test/other.png",
      media: [{ kind: "IMAGE", url: "https://cdn.test/x.jpg" }],
    }) as Record<string, unknown>;

    expect(parsed.institutionName).toBe("Renamed");
    expect(parsed.active).toBe(false);
    expect(parsed.regionCode).toBe("KA-MYS");
    expect(parsed).not.toHaveProperty("description");
    expect(parsed).not.toHaveProperty("academic");
    expect(parsed).not.toHaveProperty("logoUrl");
    expect(parsed).not.toHaveProperty("media");
  });

  it("rejects a malformed social URL", () => {
    expect(() => updateProfileSchema.parse({ social: { instagram: "not a url" } })).toThrow();
  });

  it("rejects an impossible established year", () => {
    expect(() => updateProfileSchema.parse({ establishedYear: 1500 })).toThrow();
    expect(() => updateProfileSchema.parse({ establishedYear: 3000 })).toThrow();
  });

  it("rejects out-of-range coordinates", () => {
    expect(() => updateProfileSchema.parse({ geo: { latitude: 200 } })).toThrow();
    expect(() => updateProfileSchema.parse({ geo: { longitude: -900 } })).toThrow();
  });

  it("requires both code and label on a facility", () => {
    expect(() => updateProfileSchema.parse({ facilities: [{ code: "LIBRARY" }] })).toThrow();
    expect(
      updateProfileSchema.parse({ facilities: [{ code: "LIBRARY", label: "Library" }] }).facilities,
    ).toHaveLength(1);
  });
});
