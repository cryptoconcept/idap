import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { GET as listConnections } from "@/app/api/settings/connections/route";
import { POST as initiateConnection } from "@/app/api/settings/connections/[platform]/initiate/route";
import { POST as refreshConnection } from "@/app/api/settings/connections/[platform]/refresh/route";
import { POST as connectWithKey } from "@/app/api/settings/connections/[platform]/connect-key/route";
import { POST as syncConnection } from "@/app/api/settings/connections/[platform]/sync/route";
import { DELETE as disconnectConnection } from "@/app/api/settings/connections/[platform]/route";
import { GET as listRuns } from "@/app/api/settings/connections/[platform]/runs/route";
import { PlatformConnection, PlatformCredential, SyncRun } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";
import { registerAdapter } from "@/lib/connectors";
import { passpercentAdapter } from "@/lib/connectors/passpercent";
import type { AdapterContext, ConnectionState, PlatformAdapter, SyncSourceData } from "@/lib/connectors/types";

const VALID_VAULT_KEY = Buffer.alloc(32, 3).toString("base64");

type FakeHooks = {
  initiate?: PlatformAdapter["initiate"];
  refresh?: PlatformAdapter["refresh"];
  connectWithKey?: PlatformAdapter["connectWithKey"];
  sync?: PlatformAdapter["sync"];
};

function makeFakeAdapter(hooks: FakeHooks = {}): PlatformAdapter {
  return {
    platform: "PASSPERCENT",
    connectMode: "REQUEST_APPROVE_REDEEM",
    initiate: hooks.initiate,
    refresh: hooks.refresh,
    connectWithKey: hooks.connectWithKey,
    sync: hooks.sync ?? (async () => ({ status: "SUCCESS", steps: [], warnings: [] })),
  };
}

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/connections");
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

function paramsFor(platform: string) {
  return { params: Promise.resolve({ platform }) } as never;
}

async function signIn(institutionId: string, email = "connections-admin@example.test") {
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

async function makeCredential() {
  return PlatformCredential.create({
    platform: "PASSPERCENT",
    keyEncrypted: encryptCredential("pp_pkey_route_test"),
    baseUrl: "https://api.passpercent.test",
    active: true,
  });
}

beforeAll(() => startTestDatabase("connection-routes"));
afterAll(stopTestDatabase);

beforeEach(async () => {
  await clearDatabase();
  process.env.IDAP_CREDENTIAL_KEY = VALID_VAULT_KEY;
  await makeInstitution("INS0001", { city: "Mysore", profileStatus: "PUBLISHED" });
});

afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
  registerAdapter(passpercentAdapter);
  process.env.IDAP_CREDENTIAL_KEY = VALID_VAULT_KEY;
});

