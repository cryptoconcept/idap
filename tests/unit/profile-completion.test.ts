import { describe, expect, it } from "vitest";
import { calculateCompletion } from "@/lib/profile/completion";

const EMPTY = { institutionName: "", institutionType: "" };

const FULL = {
  institutionName: "Sri Vivekananda School",
  institutionType: "SCHOOL",
  description: "A co-educational school in Hanur.",
  establishedYear: 1994,
  phone: "9876543210",
  email: "office@svs.test",
  contactPerson: "R. Shashidhar",
  address: "Main Road",
  city: "Hanur",
  district: "Chamarajanagar",
  state: "Karnataka",
  pincode: "571439",
  academic: { board: "State", classesOffered: ["1", "2"] },
  management: { managementType: "TRUST", principalName: "R. Shashidhar" },
  facilities: [
    { code: "LIBRARY", label: "Library" },
    { code: "LAB", label: "Lab" },
    { code: "TRANSPORT", label: "Transport" },
  ],
  logoUrl: "https://cdn.test/logo.png",
  coverImageUrl: "https://cdn.test/cover.jpg",
  social: { instagram: "https://instagram.com/x", facebook: "https://facebook.com/x" },
};

describe("profile completion", () => {
  it("scores an empty profile at zero and names everything missing", () => {
    const result = calculateCompletion(EMPTY);
    expect(result.percent).toBe(0);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it("scores a fully populated profile at one hundred with nothing missing", () => {
    const result = calculateCompletion(FULL);
    expect(result.percent).toBe(100);
    expect(result.missing).toEqual([]);
  });

  it("is deterministic — the same document always scores the same", () => {
    const a = calculateCompletion(FULL);
    const b = calculateCompletion({ ...FULL });
    expect(a.percent).toBe(b.percent);
  });

  it("weights sum to exactly one hundred", () => {
    const total = calculateCompletion(EMPTY).groups.reduce((sum, g) => sum + g.weight, 0);
    expect(total).toBe(100);
  });

  it("gives partial credit inside a group rather than all-or-nothing", () => {
    const half = calculateCompletion({ ...EMPTY, logoUrl: "https://cdn.test/logo.png" });
    expect(half.percent).toBe(10); // the logo group's whole weight, nothing else
  });

  it("requires three facilities before the facilities group is complete", () => {
    const two = calculateCompletion({
      ...EMPTY,
      facilities: [
        { code: "A", label: "A" },
        { code: "B", label: "B" },
      ],
    });
    const three = calculateCompletion({
      ...EMPTY,
      facilities: [
        { code: "A", label: "A" },
        { code: "B", label: "B" },
        { code: "C", label: "C" },
      ],
    });
    expect(two.percent).toBeLessThan(three.percent);
    expect(three.percent).toBe(10);
  });

  it("never reports a percentage above one hundred", () => {
    const overfilled = { ...FULL, facilities: Array.from({ length: 40 }, (_, i) => ({ code: `F${i}`, label: `F${i}` })) };
    expect(calculateCompletion(overfilled).percent).toBe(100);
  });
});
