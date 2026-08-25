import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { GET as getStructure } from "@/app/api/settings/academic-structure/route";
import { PUT as putSegments } from "@/app/api/settings/academic-structure/segments/route";
import { POST as createUnit } from "@/app/api/settings/academic-structure/units/route";
import {
  DELETE as deleteUnit,
  PATCH as patchUnit,
} from "@/app/api/settings/academic-structure/units/[unitId]/route";
import { POST as reorderUnits } from "@/app/api/settings/academic-structure/reorder/route";
import { POST as seedStructure } from "@/app/api/settings/academic-structure/seed/route";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { AcademicUnit } from "@/models";

function cookieRequest(init: { body?: unknown; origin?: string } = {}) {
  const url = new URL("http://localhost/api/settings/academic-structure");
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

const ORIGIN = "http://localhost";

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
async function signInPlatformAdmin(email = "platform-academic@example.test") {
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
const unitContext = (unitId: string) =>
  ({ params: Promise.resolve({ unitId }) }) as unknown as never;

beforeAll(async () => {
  await startTestDatabase("academic-structure-routes");
  await AcademicUnit.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("academic structure routes — admin access", () => {
  it("returns segments, every available segment, every blueprint, and the units", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    await AcademicStructureService.create("INS0001", { segment: "SCHOOL", name: "Grade 1" }, actor);

    const payload = await (await getStructure()).json();

    expect(payload.success).toBe(true);
    expect(payload.segments).toEqual(["SCHOOL"]);
    expect(payload.availableSegments).toContain("UNIVERSITY");
    // The whole map, not just the selected segments': the checkbox row has to
    // label segments the institution has not ticked.
    expect(payload.blueprints.UNIVERSITY.levels).toHaveLength(4);
    expect(payload.units).toHaveLength(1);
  });

  it("creates a unit — 201", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createUnit(
      cookieRequest({ body: { segment: "SCHOOL", name: "Grade 1" }, origin: ORIGIN }),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).unit.pathLabel).toBe("Grade 1");
  });

  it("patches, reorders, seeds and deletes for its own institution", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    const one = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 1" },
      actor,
    );
    const two = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 2" },
      actor,
    );

    const patched = await patchUnit(
      cookieRequest({ body: { name: "Class 1" }, origin: ORIGIN }),
      unitContext(one.id),
    );
    expect((await patched.json()).unit.name).toBe("Class 1");

    const reordered = await reorderUnits(
      cookieRequest({
        body: { segment: "SCHOOL", parentId: null, orderedIds: [two.id, one.id] },
        origin: ORIGIN,
      }),
    );
    expect((await reordered.json()).units.map((u: { name: string }) => u.name)).toEqual([
      "Grade 2",
      "Class 1",
    ]);

    const deleted = await deleteUnit(cookieRequest({ origin: ORIGIN }), unitContext(one.id));
    expect((await deleted.json()).deleted).toBe(1);
  });

  it("replaces the segment selection, and refuses to drop one still holding units", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    await AcademicStructureService.create("INS0001", { segment: "SCHOOL", name: "Grade 1" }, actor);

    const widened = await putSegments(
      cookieRequest({ body: { segments: ["PRE_UNIVERSITY", "SCHOOL"] }, origin: ORIGIN }),
    );
    expect((await widened.json()).segments).toEqual(["SCHOOL", "PRE_UNIVERSITY"]);

    const narrowed = await putSegments(
      cookieRequest({ body: { segments: ["PRE_UNIVERSITY"] }, origin: ORIGIN }),
    );
    expect(narrowed.status).toBe(400);
  });

  it("seeds from the profile", async () => {
    await makeInstitution("INS0009", { academic: { classesOffered: ["Grade 1", "Grade 2"] } });
    await signIn("INS0009", "INSTITUTION_ADMIN", "admin@ins0009.edu.in");

    const response = await seedStructure(cookieRequest({ origin: ORIGIN }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: 2, skipped: 0 });
  });
});

describe("academic structure routes — who is turned away", () => {
  it("rejects an anonymous caller on every route", async () => {
    expect((await getStructure()).status).toBe(401);
    expect((await createUnit(cookieRequest({ origin: ORIGIN }))).status).toBe(401);
    expect((await putSegments(cookieRequest({ origin: ORIGIN }))).status).toBe(401);
    expect((await reorderUnits(cookieRequest({ origin: ORIGIN }))).status).toBe(401);
    expect((await seedStructure(cookieRequest({ origin: ORIGIN }))).status).toBe(401);
    expect(
      (await patchUnit(cookieRequest({ origin: ORIGIN }), unitContext("6a887abd755db527bea51204")))
        .status,
    ).toBe(401);
    expect(
      (await deleteUnit(cookieRequest({ origin: ORIGIN }), unitContext("6a887abd755db527bea51204")))
        .status,
    ).toBe(401);
  });

  it("rejects a Counselor and a Front Desk session", async () => {
    await signIn("INS0001", "COUNSELOR", "counselor@infinityschool.edu.in");
    expect((await getStructure()).status).toBe(403);
    expect(
      (await createUnit(cookieRequest({ body: { segment: "SCHOOL", name: "X" }, origin: ORIGIN })))
        .status,
    ).toBe(403);

    (await cookies()).delete(SESSION_COOKIE);
    await signIn("INS0001", "FRONT_DESK", "desk@infinityschool.edu.in");
    expect((await getStructure()).status).toBe(403);
    expect((await putSegments(cookieRequest({ body: { segments: ["SCHOOL"] }, origin: ORIGIN })))
      .status).toBe(403);
  });

  it("rejects the platform admin, who has no route into tenant data", async () => {
    await signInPlatformAdmin();

    expect((await getStructure()).status).toBe(403);
    expect(
      (await createUnit(cookieRequest({ body: { segment: "SCHOOL", name: "X" }, origin: ORIGIN })))
        .status,
    ).toBe(403);
    expect((await seedStructure(cookieRequest({ origin: ORIGIN }))).status).toBe(403);
  });

  it("answers NOT_FOUND, never FORBIDDEN, for another institution's unit", async () => {
    const theirs = await AcademicStructureService.create(
      "INS0002",
      { segment: "SCHOOL", name: "Grade 1" },
      actor,
    );
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const patched = await patchUnit(
      cookieRequest({ body: { name: "Mine now" }, origin: ORIGIN }),
      unitContext(theirs.id),
    );
    expect(patched.status).toBe(404);
    expect((await patched.json()).error.code).toBe("NOT_FOUND");

    const deleted = await deleteUnit(cookieRequest({ origin: ORIGIN }), unitContext(theirs.id));
    expect(deleted.status).toBe(404);

    // A foreign parent is "no such parent", not "not yours".
    const created = await createUnit(
      cookieRequest({ body: { segment: "SCHOOL", parentId: theirs.id, name: "X" }, origin: ORIGIN }),
    );
    expect(created.status).toBe(404);
    expect((await created.json()).error.code).toBe("NOT_FOUND");
  });

  it("rejects a cross-origin write", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createUnit(
      cookieRequest({ body: { segment: "SCHOOL", name: "X" }, origin: "http://evil.test" }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
  });
});