describe("connections routes — happy paths", () => {
  it("GET /api/settings/connections lists one entry per platform", async () => {
    await signIn("INS0001");

    const response = await listConnections();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.connections.map((c: { platform: string }) => c.platform).sort()).toEqual([
      "EDUFLEET",
      "FEESBASKET",
      "PASSPERCENT",
      "SCHOLARSHIP_HUB",
    ]);
  });

  it("POST .../[platform]/initiate creates a PENDING connection", async () => {
    registerAdapter(
      makeFakeAdapter({ initiate: async () => ({ remoteRequestId: "req-1", remoteStatus: "pending" }) }),
    );
    await makeCredential();
    await signIn("INS0001");

    const response = await initiateConnection(
      cookieRequest({
        url: "http://localhost/api/settings/connections/PASSPERCENT/initiate",
        origin: "http://localhost",
      }),
      paramsFor("PASSPERCENT"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connection.status).toBe("PENDING");

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.remoteRequestId).toBe("req-1");
  });

  it("POST .../[platform]/refresh transitions the connection", async () => {
    registerAdapter(makeFakeAdapter({ refresh: async () => ({ kind: "AWAITING_APPROVAL", remoteStatus: "awaiting_school" }) }));
    await makeCredential();
    await signIn("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "PENDING",
      externalRef: "INS0001",
      remoteRequestId: "req-1",
    });

    const response = await refreshConnection(
      cookieRequest({
        url: "http://localhost/api/settings/connections/PASSPERCENT/refresh",
        origin: "http://localhost",
      }),
      paramsFor("PASSPERCENT"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connection.status).toBe("AWAITING_APPROVAL");
  });

  it("POST .../[platform]/connect-key surfaces the service's 'not supported for this platform' refusal for PassPercent in Plan 9a", async () => {
    registerAdapter(makeFakeAdapter()); // no connectWithKey hook — matches the real passpercentAdapter's shape
    await makeCredential();
    await signIn("INS0001");

    const response = await connectWithKey(
      cookieRequest({
        url: "http://localhost/api/settings/connections/PASSPERCENT/connect-key",
        origin: "http://localhost",
        body: { key: "some-key-value" },
      }),
      paramsFor("PASSPERCENT"),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.message).toMatch(/not supported for this platform/i);
  });

  it("POST .../[platform]/sync runs the adapter and returns a run", async () => {
    registerAdapter(makeFakeAdapter());
    await makeCredential();
    await signIn("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "CONNECTED",
      externalRef: "INS0001",
      grantTokenEncrypted: encryptCredential("pp_pgrant_route_test"),
    });

    const response = await syncConnection(
      cookieRequest({
        url: "http://localhost/api/settings/connections/PASSPERCENT/sync",
        origin: "http://localhost",
      }),
      paramsFor("PASSPERCENT"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.run.status).toBe("SUCCESS");
    expect(body.connection.lastSyncStatus).toBe("SUCCESS");

    expect(await SyncRun.countDocuments({ institutionId: "INS0001", platform: "PASSPERCENT" })).toBe(1);
  });

  it("GET .../[platform]/runs lists runs newest first", async () => {
    await signIn("INS0001");
    const older = new Date(Date.now() - 10_000);
    const newer = new Date();
    await SyncRun.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      trigger: "MANUAL",
      startedAt: older,
      finishedAt: older,
      status: "SUCCESS",
      createdAt: older,
    });
    await SyncRun.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      trigger: "MANUAL",
      startedAt: newer,
      finishedAt: newer,
      status: "FAILED",
      error: "boom",
      createdAt: newer,
    });

    const response = await listRuns(
      new Request("http://localhost/api/settings/connections/PASSPERCENT/runs"),
      paramsFor("PASSPERCENT"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0].status).toBe("FAILED");
  });

  it("DELETE .../[platform] disconnects", async () => {
    await signIn("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "CONNECTED",
      externalRef: "INS0001",
      grantTokenEncrypted: encryptCredential("pp_pgrant_route_test"),
    });

    const response = await disconnectConnection(
      cookieRequest({
        url: "http://localhost/api/settings/connections/PASSPERCENT",
        origin: "http://localhost",
      }),
      paramsFor("PASSPERCENT"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connection.status).toBe("DISCONNECTED");

    const raw = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" })
      .select("+grantTokenEncrypted")
      .lean();
    expect(raw?.grantTokenEncrypted).toBeUndefined();
  });
});

describe("connections routes — CSRF", () => {
  it("a cross-origin sync POST is refused (403), makes NO adapter call, and writes NO run", async () => {
    let syncCalls = 0;
    registerAdapter(
      makeFakeAdapter({
        sync: async (_ctx: AdapterContext, _conn: ConnectionState, _data: SyncSourceData) => {
          syncCalls += 1;
          return { status: "SUCCESS", steps: [], warnings: [] };
        },
      }),
    );
    await makeCredential();
    await signIn("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "CONNECTED",
      externalRef: "INS0001",
      grantTokenEncrypted: encryptCredential("pp_pgrant_route_test"),
    });

    const response = await syncConnection(
      cookieRequest({
        url: "http://localhost/api/settings/connections/PASSPERCENT/sync",
        origin: "http://evil.test",
      }),
      paramsFor("PASSPERCENT"),
    );

    expect(response.status).toBe(403);
    // Strong assertion: not merely "a run wasn't returned in the response",
    // but that the adapter was never entered and nothing was persisted.
    expect(syncCalls).toBe(0);
    expect(await SyncRun.countDocuments({ institutionId: "INS0001", platform: "PASSPERCENT" })).toBe(0);

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.status).toBe("CONNECTED"); // untouched
    expect(conn?.lastSyncStatus).toBeUndefined();
  });
});

describe("connections routes — unknown platform", () => {
  it("404s across every [platform] route for a platform outside PLATFORMS", async () => {
    await signIn("INS0001");

    const initiateResponse = await initiateConnection(
      cookieRequest({ origin: "http://localhost" }),
      paramsFor("BOGUS"),
    );
    expect(initiateResponse.status).toBe(404);

    const refreshResponse = await refreshConnection(
      cookieRequest({ origin: "http://localhost" }),
      paramsFor("BOGUS"),
    );
    expect(refreshResponse.status).toBe(404);

    const connectKeyResponse = await connectWithKey(
      cookieRequest({ origin: "http://localhost", body: { key: "x" } }),
      paramsFor("BOGUS"),
    );
    expect(connectKeyResponse.status).toBe(404);

    const syncResponse = await syncConnection(
      cookieRequest({ origin: "http://localhost" }),
      paramsFor("BOGUS"),
    );
    expect(syncResponse.status).toBe(404);

    const deleteResponse = await disconnectConnection(
      cookieRequest({ origin: "http://localhost" }),
      paramsFor("BOGUS"),
    );
    expect(deleteResponse.status).toBe(404);

    const runsResponse = await listRuns(
      new Request("http://localhost/api/settings/connections/BOGUS/runs"),
      paramsFor("BOGUS"),
    );
    expect(runsResponse.status).toBe(404);
  });
});
