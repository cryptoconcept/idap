import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeApiClient, makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { PATCH as patchInstitution } from "@/app/api/settings/institution/route";
import { POST as publishResults } from "@/app/api/settings/results/route";
import { GET as listApiClients } from "@/app/api/api-clients/route";
import { DELETE as revokeApiClient } from "@/app/api/api-clients/[id]/route";
import { ApiClient } from "@/models";
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

async function signIn(role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK", email: string) {
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

/**
 * These two routes stop at `requireUser()`. That used to be the same thing as
 * "is an Institution Admin", because no other institution-side role existed —
 * `credentialScope` hands any non-platform user their own institution. With
 * Counselor and Front Desk accounts in the picture it no longer is: revoking a
 * credential takes the institution's website integration offline.
 */
describe("API credential routes are closed to the new roles", () => {
  it("a Counselor session cannot list API credentials — 403", async () => {
    await makeApiClient("INS0001");
    await signIn("COUNSELOR", "c@infinityschool.edu.in");

    const response = await listApiClients(
      cookieRequest({ url: "http://localhost/api/api-clients", origin: "http://localhost" }),
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk session cannot revoke an API credential — 403, and the key stays live", async () => {
    const { client } = await makeApiClient("INS0001");
    await signIn("FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await revokeApiClient(
      cookieRequest({
        url: `http://localhost/api/api-clients/${String(client._id)}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: String(client._id) }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await ApiClient.findById(client._id).lean())!.active).toBe(true);
  });

  it("a Counselor session cannot revoke an API credential — 403", async () => {
    const { client } = await makeApiClient("INS0001");
    await signIn("COUNSELOR", "c@infinityschool.edu.in");

    const response = await revokeApiClient(
      cookieRequest({
        url: `http://localhost/api/api-clients/${String(client._id)}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: String(client._id) }) } as never,
    );

    expect(response.status).toBe(403);
    expect((await ApiClient.findById(client._id).lean())!.active).toBe(true);
  });

  it("an Institution Admin can still list and revoke their own credentials", async () => {
    // The control for all three refusals above: a route that turned everyone
    // away would satisfy them just as well.
    const { client } = await makeApiClient("INS0001");
    await signIn("INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const listed = await listApiClients(
      cookieRequest({ url: "http://localhost/api/api-clients", origin: "http://localhost" }),
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()).clients).toHaveLength(1);

    const revoked = await revokeApiClient(
      cookieRequest({
        url: `http://localhost/api/api-clients/${String(client._id)}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: String(client._id) }) } as never,
    );
    expect(revoked.status).toBe(200);
    expect((await ApiClient.findById(client._id).lean())!.active).toBe(false);
  });
});
