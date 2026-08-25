import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { GET as getFeeHeads, PUT as putFeeHeads } from "@/app/api/settings/fees/heads/route";
import { GET as getFee } from "@/app/api/settings/fees/[feeId]/route";
import type { NextRequest } from "next/server";

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/fees/heads");
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
async function signInPlatformAdmin(email = "platform-fee-heads@example.test") {
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

beforeAll(() => startTestDatabase("fee-heads"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("fee heads routes — admin read/replace over real HTTP", () => {
  it("an admin can save heads and read them back", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const putResponse = await putFeeHeads(
      cookieRequest({
        body: {
          feeHeads: [
            { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
            { label: "Admission", amount: 5000, frequency: "ONE_TIME" },
          ],
        },
        origin: "http://localhost",
      }),
    );
    expect(putResponse.status).toBe(200);
    const putPayload = await putResponse.json();
    expect(putPayload.feeHeads).toHaveLength(2);

    const getResponse = await getFeeHeads();
    expect(getResponse.status).toBe(200);
    const getPayload = await getResponse.json();
    expect(getPayload.feeHeads).toEqual([
      { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
      { label: "Admission", amount: 5000, frequency: "ONE_TIME" },
    ]);
  });

  it("a head with no amount round-trips with amount and frequency both undefined", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const putResponse = await putFeeHeads(
      cookieRequest({
        body: { feeHeads: [{ label: "Library" }] },
        origin: "http://localhost",
      }),
    );
    expect(putResponse.status).toBe(200);

    const getResponse = await getFeeHeads();
    const payload = await getResponse.json();
    expect(payload.feeHeads).toHaveLength(1);
    expect(payload.feeHeads[0].label).toBe("Library");
    expect(payload.feeHeads[0].amount).toBeUndefined();
    expect(payload.feeHeads[0].frequency).toBeUndefined();
  });

  it("saving replaces the list wholesale", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    await putFeeHeads(
      cookieRequest({
        body: {
          feeHeads: [
            { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
            { label: "Admission", amount: 5000, frequency: "ONE_TIME" },
            { label: "Transport", amount: 12000, frequency: "ANNUAL" },
          ],
        },
        origin: "http://localhost",
      }),
    );

    const secondPut = await putFeeHeads(
      cookieRequest({
        body: { feeHeads: [{ label: "Tuition", amount: 65000, frequency: "ANNUAL" }] },
        origin: "http://localhost",
      }),
    );
    expect(secondPut.status).toBe(200);

    const getResponse = await getFeeHeads();
    const payload = await getResponse.json();
    expect(payload.feeHeads).toEqual([{ label: "Tuition", amount: 65000, frequency: "ANNUAL" }]);
  });

  it("heads are per-institution: INS0002 saving does not change INS0001's list", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    await putFeeHeads(
      cookieRequest({
        body: { feeHeads: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }] },
        origin: "http://localhost",
      }),
    );
    (await cookies()).delete(SESSION_COOKIE);

    await signIn("INS0002", "INSTITUTION_ADMIN", "admin@intelligentpublic.edu.in");
    await putFeeHeads(
      cookieRequest({
        body: { feeHeads: [{ label: "Bus Fee", amount: 8000, frequency: "ANNUAL" }] },
        origin: "http://localhost",
      }),
    );
    const ins0002Get = await getFeeHeads();
    expect((await ins0002Get.json()).feeHeads).toEqual([
      { label: "Bus Fee", amount: 8000, frequency: "ANNUAL" },
    ]);
    (await cookies()).delete(SESSION_COOKIE);

    await signIn("INS0001", "INSTITUTION_ADMIN", "admin2@infinityschool.edu.in");
    const ins0001Get = await getFeeHeads();
    expect((await ins0001Get.json()).feeHeads).toEqual([
      { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
    ]);
  });

  it("the static heads route resolves ahead of the dynamic [feeId] route", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await getFeeHeads();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(Array.isArray(payload.feeHeads)).toBe(true);
    expect(payload.error).toBeUndefined();

    // Had the request instead been dispatched to the dynamic [feeId] handler
    // with the literal segment "heads" as the id, it would 404 as an
    // unrecognised fee structure — the failure mode this route must avoid.
    const asFeeId = await getFee(
      cookieRequest({ url: "http://localhost/api/settings/fees/heads" }),
      { params: Promise.resolve({ feeId: "heads" }) } as never,
    );
    expect(asFeeId.status).toBe(404);
    expect((await asFeeId.json()).error.code).toBe("NOT_FOUND");
  });
});

describe("GET/PUT /api/settings/fees/heads — the route's security boundary", () => {
  it("PUT turns away everyone but an institution admin: 401 anonymous, 403 Counselor, Front Desk, and a platform admin", async () => {
    const anon = await putFeeHeads(
      cookieRequest({ body: { feeHeads: [] }, origin: "http://localhost" }),
    );
    expect(anon.status).toBe(401);

    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const counselor = await putFeeHeads(
      cookieRequest({ body: { feeHeads: [] }, origin: "http://localhost" }),
    );
    expect(counselor.status).toBe(403);
    // The CODE, not just the status: more than one code maps to 403, so a bare
    // status check cannot tell this gate firing from some other 403 arriving in
    // its place. (`requireInstitution` itself throws FORBIDDEN on every branch —
    // role, missing, and inactive alike — so what the code pins here is that the
    // 403 came from the auth gate at all, not which of its branches produced it.)
    expect((await counselor.json()).error.code).toBe("FORBIDDEN");
    (await cookies()).delete(SESSION_COOKIE);

    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");
    const frontDesk = await putFeeHeads(
      cookieRequest({ body: { feeHeads: [] }, origin: "http://localhost" }),
    );
    expect(frontDesk.status).toBe(403);
    expect((await frontDesk.json()).error.code).toBe("FORBIDDEN");
    (await cookies()).delete(SESSION_COOKIE);

    await signInPlatformAdmin();
    const platformAdmin = await putFeeHeads(
      cookieRequest({ body: { feeHeads: [] }, origin: "http://localhost" }),
    );
    expect(platformAdmin.status).toBe(403);
    expect((await platformAdmin.json()).error.code).toBe("FORBIDDEN");
  });

  it("PUT: a cross-origin write is rejected with 403 FORBIDDEN", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await putFeeHeads(
      cookieRequest({ body: { feeHeads: [] }, origin: "http://evil.example" }),
    );

    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload.error.code).toBe("FORBIDDEN");
  });

  it("GET turns away everyone but an institution admin: 401 anonymous, 403 Counselor, Front Desk, and a platform admin", async () => {
    const anon = await getFeeHeads();
    expect(anon.status).toBe(401);

    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const counselor = await getFeeHeads();
    expect(counselor.status).toBe(403);
    expect((await counselor.json()).error.code).toBe("FORBIDDEN");
    (await cookies()).delete(SESSION_COOKIE);

    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");
    const frontDesk = await getFeeHeads();
    expect(frontDesk.status).toBe(403);
    expect((await frontDesk.json()).error.code).toBe("FORBIDDEN");
    (await cookies()).delete(SESSION_COOKIE);

    await signInPlatformAdmin();
    const platformAdmin = await getFeeHeads();
    expect(platformAdmin.status).toBe(403);
    expect((await platformAdmin.json()).error.code).toBe("FORBIDDEN");
  });
});
