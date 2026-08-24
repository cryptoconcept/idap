import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { StaffService } from "@/services/staff.service";

beforeAll(() => startTestDatabase("staff-management"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

const input = {
  name: "Priya Counselor",
  email: "priya@infinityschool.edu.in",
  password: "Password!2026",
  role: "COUNSELOR" as const,
};

describe("StaffService", () => {
  it("creates a Counselor account scoped to the institution", async () => {
    const staff = await StaffService.create("INS0001", input);
    expect(staff.role).toBe("COUNSELOR");
    expect(staff.active).toBe(true);
  });

  it("creates a Front Desk account", async () => {
    const staff = await StaffService.create("INS0001", { ...input, email: "fd@infinityschool.edu.in", role: "FRONT_DESK" });
    expect(staff.role).toBe("FRONT_DESK");
  });

  it("refuses a duplicate email across the whole platform", async () => {
    await StaffService.create("INS0001", input);
    await expect(StaffService.create("INS0002", input)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lists only the calling institution's staff", async () => {
    await StaffService.create("INS0001", input);
    await StaffService.create("INS0002", { ...input, email: "other@intelligentpublic.edu.in" });

    const list = await StaffService.list("INS0001");
    expect(list).toHaveLength(1);
    expect(list[0]?.email).toBe(input.email);
  });

  it("deactivates and reactivates a staff account", async () => {
    const staff = await StaffService.create("INS0001", input);
    const deactivated = await StaffService.setActive("INS0001", staff.id, false);
    expect(deactivated.active).toBe(false);

    const reactivated = await StaffService.setActive("INS0001", staff.id, true);
    expect(reactivated.active).toBe(true);
  });

  it("returns NOT_FOUND when deactivating a staff account from another institution", async () => {
    const staff = await StaffService.create("INS0001", input);
    await expect(StaffService.setActive("INS0002", staff.id, false)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns VALIDATION_ERROR for a malformed staff id, not an unhandled cast error", async () => {
    await expect(StaffService.setActive("INS0001", "not-a-valid-id", false)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});
