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
