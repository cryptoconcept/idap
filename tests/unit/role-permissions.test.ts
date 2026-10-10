import { describe, expect, it } from "vitest";
import { hasPermission, requirePermission } from "@/lib/tenant/permissions";
import { PERMISSIONS, ROLE_PERMISSIONS, USER_ROLES } from "@/lib/constants";
import { AppError } from "@/lib/api/errors";
import type { CurrentUser } from "@/lib/auth/current-user";

function userOf(role: (typeof USER_ROLES)[number]): CurrentUser {
  return { id: "u1", name: "Test", email: "t@example.test", role, institutionId: "INS0001" };
}

describe("ROLE_PERMISSIONS", () => {
  it("has an entry for every role, including SUPER_ADMIN", () => {
    for (const role of USER_ROLES) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
    }
  });

  it("gives SUPER_ADMIN zero permissions", () => {
    expect(ROLE_PERMISSIONS.SUPER_ADMIN.size).toBe(0);
  });

  it("gives INSTITUTION_ADMIN every permission", () => {
    for (const permission of PERMISSIONS) {
      expect(ROLE_PERMISSIONS.INSTITUTION_ADMIN.has(permission)).toBe(true);
    }
  });

  it("gives COUNSELOR exactly LEADS_VIEW_OWN, LEADS_UPDATE, LEADS_SET_FOLLOWUP, SCHOLARSHIP_APPLICATIONS_VIEW, SCHOLARSHIP_APPLICATIONS_DECIDE", () => {
    expect([...ROLE_PERMISSIONS.COUNSELOR].sort()).toEqual(
      [
        "LEADS_SET_FOLLOWUP",
        "LEADS_UPDATE",
        "LEADS_VIEW_OWN",
        "SCHOLARSHIP_APPLICATIONS_VIEW",
        "SCHOLARSHIP_APPLICATIONS_DECIDE",
      ].sort(),
    );
  });

  it("gives FRONT_DESK exactly LEADS_VIEW_OWN and LEADS_CREATE — never LEADS_VIEW_ALL", () => {
    expect([...ROLE_PERMISSIONS.FRONT_DESK].sort()).toEqual(
      ["LEADS_CREATE", "LEADS_VIEW_OWN"].sort(),
    );
    expect(ROLE_PERMISSIONS.FRONT_DESK.has("LEADS_VIEW_ALL")).toBe(false);
  });

  it("never gives COUNSELOR or FRONT_DESK STAFF_MANAGE, LEADS_ASSIGN, LEADS_DELETE, or LEADS_EXPORT", () => {
    for (const role of ["COUNSELOR", "FRONT_DESK"] as const) {
      for (const permission of ["STAFF_MANAGE", "LEADS_ASSIGN", "LEADS_DELETE", "LEADS_EXPORT"] as const) {
        expect(ROLE_PERMISSIONS[role].has(permission)).toBe(false);
      }
    }
  });
});

describe("hasPermission / requirePermission", () => {
  it("hasPermission reflects the table", () => {
    expect(hasPermission(userOf("COUNSELOR"), "LEADS_UPDATE")).toBe(true);
    expect(hasPermission(userOf("COUNSELOR"), "LEADS_ASSIGN")).toBe(false);
  });

  it("requirePermission throws FORBIDDEN when the role lacks the permission", () => {
    expect(() => requirePermission(userOf("FRONT_DESK"), "LEADS_ASSIGN")).toThrow(AppError);
    try {
      requirePermission(userOf("FRONT_DESK"), "LEADS_ASSIGN");
    } catch (error) {
      expect((error as AppError).code).toBe("FORBIDDEN");
    }
  });

  it("requirePermission does not throw when the role holds the permission", () => {
    expect(() => requirePermission(userOf("INSTITUTION_ADMIN"), "STAFF_MANAGE")).not.toThrow();
  });

  it("requirePermission throws for SUPER_ADMIN on every permission", () => {
    for (const permission of PERMISSIONS) {
      expect(() => requirePermission(userOf("SUPER_ADMIN"), permission)).toThrow(AppError);
    }
  });
});
