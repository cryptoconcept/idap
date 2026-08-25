import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { Activity, AcademicUnit, FeeStructure } from "@/models";
import { FeeStructureService } from "@/services/fee-structure.service";
import { AcademicStructureService, type AcademicUnitDTO } from "@/services/academic-structure.service";
import type { BulkCreateFeeInput } from "@/lib/validation/fee-structure";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { POST as createBulk } from "@/app/api/settings/fees/bulk/route";

function cookieRequest(init: { body?: unknown; origin?: string } = {}) {
  const url = new URL("http://localhost/api/settings/fees/bulk");
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
async function signInPlatformAdmin(email = "platform-fees-bulk@example.test") {
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

let unitA: AcademicUnitDTO;
let unitB: AcademicUnitDTO;
let foreignUnit: AcademicUnitDTO;

function input(overrides: Partial<BulkCreateFeeInput> = {}): BulkCreateFeeInput {
  return {
    academicUnitIds: [unitA.id, unitB.id],
    academicYear: "2026-27",
    lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" as const }],
    ...overrides,
  };
}

beforeAll(async () => {
  await startTestDatabase("fee-bulk-create");
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

  await AcademicUnit.syncIndexes();
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

describe("FeeStructureService.createMany", () => {
  it("creates a draft for every selected unit", async () => {
    const result = await FeeStructureService.createMany("INS0001", input(), actor);

    expect(result.created).toBe(2);
    expect(result.skipped).toHaveLength(0);

    const rows = await FeeStructure.find({ institutionId: "INS0001" }).lean();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("DRAFT");
      expect(row.publishedAt).toBeUndefined();
    }
  });

  it("skips an already-priced unit and names it by path label", async () => {
    await FeeStructureService.createMany(
      "INS0001",
      input({ academicUnitIds: [unitA.id] }),
      actor,
    );

    const result = await FeeStructureService.createMany(
      "INS0001",
      input({ academicUnitIds: [unitA.id, unitB.id] }),
      actor,
    );

    expect(result.created).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.academicUnitId).toBe(unitA.id);
    expect(result.skipped[0]?.classOrCourse).toBe(unitA.pathLabel);
  });

  // Mutation-proven: removing `academicYear: input.academicYear` from the
  // `existing` query leaves the other five tests in this file green, because
  // every one of them uses a single academic year throughout. This is the one
  // that would fail — a unit priced for year A must still be fresh for year B.
  it("prices a unit for a new academic year even though it is already priced for another", async () => {
    await FeeStructureService.createMany(
      "INS0001",
      input({ academicUnitIds: [unitA.id], academicYear: "2025-26" }),
      actor,
    );

    const result = await FeeStructureService.createMany(
      "INS0001",
      input({ academicUnitIds: [unitA.id], academicYear: "2026-27" }),
      actor,
    );

    expect(result.created).toBe(1);
    expect(result.skipped).toHaveLength(0);

    const rows = await FeeStructure.find({ institutionId: "INS0001" }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.academicYear).sort()).toEqual(["2025-26", "2026-27"]);
  });

  it("returns created: 0 with every unit skipped when all are already priced", async () => {
    await FeeStructureService.createMany("INS0001", input(), actor);

    const result = await FeeStructureService.createMany("INS0001", input(), actor);

    expect(result.created).toBe(0);
    expect(result.skipped).toHaveLength(2);
    const skippedIds = result.skipped.map((row) => row.academicUnitId).sort();
    expect(skippedIds).toEqual([unitA.id, unitB.id].sort());
  });

  it("fails the whole batch with NOT_FOUND for a foreign academicUnitId, writing nothing", async () => {
    await expect(
      FeeStructureService.createMany(
        "INS0001",
        input({ academicUnitIds: [unitA.id, foreignUnit.id] }),
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The only assertion that catches a batch which half-applies before
    // failing: unitA must NOT have been written even though it is valid.
    expect(await FeeStructure.countDocuments({})).toBe(0);
  });

  it("fails with NOT_FOUND, never a 500, for a malformed academicUnitId", async () => {
    await expect(
      FeeStructureService.createMany(
        "INS0001",
        input({ academicUnitIds: [unitA.id, "not-an-object-id"] }),
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await FeeStructure.countDocuments({})).toBe(0);
  });

  it("refuses duplicate line-item labels before anything is written", async () => {
    await expect(
      FeeStructureService.createMany(
        "INS0001",
        input({
          lineItems: [
            { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
            { label: "Tuition", amount: 1000, frequency: "ONE_TIME" },
          ],
        }),
        actor,
      ),
    ).rejects.toThrow(/appears more than once/i);

    expect(await FeeStructure.countDocuments({})).toBe(0);
  });

  it("treats a duplicate raced in between the `existing` read and `insertMany` as a skip, not a crash", async () => {
    // Makes the race deterministic instead of timing-dependent: the `existing`
    // query is the one read `createMany` does before deciding what is fresh, so
    // wrapping ITS `exec` lets a "competing request" insert a document for unitB
    // right after that read comes back empty-handed — landing exactly in the
    // window the plan's Global Constraint worries about, every time this runs.
    // `Model.find` is heavily overloaded; a plain cast to a single simple
    // signature keeps the mock's own body readable without fighting overload
    // resolution, and `as typeof FeeStructure.find` re-widens it back for
    // `vi.spyOn` at the point it is actually installed below.
    const originalFind = FeeStructure.find.bind(FeeStructure) as (
      filter?: Record<string, unknown>,
    ) => ReturnType<typeof FeeStructure.find>;
    const findSpy = vi.spyOn(FeeStructure, "find").mockImplementation(((
      filter?: Record<string, unknown>,
    ) => {
      const query = originalFind(filter);
      if (filter && "academicYear" in filter) {
        const patched = query as unknown as { exec: (...execArgs: unknown[]) => Promise<unknown> };
        const originalExec = patched.exec.bind(patched);
        patched.exec = async (...execArgs: unknown[]) => {
          const rows = await originalExec(...execArgs);
          // The competing write: another admin's request lands for unitB, for
          // the very same year this call is about to price it for, AFTER this
          // call has already read `existing` and decided unitB looks fresh.
          await FeeStructure.create({
            institutionId: "INS0001",
            academicUnitId: unitB.id,
            academicYear: "2026-27",
            status: "DRAFT",
          });
          return rows;
        };
      }
      return query;
    }) as typeof FeeStructure.find);

    try {
      const result = await FeeStructureService.createMany("INS0001", input(), actor);

      // No throw — the caller sees the normal {created, skipped} shape, never
      // the opaque 409 an unhandled E11000 used to produce.
      expect(result.created).toBe(1);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.academicUnitId).toBe(unitB.id);
      expect(result.skipped[0]?.classOrCourse).toBe(unitB.pathLabel);

      // `created` matches what the database actually holds for this call: the
      // raced-in doc plus the one this call made it past the collision to write.
      const rows = await FeeStructure.find({ institutionId: "INS0001" }).lean();
      expect(rows).toHaveLength(2);
      expect(result.created).toBe(rows.length - 1);

      const entries = await Activity.find({
        institutionId: "INS0001",
        entityType: "FEE_STRUCTURE",
        action: "Fee structures created in bulk",
      }).lean();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.description).toBe("1 created, 1 skipped for 2026-27");
    } finally {
      findSpy.mockRestore();
    }
  });
});

describe("POST /api/settings/fees/bulk — the route's security boundary", () => {
  it("an admin bulk-creates over HTTP — 200 with the correct created count", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createBulk(
      cookieRequest({ body: input(), origin: "http://localhost" }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.created).toBe(2);
    expect(payload.skipped).toHaveLength(0);
  });

  it("turns away everyone but an institution admin: 401 anonymous, 403 Counselor, Front Desk, and a platform admin", async () => {
    const anon = await createBulk(cookieRequest({ body: input(), origin: "http://localhost" }));
    expect(anon.status).toBe(401);

    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const counselor = await createBulk(
      cookieRequest({ body: input(), origin: "http://localhost" }),
    );
    expect(counselor.status).toBe(403);
    // The CODE, not just the status: DEFAULT_STATUS maps both FORBIDDEN and
    // INACTIVE_INSTITUTION to 403, so a bare status check cannot tell the role
    // gate firing from some other 403 branch firing in its place.
    expect((await counselor.json()).error.code).toBe("FORBIDDEN");
    (await cookies()).delete(SESSION_COOKIE);

    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");
    const frontDesk = await createBulk(
      cookieRequest({ body: input(), origin: "http://localhost" }),
    );
    expect(frontDesk.status).toBe(403);
    expect((await frontDesk.json()).error.code).toBe("FORBIDDEN");
    (await cookies()).delete(SESSION_COOKIE);

    await signInPlatformAdmin();
    const platformAdmin = await createBulk(
      cookieRequest({ body: input(), origin: "http://localhost" }),
    );
    expect(platformAdmin.status).toBe(403);
    expect((await platformAdmin.json()).error.code).toBe("FORBIDDEN");
  });

  it("a foreign academicUnitId returns 404 with error.code NOT_FOUND — never 403", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createBulk(
      cookieRequest({
        body: input({ academicUnitIds: [unitA.id, foreignUnit.id] }),
        origin: "http://localhost",
      }),
    );

    expect(response.status).toBe(404);
    const payload = await response.json();
    expect(payload.error.code).toBe("NOT_FOUND");
  });

  it("a cross-origin write is rejected with 403 FORBIDDEN", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createBulk(
      cookieRequest({ body: input(), origin: "http://evil.example" }),
    );

    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload.error.code).toBe("FORBIDDEN");
  });
});
