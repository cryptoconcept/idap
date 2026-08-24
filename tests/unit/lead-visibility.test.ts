import { describe, expect, it } from "vitest";
import { assertOwnsLead, leadVisibilityFilter } from "@/lib/tenant/permissions";
import { AppError } from "@/lib/api/errors";
import type { CurrentUser } from "@/lib/auth/current-user";

function userOf(role: CurrentUser["role"], id = "u1"): CurrentUser {
  return { id, name: "Test", email: "t@example.test", role, institutionId: "INS0001" };
}

describe("leadVisibilityFilter", () => {
  it("returns an empty filter for a role holding LEADS_VIEW_ALL", () => {
    expect(leadVisibilityFilter(userOf("INSTITUTION_ADMIN"))).toEqual({});
  });

  it("returns a mine-or-unassigned filter for a role holding only LEADS_VIEW_OWN", () => {
    expect(leadVisibilityFilter(userOf("COUNSELOR", "c1"))).toEqual({
      $or: [{ assignedTo: "c1" }, { assignedTo: null }],
    });
  });

  it("produces the same shape for FRONT_DESK, whose assignedTo is always null in practice", () => {
    expect(leadVisibilityFilter(userOf("FRONT_DESK", "f1"))).toEqual({
      $or: [{ assignedTo: "f1" }, { assignedTo: null }],
    });
  });
});

describe("assertOwnsLead", () => {
  it("never throws for INSTITUTION_ADMIN, regardless of assignedTo", () => {
    expect(() => assertOwnsLead(userOf("INSTITUTION_ADMIN"), { assignedTo: "someone-else" })).not.toThrow();
    expect(() => assertOwnsLead(userOf("INSTITUTION_ADMIN"), { assignedTo: null })).not.toThrow();
  });

  it("passes for a COUNSELOR when the lead is assigned to them", () => {
    expect(() => assertOwnsLead(userOf("COUNSELOR", "c1"), { assignedTo: "c1" })).not.toThrow();
  });

  it("throws NOT_FOUND — never FORBIDDEN — for a COUNSELOR on someone else's lead", () => {
    expect(() => assertOwnsLead(userOf("COUNSELOR", "c1"), { assignedTo: "c2" })).toThrow(AppError);
    try {
      assertOwnsLead(userOf("COUNSELOR", "c1"), { assignedTo: "c2" });
    } catch (error) {
      expect((error as AppError).code).toBe("NOT_FOUND");
    }
  });

  it("throws NOT_FOUND for a COUNSELOR on an unassigned lead — ownership, not just visibility", () => {
    expect(() => assertOwnsLead(userOf("COUNSELOR", "c1"), { assignedTo: null })).toThrow(AppError);
  });
});
