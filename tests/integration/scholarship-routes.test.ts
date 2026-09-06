import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { GET as listScholarships, POST as createScholarship } from "@/app/api/settings/scholarships/route";
import {
  DELETE as deleteScholarship,
  GET as getScholarship,
  PATCH as patchScholarship,
} from "@/app/api/settings/scholarships/[scholarshipId]/route";
import { POST as publishScholarship } from "@/app/api/settings/scholarships/[scholarshipId]/publish/route";
import { ScholarshipService } from "@/services/scholarship.service";
import { AcademicStructureService } from "@/services/academic-structure.service";
import type { NextRequest } from "next/server";

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/scholarships");
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

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

function input(overrides: { name?: string; criteria?: string; amount?: string } = {}) {
  return {
    name: "Merit Scholarship",
    criteria: "Top 10% of the class",
    amount: "₹50,000",
    ...overrides,
  };
}

beforeAll(() => startTestDatabase("scholarship-routes"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("scholarship routes — admin CRUD over real HTTP", () => {
  it("GET (collection) returns only the calling institution's scholarships", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    await ScholarshipService.create("INS0001", input(), actor);
    await ScholarshipService.create(
      "INS0002",
      input({ name: "Other Institution Scholarship" }),
      actor,
    );

    const response = await listScholarships();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.scholarships).toHaveLength(1);
    expect(payload.scholarships[0].name).toBe("Merit Scholarship");
  });

  it("GET (item) returns one; another institution's id returns 404", async () => {
    const created = await ScholarshipService.create("INS0001", input(), actor);
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const ownResponse = await getScholarship(
      cookieRequest({ url: `http://localhost/api/settings/scholarships/${created.id}` }),
      { params: Promise.resolve({ scholarshipId: created.id }) } as never,
    );
    expect(ownResponse.status).toBe(200);
    expect((await ownResponse.json()).scholarship.name).toBe("Merit Scholarship");

    (await cookies()).delete(SESSION_COOKIE);
    await signIn("INS0002", "INSTITUTION_ADMIN", "admin@intelligentpublic.edu.in");

    const foreignResponse = await getScholarship(
      cookieRequest({ url: `http://localhost/api/settings/scholarships/${created.id}` }),
      { params: Promise.resolve({ scholarshipId: created.id }) } as never,
    );
    expect(foreignResponse.status).toBe(404);
  });

  it("POST creates one and returns 201", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createScholarship(
      cookieRequest({ body: input(), origin: "http://localhost" }),
    );
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.scholarship.name).toBe("Merit Scholarship");
    expect(payload.scholarship.status).toBe("DRAFT");
  });

  it("POST without a same-origin header is refused — the write never lands", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createScholarship(
      cookieRequest({ body: input(), origin: "http://evil.example" }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(600);

    // The status code alone proves nothing if the handler wrote anyway before
    // returning it — so also assert the row was never created.
    const after = await ScholarshipService.list("INS0001");
    expect(after).toHaveLength(0);
  });

  it("PATCH updates one", async () => {
    const created = await ScholarshipService.create("INS0001", input(), actor);
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await patchScholarship(
      cookieRequest({
        url: `http://localhost/api/settings/scholarships/${created.id}`,
        body: { amount: "₹75,000" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ scholarshipId: created.id }) } as never,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).scholarship.amount).toBe("₹75,000");
  });

  it("PATCH with academicUnitId: null clears an existing scope", async () => {
    const unit = await AcademicStructureService.create(
      "INS0001",
      { segment: "SCHOOL", name: "Grade 10" },
      actor,
    );
    const created = await ScholarshipService.create(
      "INS0001",
      input(),
      actor,
    );
    const scoped = await ScholarshipService.update(
      "INS0001",
      created.id,
      { academicUnitId: unit.id },
      actor,
    );
    expect(scoped.classOrCourse).toBe("Grade 10");
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await patchScholarship(
      cookieRequest({
        url: `http://localhost/api/settings/scholarships/${created.id}`,
        body: { academicUnitId: null },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ scholarshipId: created.id }) } as never,
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.scholarship.academicUnitId).toBeUndefined();
    expect(payload.scholarship.classOrCourse).toBeUndefined();
  });

  it("PATCH on another institution's scholarship returns 404", async () => {
    const created = await ScholarshipService.create("INS0001", input(), actor);
    await signIn("INS0002", "INSTITUTION_ADMIN", "admin@intelligentpublic.edu.in");

    const response = await patchScholarship(
      cookieRequest({
        url: `http://localhost/api/settings/scholarships/${created.id}`,
        body: { amount: "₹75,000" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ scholarshipId: created.id }) } as never,
    );
    expect(response.status).toBe(404);
  });

  it("DELETE removes one", async () => {
    const created = await ScholarshipService.create("INS0001", input(), actor);
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await deleteScholarship(
      cookieRequest({
        url: `http://localhost/api/settings/scholarships/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ scholarshipId: created.id }) } as never,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).deleted).toBe(true);

    const remaining = await ScholarshipService.list("INS0001");
    expect(remaining).toHaveLength(0);
  });

  it("POST …/publish with { action: \"publish\" } publishes", async () => {
    const created = await ScholarshipService.create("INS0001", input(), actor);
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await publishScholarship(
      cookieRequest({
        url: `http://localhost/api/settings/scholarships/${created.id}/publish`,
        body: { action: "publish" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ scholarshipId: created.id }) } as never,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).scholarship.status).toBe("PUBLISHED");
  });

  it("POST …/publish with { action: \"nonsense\" } returns a validation error", async () => {
    const created = await ScholarshipService.create("INS0001", input(), actor);
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await publishScholarship(
      cookieRequest({
        url: `http://localhost/api/settings/scholarships/${created.id}/publish`,
        body: { action: "nonsense" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ scholarshipId: created.id }) } as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
