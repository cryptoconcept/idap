import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { LeadService } from "@/services/lead.service";

beforeAll(() => startTestDatabase("lead-assignees"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});

describe("LeadService.listAssignees", () => {
  it("includes admins and counselors, never front desk", async () => {
    const admin = await makeUser("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    await makeUser("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const assignees = await LeadService.listAssignees("INS0001");
    const ids = assignees.map((a) => a.id).sort();

    expect(ids).toEqual([String(admin._id), String(counselor._id)].sort());
  });
});
