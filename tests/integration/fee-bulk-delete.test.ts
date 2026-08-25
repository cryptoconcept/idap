import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { AcademicUnit, FeeStructure, Institution } from "@/models";
import { FeeStructureService } from "@/services/fee-structure.service";
import { AcademicStructureService, type AcademicUnitDTO } from "@/services/academic-structure.service";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { POST as deleteBulk } from "@/app/api/settings/fees/bulk/delete/route";

function cookieRequest(init: { body?: unknown; origin?: string } = {}) {
  const url = new URL("http://localhost/api/settings/fees/bulk/delete");
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  headers.set("host", "localhost");
  return {
    headers,
    nextUrl: url,
    url: url.toString(),
    json: async () => init.body ?? {},
  } as unknown as NextRequest;
}

async function signIn(
  institutionId: string,
  role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK",
  email: string,
) {
  const user = await makeUser(institutionId, role, email);
  const token = await signSession({
    sub: String(user._id),
    role,
    institutionId,
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
  return user;
}

/** Platform-admin session: no institutionId, role SUPER_ADMIN — the 403 case. */
async function signInPlatformAdmin(email = "platform-fees-bulk-delete@example.test") {
  const user = await makeUser(undefined, "SUPER_ADMIN", email);
  const token = await signSession({
    sub: String(user._id),
    role: "SUPER_ADMIN",
    institutionId: undefined,
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
}

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };
const lineItems = [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" as const }];

let unitA: AcademicUnitDTO;
let unitB: AcademicUnitDTO;
let foreignUnit: AcademicUnitDTO;

beforeAll(async () => {
  await startTestDatabase("fee-bulk-delete");
  await AcademicUnit.syncIndexes();
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");

  unitA = await AcademicStructureService.create(
    "INS0001",
    { segment: "SCHOOL", name: "Grade 10" },
    actor,
  );
  unitB = await AcademicStructureService.create(
    "INS0001",
    { segment: "SCHOOL", name: "Grade 9" },
    actor,
  );
  foreignUnit = await AcademicStructureService.create(
    "INS0002",
    { segment: "SCHOOL", name: "Grade 10" },
    actor,
  );
});

describe("FeeStructureService.removeMany", () => {
  it("deletes every named structure and returns the count", async () => {
    const a = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unitA.id, academicYear: "2026-27", lineItems },
      actor,
    );
    const b = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unitB.id, academicYear: "2026-27", lineItems },
      actor,
    );

    const result = await FeeStructureService.removeMany("INS0001", [a.id, b.id], actor);

    expect(result.deleted).toBe(2);
    expect(await FeeStructure.countDocuments({})).toBe(0);
  });

  it("fails the whole batch with NOT_FOUND for a foreign id, deleting nothing", async () => {
    const a = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unitA.id, academicYear: "2026-27", lineItems },
      actor,
    );
    const foreign = await FeeStructureService.create(
      "INS0002",
      { academicUnitId: foreignUnit.id, academicYear: "2026-27", lineItems },
      actor,
    );

    await expect(
      FeeStructureService.removeMany("INS0001", [a.id, foreign.id], actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The count that matters: nothing was removed, not even the owned id.
    expect(await FeeStructure.countDocuments({})).toBe(2);
  });

  it("fails with NOT_FOUND, never a 500, for a malformed id", async () => {
    const a = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unitA.id, academicYear: "2026-27", lineItems },
      actor,
    );

    await expect(
      FeeStructureService.removeMany("INS0001", [a.id, "not-an-object-id"], actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await FeeStructure.countDocuments({})).toBe(1);
  });

  it("deleting a PUBLISHED structure removes it from the public API", async () => {
    // INS0001 already exists from `beforeEach` — publish it in place rather
    // than creating a second document, which would collide on the unique
    // `institutionId` index.
    await Institution.updateOne({ institutionId: "INS0001" }, { $set: { profileStatus: "PUBLISHED" } });
    const created = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unitA.id, academicYear: "2026-27", lineItems },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    const before = await FeeStructureService.listPublic({ institutionId: "INS0001" });
    expect(before).toHaveLength(1);

    const result = await FeeStructureService.removeMany("INS0001", [created.id], actor);
    expect(result.deleted).toBe(1);

    const after = await FeeStructureService.listPublic({ institutionId: "INS0001" });
    expect(after).toEqual([]);
  });
});

describe("POST /api/settings/fees/bulk/delete — the route's security boundary", () => {
  it("an admin bulk-deletes over HTTP — 200 with the count; a Counselor and a platform admin get 403", async () => {
    const a = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unitA.id, academicYear: "2026-27", lineItems },
      actor,
    );

    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const counselor = await deleteBulk(
      cookieRequest({ body: { feeStructureIds: [a.id] }, origin: "http://localhost" }),
    );
    expect(counselor.status).toBe(403);
    // The CODE, not just the status: DEFAULT_STATUS maps both FORBIDDEN and
    // INACTIVE_INSTITUTION to 403, so a bare status check cannot tell the role
    // gate firing from some other 403 branch firing in its place.
    expect((await counselor.json()).error.code).toBe("FORBIDDEN");
    (await cookies()).delete(SESSION_COOKIE);

    await signInPlatformAdmin();
    const platformAdmin = await deleteBulk(
      cookieRequest({ body: { feeStructureIds: [a.id] }, origin: "http://localhost" }),
    );
    expect(platformAdmin.status).toBe(403);
    expect((await platformAdmin.json()).error.code).toBe("FORBIDDEN");
    (await cookies()).delete(SESSION_COOKIE);

    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    const response = await deleteBulk(
      cookieRequest({ body: { feeStructureIds: [a.id] }, origin: "http://localhost" }),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.deleted).toBe(1);
  });

  it("a cross-origin write is rejected with 403 FORBIDDEN", async () => {
    const a = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unitA.id, academicYear: "2026-27", lineItems },
      actor,
    );
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await deleteBulk(
      cookieRequest({ body: { feeStructureIds: [a.id] }, origin: "http://evil.example" }),
    );

    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload.error.code).toBe("FORBIDDEN");
  });
});
