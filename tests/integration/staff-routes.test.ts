import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { GET as listStaff, POST as createStaff } from "@/app/api/staff/route";
import { PATCH as patchStaff } from "@/app/api/staff/[id]/route";
import { StaffService } from "@/services/staff.service";
import type { NextRequest } from "next/server";

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/staff");
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

async function signIn(institutionId: string, role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK", email: string) {
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
}

beforeAll(() => startTestDatabase("staff-routes"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("staff routes", () => {
  it("an admin can create a staff account over HTTP", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createStaff(
      cookieRequest({
        body: { name: "Priya", email: "priya@infinityschool.edu.in", password: "Password!2026", role: "COUNSELOR" },
        origin: "http://localhost",
      }),
    );
    expect(response.status).toBe(201);
  });

  it("a Counselor cannot create a staff account — 403", async () => {
    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");

    const response = await createStaff(
      cookieRequest({
        body: { name: "Priya", email: "priya@infinityschool.edu.in", password: "Password!2026", role: "COUNSELOR" },
        origin: "http://localhost",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk user cannot list staff — 403", async () => {
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");
    const response = await listStaff();
    expect(response.status).toBe(403);
  });

  it("an admin can deactivate a staff account over HTTP", async () => {
    const staff = await StaffService.create("INS0001", {
      name: "Priya",
      email: "priya@infinityschool.edu.in",
      password: "Password!2026",
      role: "COUNSELOR",
    });
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await patchStaff(
      cookieRequest({ url: `http://localhost/api/staff/${staff.id}`, body: { active: false }, origin: "http://localhost" }),
      { params: Promise.resolve({ id: staff.id }) } as never,
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.staff.active).toBe(false);
  });
});
