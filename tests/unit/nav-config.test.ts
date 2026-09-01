import { describe, it, expect } from "vitest";
import { navForRole } from "@/components/dashboard/nav-config";

const hrefs = (role: Parameters<typeof navForRole>[0]) =>
  navForRole(role).groups.flatMap((group) => group.items.map((item) => item.href));

describe("navForRole — institution admin", () => {
  it("shows every institution item across four groups", () => {
    const { title, groups } = navForRole("INSTITUTION_ADMIN");

    expect(title).toBe("I-DAP");
    expect(groups).toHaveLength(4);
    expect(hrefs("INSTITUTION_ADMIN")).toEqual([
      "/dashboard",
      "/enquiries",
      "/applications",
      "/results",
      "/academic-structure",
      "/fees",
      "/scholarships",
      "/offers",
      "/profile",
      "/staff",
      "/integration",
      "/settings",
    ]);
  });

  it("labels the three grouped sections and leaves the first unlabelled", () => {
    const { groups } = navForRole("INSTITUTION_ADMIN");
    expect(groups.map((group) => group.title)).toEqual([
      undefined,
      "Academics",
      "Money & offers",
      "Institution setup",
    ]);
  });
});

describe("navForRole — non-admin institution roles", () => {
  // MUTATION-DISTINGUISHING: every adminOnly item must be filtered out, AND the
  // now-empty labelled groups must not survive as headings with no links under
  // them. Asserting only the href list would let an empty "Academics" heading
  // render, which is a visible defect an href assertion cannot see.
  for (const role of ["COUNSELOR", "FRONT_DESK"] as const) {
    it(`${role} sees only the two non-admin items, in one unlabelled group`, () => {
      const { groups } = navForRole(role);

      // Applications became adminOnly with the audit's H1 fix — the plane is
      // INSTITUTION_ADMIN-only, so it must no longer appear in the non-admin nav.
      expect(hrefs(role)).toEqual(["/dashboard", "/enquiries"]);
      expect(groups).toHaveLength(1);
      expect(groups[0].title).toBeUndefined();
    });

    it(`${role} reaches no admin-only route`, () => {
      const reachable = hrefs(role);
      for (const adminRoute of [
        "/applications",
        "/results",
        "/academic-structure",
        "/fees",
        "/scholarships",
        "/offers",
        "/profile",
        "/staff",
        "/integration",
        "/settings",
      ]) {
        expect(reachable).not.toContain(adminRoute);
      }
    });
  }
});

describe("navForRole — super admin", () => {
  it("shows the platform items and never an institution route", () => {
    const { title, groups } = navForRole("SUPER_ADMIN");

    expect(title).toBe("Admin");
    expect(hrefs("SUPER_ADMIN")).toEqual([
      "/admin",
      "/admin/institutions",
      "/admin/api-clients",
      "/admin/platforms",
      "/admin/settings",
    ]);
    expect(groups.map((group) => group.title)).toEqual([undefined, "Integrations", undefined]);
  });
});
