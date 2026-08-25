import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { GET as listFees, POST as createFee } from "@/app/api/settings/fees/route";
import {
  DELETE as deleteFee,
  GET as getFee,
  PATCH as patchFee,
} from "@/app/api/settings/fees/[feeId]/route";
import { POST as publishFee } from "@/app/api/settings/fees/[feeId]/publish/route";
import { FeeStructureService } from "@/services/fee-structure.service";
import { AcademicStructureService, type AcademicUnitDTO } from "@/services/academic-structure.service";
import { AcademicUnit } from "@/models";
import type { NextRequest } from "next/server";

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/fees");
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
async function signInPlatformAdmin(email = "platform-fees@example.test") {
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
let foreignUnit: AcademicUnitDTO;

function input(
  overrides: {
    academicUnitId?: string;
    academicYear?: string;
    lineItems?: Array<{ label: string; amount: number; frequency: "ONE_TIME" | "ANNUAL"; optional?: boolean }>;
  } = {},
) {
  return {
    academicUnitId: unitA.id,
    academicYear: "2026-27",
    lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" as const }],
    ...overrides,
  };
}

beforeAll(() => startTestDatabase("fee-structure-routes"));
afterAll(stopTestDatabase);
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
  foreignUnit = await AcademicStructureService.create(
    "INS0002",
    { segment: "SCHOOL", name: "Grade 10" },
    actor,
  );
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("fee structure routes — admin CRUD over real HTTP", () => {
  it("an admin can create a fee structure — 201", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createFee(cookieRequest({ body: input(), origin: "http://localhost" }));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.feeStructure.classOrCourse).toBe("Grade 10");

    // A unit belonging to another institution is "no such unit" — NOT_FOUND, never
    // FORBIDDEN, and never a 500.
    const foreign = await createFee(
      cookieRequest({
        body: input({ academicUnitId: foreignUnit.id }),
        origin: "http://localhost",
      }),
    );
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.code).toBe("NOT_FOUND");
  });

  it("an admin can list, read, update, and delete their own fee structure", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    const created = await FeeStructureService.create("INS0001", input(), actor);

    const listResponse = await listFees();
    expect((await listResponse.json()).feeStructures).toHaveLength(1);

    const getResponse = await getFee(
      cookieRequest({ url: `http://localhost/api/settings/fees/${created.id}` }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(getResponse.status).toBe(200);

    const patchResponse = await patchFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}`,
        body: { academicYear: "2027-28" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(patchResponse.status).toBe(200);
    expect((await patchResponse.json()).feeStructure.academicYear).toBe("2027-28");

    const deleteResponse = await deleteFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(deleteResponse.status).toBe(200);
  });

  it("an admin can publish a fee structure", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    const created = await FeeStructureService.create("INS0001", input(), actor);

    const publishResponse = await publishFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}/publish`,
        body: { action: "publish" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(publishResponse.status).toBe(200);
    expect((await publishResponse.json()).feeStructure.status).toBe("PUBLISHED");
  });

  it("a fee structure from another institution 404s on GET, PATCH and DELETE — never 403", async () => {
    await signIn("INS0002", "INSTITUTION_ADMIN", "admin@intelligentpublic.edu.in");
    const created = await FeeStructureService.create("INS0001", input(), actor);

    const getResponse = await getFee(
      cookieRequest({ url: `http://localhost/api/settings/fees/${created.id}` }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(getResponse.status).toBe(404);

    const patchResponse = await patchFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}`,
        body: { academicYear: "2027-28" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(patchResponse.status).toBe(404);

    const deleteResponse = await deleteFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(deleteResponse.status).toBe(404);
  });

  it("a fee structure from another institution 404s on publish — never 403", async () => {
    await signIn("INS0002", "INSTITUTION_ADMIN", "admin@intelligentpublic.edu.in");
    const created = await FeeStructureService.create("INS0001", input(), actor);

    const response = await publishFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}/publish`,
        body: { action: "publish" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(response.status).toBe(404);
  });
});

describe("fee structure routes — Counselor and Front Desk are refused on every route", () => {
  it("a Counselor session gets 403 listing fee structures", async () => {
    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const response = await listFees();
    expect(response.status).toBe(403);
  });

  it("a Counselor session gets 403 creating a fee structure", async () => {
    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const response = await createFee(cookieRequest({ body: input(), origin: "http://localhost" }));
    expect(response.status).toBe(403);
  });

  it("a Front Desk session gets 403 reading a fee structure", async () => {
    const created = await FeeStructureService.create("INS0001", input(), actor);
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await getFee(
      cookieRequest({ url: `http://localhost/api/settings/fees/${created.id}` }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk session gets 403 updating a fee structure", async () => {
    const created = await FeeStructureService.create("INS0001", input(), actor);
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await patchFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}`,
        body: { academicYear: "2027-28" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(response.status).toBe(403);
  });

  it("a Counselor session gets 403 deleting a fee structure", async () => {
    const created = await FeeStructureService.create("INS0001", input(), actor);
    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");

    const response = await deleteFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk session gets 403 publishing a fee structure", async () => {
    const created = await FeeStructureService.create("INS0001", input(), actor);
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await publishFee(
      cookieRequest({
        url: `http://localhost/api/settings/fees/${created.id}/publish`,
        body: { action: "publish" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ feeId: created.id }) } as never,
    );
    expect(response.status).toBe(403);
  });

  it("rejects a SUPER_ADMIN caller — the platform admin has no route to fee structures", async () => {
    await signInPlatformAdmin();

    const response = await listFees();
    expect(response.status).toBe(403);
  });
});
