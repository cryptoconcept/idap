import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { GET as listResults, POST as createResult } from "@/app/api/settings/results/route";
import { GET as getResult } from "@/app/api/settings/results/[resultId]/route";
import { POST as publishResult } from "@/app/api/settings/results/[resultId]/publish/route";
import { ResultService } from "@/services/result.service";
import { Result } from "@/models";
import type { NextRequest } from "next/server";

const cycle = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  stream: null,
  academicYear: "2025-26",
  appeared: 142,
  passed: 140,
};

/** A request carrying only a session cookie, like the web dashboard. */
function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/results");
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

async function signInWithCookie(institutionId: string, email = "results-admin@example.test") {
  const user = await makeUser(institutionId, "INSTITUTION_ADMIN", email);
  const token = await signSession({
    sub: String(user._id),
    role: "INSTITUTION_ADMIN",
    institutionId,
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
}

/** Platform-admin session: no institutionId, role SUPER_ADMIN — the 403 case. */
async function signInPlatformAdmin(email = "platform-results@example.test") {
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

beforeAll(async () => {
  await startTestDatabase("results-routes");
  // Mongoose builds indexes in the background; without waiting for it here,
  // the very first duplicate-cycle write can race ahead of the unique index
  // actually existing on the server. Same pattern as results-crud.test.ts,
  // slug.test.ts and institution-model.test.ts for the same reason.
  await Result.syncIndexes();
});
afterAll(stopTestDatabase);

beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

// The cookie store is module-level, so a session left behind would silently
// authenticate the tests that expect no credentials at all.
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("institute-admin results routes", () => {
  it("creates a cycle over HTTP", async () => {
    await signInWithCookie("INS0001");

    const response = await createResult(
      cookieRequest({ body: cycle, origin: "http://localhost" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.result.status).toBe("DRAFT");
  });

  it("maps a duplicate cycle to CONFLICT rather than a 500", async () => {
    await signInWithCookie("INS0001");

    await createResult(cookieRequest({ body: cycle, origin: "http://localhost" }));
    const response = await createResult(
      cookieRequest({ body: cycle, origin: "http://localhost" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("CONFLICT");
  });

  it("rejects a body that violates an invariant", async () => {
    await signInWithCookie("INS0001");

    const response = await createResult(
      cookieRequest({ body: { ...cycle, appeared: 10, passed: 11 }, origin: "http://localhost" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("lists only the caller's cycles", async () => {
    await ResultService.create("INS0001", cycle, { id: "u", name: "n" });
    await ResultService.create("INS0002", cycle, { id: "u", name: "n" });

    await signInWithCookie("INS0001");
    const payload = await (await listResults()).json();

    expect(payload.results).toHaveLength(1);
  });

  it("returns 404 for another institution's result", async () => {
    const created = await ResultService.create("INS0001", cycle, { id: "u", name: "n" });

    await signInWithCookie("INS0002");
    const response = await getResult(new Request("http://localhost") as never, {
      params: Promise.resolve({ resultId: created.id }),
    } as never);

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  it("publishes through the publish route", async () => {
    const created = await ResultService.create("INS0001", cycle, { id: "u", name: "n" });

    await signInWithCookie("INS0001");
    const response = await publishResult(
      cookieRequest({
        url: "http://localhost/api/settings/results/x/publish",
        body: { action: "publish" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ resultId: created.id }) } as never,
    );

    expect((await response.json()).result.status).toBe("PUBLISHED");
  });

  it("rejects an unknown publish action", async () => {
    const created = await ResultService.create("INS0001", cycle, { id: "u", name: "n" });

    await signInWithCookie("INS0001");
    const response = await publishResult(
      cookieRequest({
        url: "http://localhost/api/settings/results/x/publish",
        body: { action: "delete-everything" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ resultId: created.id }) } as never,
    );

    expect(response.status).toBe(400);
  });

  it("rejects a SUPER_ADMIN caller — the platform admin has no route to results", async () => {
    await signInPlatformAdmin();

    const response = await listResults();
    expect(response.status).toBe(403);
  });
});
