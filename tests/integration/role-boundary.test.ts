import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { PATCH as patchInstitution } from "@/app/api/settings/institution/route";
import { POST as publishResults } from "@/app/api/settings/results/route";
import type { NextRequest } from "next/server";

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/institution");
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

async function signIn(role: "COUNSELOR" | "FRONT_DESK", email: string) {
  const user = await makeUser("INS0001", role, email);
  const token = await signSession({
    sub: String(user._id),
    role,
    institutionId: "INS0001",
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
}

beforeAll(() => startTestDatabase("role-boundary"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("requireInstitution() still rejects the new roles — unchanged by this phase", () => {
  it("a Counselor session gets 403 patching the institution profile", async () => {
    await signIn("COUNSELOR", "c@infinityschool.edu.in");

    const response = await patchInstitution(
      cookieRequest({ body: { academic: { board: "CBSE" } }, origin: "http://localhost" }),
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk session gets 403 creating a results cycle", async () => {
    await signIn("FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await publishResults(
      cookieRequest({
        url: "http://localhost/api/settings/results",
        body: { board: "CBSE", level: "CLASS_10", stream: null, academicYear: "2025-26", appeared: 10, passed: 10 },
        origin: "http://localhost",
      }),
    );
    expect(response.status).toBe(403);
  });
});
