import { describe, expect, it } from "vitest";
import { tenantFilter } from "@/lib/tenant";
import { AppError } from "@/lib/api/errors";
import { sessionFor } from "../helpers/factories";

describe("tenantFilter", () => {
  it("pins an institution admin to their own institution", () => {
    expect(tenantFilter(sessionFor("INSTITUTION_ADMIN", "INS0001"))).toEqual({
      institutionId: "INS0001",
    });
  });

  it("refuses a platform admin outright", () => {
    expect(() => tenantFilter(sessionFor("SUPER_ADMIN"))).toThrowError(AppError);
    try {
      tenantFilter(sessionFor("SUPER_ADMIN"));
    } catch (error) {
      expect((error as AppError).code).toBe("FORBIDDEN");
      expect((error as AppError).message).toMatch(/cannot access institution data/i);
    }
  });

  it("refuses a platform admin even when one is attached to an institution", () => {
    // Guards against a mis-provisioned account becoming a cross-tenant reader.
    expect(() => tenantFilter(sessionFor("SUPER_ADMIN", "INS0001"))).toThrowError(AppError);
  });

  it("refuses an institution admin with no institution", () => {
    expect(() => tenantFilter(sessionFor("INSTITUTION_ADMIN", undefined))).toThrowError(AppError);
  });

  it("has no code path that returns an unscoped clause", () => {
    // The whole isolation story rests on this: every result names one tenant.
    for (const role of ["INSTITUTION_ADMIN", "SUPER_ADMIN"] as const) {
      for (const institutionId of ["INS0001", undefined]) {
        let clause: { institutionId: string } | null = null;
        try {
          clause = tenantFilter(sessionFor(role, institutionId));
        } catch {
          continue;
        }
        expect(Object.keys(clause)).toEqual(["institutionId"]);
        expect(clause.institutionId).toBeTruthy();
      }
    }
  });
});
