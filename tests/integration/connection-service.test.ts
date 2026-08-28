import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Activity, Institution, PlatformConnection, PlatformCredential, Result, SyncRun } from "@/models";
import { decryptCredential, encryptCredential } from "@/lib/security/credentials";
import { registerAdapter } from "@/lib/connectors";
import { passpercentAdapter } from "@/lib/connectors/passpercent";
import { ConnectorAuthError } from "@/lib/connectors/types";
import type {
  AdapterContext,
  ConnectionState,
  InstitutionSummary,
  PlatformAdapter,
  SyncSourceData,
} from "@/lib/connectors/types";
import { assertPlatform, ConnectionService } from "@/services/connection.service";
import { AppError } from "@/lib/api/errors";
import { SYNC_LOCK_STALE_MINUTES } from "@/lib/constants";

const VALID_VAULT_KEY = Buffer.alloc(32, 7).toString("base64");
const actor = { id: "6a8880f3446c577c470cd06c", name: "Institution Admin" };

// ---------------------------------------------------------------------------
// Fake adapter — registered under "PASSPERCENT" (Decision 1: `registerAdapter`
// directly rather than `vi.mock`, so `adapterFor`'s real lookup path is
// exercised). Restored to the genuine `passpercentAdapter` in `afterEach` so
// nothing leaks into another test in this file, or — belt and braces — any
// other file sharing this module's registry.
// ---------------------------------------------------------------------------

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function makeCredential(overrides: Record<string, unknown> = {}) {
  return PlatformCredential.create({
    platform: "PASSPERCENT",
    keyEncrypted: encryptCredential("pp_pkey_test_0000"),
    baseUrl: "https://api.passpercent.test",
    active: true,
    ...overrides,
  });
}

/** A connectable institution: has a city (PassPercent requires it) and a
 * PUBLISHED profile (required before `syncNow` will proceed). */
async function makeConnectableInstitution(institutionId: string, overrides: Record<string, unknown> = {}) {
  return makeInstitution(institutionId, { profileStatus: "PUBLISHED", ...overrides });
}

beforeAll(() => startTestDatabase("connection-service"));
afterAll(stopTestDatabase);

beforeEach(async () => {
  await clearDatabase();
  process.env.IDAP_CREDENTIAL_KEY = VALID_VAULT_KEY;
});

afterEach(() => {
  registerAdapter(passpercentAdapter);
  process.env.IDAP_CREDENTIAL_KEY = VALID_VAULT_KEY;
});

// ---------------------------------------------------------------------------
// assertPlatform
// ---------------------------------------------------------------------------

describe("assertPlatform", () => {
  it("throws NOT_FOUND for a platform outside PLATFORMS", () => {
    expect(() => assertPlatform("BOGUS")).toThrow();
    try {
      assertPlatform("BOGUS");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("NOT_FOUND");
    }
  });

  it("accepts every real platform", () => {
    expect(assertPlatform("PASSPERCENT")).toBe("PASSPERCENT");
    expect(assertPlatform("FEESBASKET")).toBe("FEESBASKET");
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  it("configured flips true once an active credential exists; connection fields populate once one exists", async () => {
    await makeConnectableInstitution("INS0001");

    let entries = await ConnectionService.list("INS0001");
    let pp = entries.find((entry) => entry.platform === "PASSPERCENT")!;
    expect(pp.configured).toBe(false);
    expect(pp.status).toBeUndefined();

    await makeCredential();
    entries = await ConnectionService.list("INS0001");
    pp = entries.find((entry) => entry.platform === "PASSPERCENT")!;
    expect(pp.configured).toBe(true);

    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "CONNECTED",
      externalRef: "INS0001",
      lastSyncStatus: "SUCCESS",
      lastSyncAt: new Date(),
    });
    entries = await ConnectionService.list("INS0001");
    pp = entries.find((entry) => entry.platform === "PASSPERCENT")!;
    expect(pp.status).toBe("CONNECTED");
    expect(pp.lastSyncStatus).toBe("SUCCESS");
    expect(pp.lastSyncAt).toBeTruthy();
  });

  it("an inactive credential does not count as configured", async () => {
    await makeConnectableInstitution("INS0001");
    await makeCredential({ active: false });
    const entries = await ConnectionService.list("INS0001");
    expect(entries.find((entry) => entry.platform === "PASSPERCENT")!.configured).toBe(false);
  });

  it("vault not ready reads every platform as not configured, even with a stored credential", async () => {
    await makeConnectableInstitution("INS0001");
    await makeCredential();
    delete process.env.IDAP_CREDENTIAL_KEY;
    const entries = await ConnectionService.list("INS0001");
    expect(entries.find((entry) => entry.platform === "PASSPERCENT")!.configured).toBe(false);
  });

  it("always returns one entry per PLATFORMS, connected or not", async () => {
    await makeConnectableInstitution("INS0001");
    const entries = await ConnectionService.list("INS0001");
    expect(entries.map((entry) => entry.platform).sort()).toEqual(["EDUFLEET", "FEESBASKET", "PASSPERCENT"]);
  });
});

// ---------------------------------------------------------------------------
// initiate
// ---------------------------------------------------------------------------

describe("initiate", () => {
  it("creates a PENDING connection carrying the remote request id, and passes a complete InstitutionSummary", async () => {
    let seen: InstitutionSummary | undefined;
    registerAdapter(
      makeFakeAdapter({
        initiate: async (_ctx: AdapterContext, institution: InstitutionSummary) => {
          seen = institution;
          return { remoteRequestId: "req-123", remoteStatus: "pending" };
        },
      }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001", { city: "Mysore" });

    const entry = await ConnectionService.initiate("INS0001", "PASSPERCENT", actor);

    expect(entry.status).toBe("PENDING");
    expect(entry.configured).toBe(true);
    expect(seen?.city).toBe("Mysore");
    expect(seen?.institutionId).toBe("INS0001");

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.remoteRequestId).toBe("req-123");
    expect(conn?.externalRef).toBe("INS0001");
    expect(conn?.status).toBe("PENDING");
  });

  it("an adapter reporting a kind past PENDING is stored as that kind, not as PENDING", async () => {
    // eduFleet's auto-remap: a re-connect for a school it matched before comes
    // back already `awaiting_school`, so the card must not read "Requested".
    registerAdapter(
      makeFakeAdapter({
        initiate: async () => ({
          remoteRequestId: "req-1",
          remoteStatus: "awaiting_school",
          kind: "AWAITING_APPROVAL",
        }),
      }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001");

    const entry = await ConnectionService.initiate("INS0001", "PASSPERCENT", actor);

    expect(entry.status).toBe("AWAITING_APPROVAL");
    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.status).toBe("AWAITING_APPROVAL");
  });

  it("an adapter that omits kind still yields PENDING", async () => {
    registerAdapter(
      makeFakeAdapter({
        initiate: async () => ({ remoteRequestId: "req-1", remoteStatus: "pending" }),
      }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001");

    const entry = await ConnectionService.initiate("INS0001", "PASSPERCENT", actor);

    expect(entry.status).toBe("PENDING");
    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.status).toBe("PENDING");
  });

  it("refuses when the connection is already CONNECTED", async () => {
    registerAdapter(
      makeFakeAdapter({ initiate: async () => ({ remoteRequestId: "req-x", remoteStatus: "pending" }) }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "CONNECTED",
      externalRef: "INS0001",
    });

    await expect(ConnectionService.initiate("INS0001", "PASSPERCENT", actor)).rejects.toThrow(
      /already connected/i,
    );
  });

  it("404s as 'not configured' with no active credential", async () => {
    registerAdapter(
      makeFakeAdapter({ initiate: async () => ({ remoteRequestId: "req-x", remoteStatus: "pending" }) }),
    );
    await makeConnectableInstitution("INS0001");

    await expect(ConnectionService.initiate("INS0001", "PASSPERCENT", actor)).rejects.toThrow(/not configured/i);
  });

  it("404s as 'not configured' when the stored credential is inactive", async () => {
    registerAdapter(
      makeFakeAdapter({ initiate: async () => ({ remoteRequestId: "req-x", remoteStatus: "pending" }) }),
    );
    await makeCredential({ active: false });
    await makeConnectableInstitution("INS0001");

    await expect(ConnectionService.initiate("INS0001", "PASSPERCENT", actor)).rejects.toThrow(/not configured/i);
  });

  it("404s as 'not configured' when the vault is not ready", async () => {
    registerAdapter(
      makeFakeAdapter({ initiate: async () => ({ remoteRequestId: "req-x", remoteStatus: "pending" }) }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001");
    delete process.env.IDAP_CREDENTIAL_KEY;

    await expect(ConnectionService.initiate("INS0001", "PASSPERCENT", actor)).rejects.toThrow(/not configured/i);
  });

  it("refuses with a message naming the fix when the institution has no city", async () => {
    registerAdapter(
      makeFakeAdapter({ initiate: async () => ({ remoteRequestId: "req-x", remoteStatus: "pending" }) }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001");
    await Institution.updateOne({ institutionId: "INS0001" }, { $unset: { city: "" } });

    await expect(ConnectionService.initiate("INS0001", "PASSPERCENT", actor)).rejects.toThrow(/add a city/i);
  });

  it("a plain Error from the adapter is recorded as lastError (in full) and surfaced as a safe 502, without changing an existing status", async () => {
    registerAdapter(
      makeFakeAdapter({
        initiate: async () => {
          throw new Error("PassPercent: submitting the connection request failed (status 500)");
        },
      }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "REJECTED",
      externalRef: "INS0001",
    });

    let caught: unknown;
    try {
      await ConnectionService.initiate("INS0001", "PASSPERCENT", actor);
    } catch (error) {
      caught = error;
    }

    // Fix round 1, routed call 1: the raw adapter message must never reach
    // the HTTP-facing error — only a safe, generic message with a 502
    // status. The full detail still lands in `lastError` on the row.
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(502);
    expect((caught as AppError).message).not.toMatch(/submitting the connection request failed/);

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.status).toBe("REJECTED"); // unchanged — not evidence this institution's grant is bad
    expect(conn?.lastError).toMatch(/submitting the connection request failed/);
  });

  it("a first-ever failed initiate (no prior PlatformConnection row) still records lastError, and leaves status unset rather than implying acceptance", async () => {
    registerAdapter(
      makeFakeAdapter({
        initiate: async () => {
          throw new Error("PassPercent: submitting the connection request failed (status 500)");
        },
      }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001");
    // Deliberately no PlatformConnection.create — this is the very first attempt.
    expect(await PlatformConnection.countDocuments({ institutionId: "INS0001" })).toBe(0);

    await expect(ConnectionService.initiate("INS0001", "PASSPERCENT", actor)).rejects.toBeInstanceOf(AppError);

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn).not.toBeNull();
    expect(conn?.lastError).toMatch(/submitting the connection request failed/);
    // Deliberately unset, not defaulted to "PENDING" — a failed, never-accepted
    // attempt must not read as "Requested" (fix round 1, finding I2).
    expect(conn?.status).toBeUndefined();
    expect(conn?.externalRef).toBe("INS0001");
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe("refresh", () => {
  it("maps PENDING -> AWAITING_APPROVAL -> CONNECTED 1:1, and encrypts the grant at rest", async () => {
    const PLAINTEXT_GRANT = "pp_pgrant_live_abcdef123456";
    let call = 0;
    registerAdapter(
      makeFakeAdapter({
        refresh: async () => {
          call += 1;
          if (call === 1) return { kind: "PENDING", remoteStatus: "pending" };
          if (call === 2) return { kind: "AWAITING_APPROVAL", remoteStatus: "awaiting_school" };
          return {
            kind: "CONNECTED",
            remoteStatus: "completed",
            grantToken: PLAINTEXT_GRANT,
            scopes: ["profile:write", "results:write"],
            remoteInstitution: { name: "Test School", city: "Mysore", slug: "test-school" },
          };
        },
      }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "PENDING",
      externalRef: "INS0001",
      remoteRequestId: "req-1",
    });

    const r1 = await ConnectionService.refresh("INS0001", "PASSPERCENT", actor);
    expect(r1.status).toBe("PENDING");
    const r2 = await ConnectionService.refresh("INS0001", "PASSPERCENT", actor);
    expect(r2.status).toBe("AWAITING_APPROVAL");
    const r3 = await ConnectionService.refresh("INS0001", "PASSPERCENT", actor);
    expect(r3.status).toBe("CONNECTED");
    expect(r3.scopes).toEqual(["profile:write", "results:write"]);
    expect(r3.remoteInstitution?.name).toBe("Test School");

    const raw = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" })
      .select("+grantTokenEncrypted")
      .lean();
    expect(raw?.grantTokenEncrypted).toBeTruthy();
    // Strong assertion: the plaintext grant never appears anywhere in the raw
    // stored document, not merely that a ciphertext field is present.
    expect(JSON.stringify(raw)).not.toContain(PLAINTEXT_GRANT);
    expect(decryptCredential(raw!.grantTokenEncrypted!)).toBe(PLAINTEXT_GRANT);
  });

  it("REJECTED sets status REJECTED and records the detail as lastError", async () => {
    registerAdapter(
      makeFakeAdapter({
        refresh: async () => ({
          kind: "REJECTED",
          remoteStatus: "rejected",
          detail: "already redeemed — reconnect from PassPercent",
        }),
      }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "AWAITING_APPROVAL",
      externalRef: "INS0001",
      remoteRequestId: "req-1",
    });

    const result = await ConnectionService.refresh("INS0001", "PASSPERCENT", actor);
    expect(result.status).toBe("REJECTED");
    expect(result.lastError).toMatch(/already redeemed/i);
  });

  it("a plain Error from the adapter's polling step does not change status — only ConnectorAuthError from `sync` does that", async () => {
    registerAdapter(
      makeFakeAdapter({
        refresh: async () => {
          throw new Error("PassPercent: polling the connection request failed (status 500)");
        },
      }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "PENDING",
      externalRef: "INS0001",
      remoteRequestId: "req-1",
    });

    let caught: unknown;
    try {
      await ConnectionService.refresh("INS0001", "PASSPERCENT", actor);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(502);
    expect((caught as AppError).message).not.toMatch(/polling the connection request failed/);

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.status).toBe("PENDING");
    expect(conn?.lastError).toMatch(/polling the connection request failed/);
  });

  it("ConnectorAuthError from refresh flips the connection to DISCONNECTED and drops the dead grant", async () => {
    registerAdapter(
      makeFakeAdapter({
        refresh: async () => {
          throw new ConnectorAuthError("grant revoked");
        },
      }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "CONNECTED",
      externalRef: "INS0001",
      remoteRequestId: "req-1",
      grantTokenEncrypted: encryptCredential("pp_pgrant_dead_abcdef"),
    });

    await expect(ConnectionService.refresh("INS0001", "PASSPERCENT", actor)).rejects.toBeInstanceOf(AppError);

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" })
      .select("+grantTokenEncrypted")
      .lean();
    // DISCONNECTED, not left at CONNECTED and not a generic upstream blip:
    // the school withdrew consent, and DISCONNECTED is the state that
    // re-offers "Request connection".
    expect(conn?.status).toBe("DISCONNECTED");
    expect(conn?.lastError).toMatch(/grant revoked/);
    // The ciphertext is confirmed dead — keeping it only invites a later
    // reader to trust it.
    expect(conn?.grantTokenEncrypted).toBeUndefined();
  });

  it("MUTATION-DISTINGUISHING: a plain Error from refresh leaves a CONNECTED row connected, grant intact", async () => {
    const PLAINTEXT_GRANT = "pp_pgrant_still_good_abcdef";
    registerAdapter(
      makeFakeAdapter({
        refresh: async () => {
          throw new Error("boom");
        },
      }),
    );
    await makeCredential();
    await makeConnectableInstitution("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "CONNECTED",
      externalRef: "INS0001",
      remoteRequestId: "req-1",
      grantTokenEncrypted: encryptCredential(PLAINTEXT_GRANT),
    });

    await expect(ConnectionService.refresh("INS0001", "PASSPERCENT", actor)).rejects.toBeInstanceOf(AppError);

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" })
      .select("+grantTokenEncrypted")
      .lean();
    // An ordinary upstream failure is not evidence this institution's grant
    // is bad — the branch must discriminate, not flatten every failure into
    // DISCONNECTED.
    expect(conn?.status).toBe("CONNECTED");
    expect(conn?.grantTokenEncrypted).toBeTruthy();
    expect(decryptCredential(conn!.grantTokenEncrypted!)).toBe(PLAINTEXT_GRANT);
  });

  describe("tenant isolation (mutation-checked — see task-8-report.md)", () => {
    it("INS0001 never reaches the adapter using INS0002's connection state, even though INS0001 has none of its own", async () => {
      let refreshCalls = 0;
      let seenRemoteRequestId: string | undefined;
      registerAdapter(
        makeFakeAdapter({
          refresh: async (_ctx: AdapterContext, connection: ConnectionState) => {
            refreshCalls += 1;
            seenRemoteRequestId = connection.remoteRequestId;
            return { kind: "PENDING", remoteStatus: "pending" };
          },
        }),
      );
      await makeCredential();
      await makeConnectableInstitution("INS0001");
      await makeConnectableInstitution("INS0002");

      // Only INS0002 has ever initiated a connection for this platform.
      await PlatformConnection.create({
        institutionId: "INS0002",
        platform: "PASSPERCENT",
        status: "PENDING",
        externalRef: "INS0002",
        remoteRequestId: "req-ins0002",
      });

      await expect(ConnectionService.refresh("INS0001", "PASSPERCENT", actor)).rejects.toThrow(/not found/i);

      // The load-bearing assertion: the adapter must never even be reached
      // using another institution's connection state. Checked in ADDITION to
      // the thrown error above because a later, correctly-scoped write in
      // the same method (the status-update `findOneAndUpdate`, which also
      // filters by `institutionId`) would independently throw "not found"
      // too and mask a broken read earlier in the method — exactly the kind
      // of confounded test this task's brief warned about. Asserting the
      // adapter was never entered pins the check on the specific lookup this
      // mutation targets, not on the method's overall outcome.
      expect(refreshCalls).toBe(0);
      expect(seenRemoteRequestId).toBeUndefined();

      // INS0002's row must be completely untouched by the refused attempt.
      const other = await PlatformConnection.findOne({ institutionId: "INS0002", platform: "PASSPERCENT" }).lean();
      expect(other?.status).toBe("PENDING");
    });
  });
});

// ---------------------------------------------------------------------------
// connectWithKey
// ---------------------------------------------------------------------------

describe("connectWithKey", () => {
  it("refuses with 'not supported for this platform' when the adapter has no connectWithKey (true of PassPercent in Plan 9a)", async () => {
    registerAdapter(makeFakeAdapter()); // no connectWithKey hook
    await makeCredential();
    await makeConnectableInstitution("INS0001");

    await expect(
      ConnectionService.connectWithKey("INS0001", "PASSPERCENT", "some-key", actor),
    ).rejects.toThrow(/not supported for this platform/i);
  });
});

// ---------------------------------------------------------------------------
// FeesBasket is not yet wired (fix round 1, finding I3) — initiate/refresh/
// connectWithKey. syncNow's equivalent test lives in its own describe block
// below since it needs a connected fixture to get past the earlier checks.
// ---------------------------------------------------------------------------

describe("FeesBasket is not yet wired (fix round 1, finding I3)", () => {
  it("initiate returns a clean VALIDATION_ERROR, not an unhandled exception, for FEESBASKET", async () => {
    await makeCredential({ platform: "FEESBASKET", keyEncrypted: encryptCredential("fbk_live_test") });
    await makeConnectableInstitution("INS0001");

    let caught: unknown;
    try {
      await ConnectionService.initiate("INS0001", "FEESBASKET", actor);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("VALIDATION_ERROR");
    expect((caught as AppError).message).toMatch(/not available yet/i);
  });

  it("refresh returns a clean VALIDATION_ERROR, not an unhandled exception, for FEESBASKET", async () => {
    await makeCredential({ platform: "FEESBASKET", keyEncrypted: encryptCredential("fbk_live_test") });
    await makeConnectableInstitution("INS0001");

    let caught: unknown;
    try {
      await ConnectionService.refresh("INS0001", "FEESBASKET", actor);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("VALIDATION_ERROR");
    expect((caught as AppError).message).toMatch(/not available yet/i);
  });

  it("connectWithKey returns a clean VALIDATION_ERROR, not an unhandled exception, for FEESBASKET", async () => {
    await makeCredential({ platform: "FEESBASKET", keyEncrypted: encryptCredential("fbk_live_test") });
    await makeConnectableInstitution("INS0001");

    let caught: unknown;
    try {
      await ConnectionService.connectWithKey("INS0001", "FEESBASKET", "some-key", actor);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("VALIDATION_ERROR");
    expect((caught as AppError).message).toMatch(/not available yet/i);
  });
});

// ---------------------------------------------------------------------------
// syncNow
// ---------------------------------------------------------------------------

describe("syncNow", () => {
  async function connectedFixture(institutionId: string, overrides: Record<string, unknown> = {}) {
    await makeCredential();
    await makeConnectableInstitution(institutionId);
    await PlatformConnection.create({
      institutionId,
      platform: "PASSPERCENT",
      status: "CONNECTED",
      externalRef: institutionId,
      grantTokenEncrypted: encryptCredential("pp_pgrant_test"),
      ...overrides,
    });
  }

  it("writes a SyncRun and updates lastSyncAt/lastSyncStatus on success", async () => {
    registerAdapter(makeFakeAdapter());
    await connectedFixture("INS0001");

    const result = await ConnectionService.syncNow("INS0001", "PASSPERCENT", actor);

    expect(result.run.status).toBe("SUCCESS");
    expect(result.connection.lastSyncStatus).toBe("SUCCESS");

    const runs = await SyncRun.find({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(runs).toHaveLength(1);

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.lastSyncStatus).toBe("SUCCESS");
    expect(conn?.lastSyncAt).toBeTruthy();
    expect(conn?.syncInProgress).toBe(false);
  });

  it("prunes SyncRun rows to SYNC_RUN_KEEP (20) newest — insert 21, expect 20", async () => {
    registerAdapter(makeFakeAdapter());
    await connectedFixture("INS0001");

    const now = Date.now();
    for (let i = 0; i < 20; i += 1) {
      const at = new Date(now - (20 - i) * 60_000);
      await SyncRun.create({
        institutionId: "INS0001",
        platform: "PASSPERCENT",
        trigger: "MANUAL",
        startedAt: at,
        finishedAt: at,
        status: "SUCCESS",
        createdAt: at,
      });
    }
    expect(await SyncRun.countDocuments({ institutionId: "INS0001" })).toBe(20);

    const result = await ConnectionService.syncNow("INS0001", "PASSPERCENT", actor);

    const total = await SyncRun.countDocuments({ institutionId: "INS0001", platform: "PASSPERCENT" });
    expect(total).toBe(20);

    // The just-written (newest) run must be among the survivors.
    const survivor = await SyncRun.findById(result.run.id).lean();
    expect(survivor).not.toBeNull();
  });

  it("refuses a concurrent sync while the first is genuinely in flight — not merely 'eventually one worked'", async () => {
    const started = deferred<void>();
    const finish = deferred<{ status: "SUCCESS"; steps: never[]; warnings: never[] }>();
    let invocations = 0;

    registerAdapter(
      makeFakeAdapter({
        sync: async () => {
          invocations += 1;
          started.resolve();
          return finish.promise;
        },
      }),
    );
    await connectedFixture("INS0001");

    const first = ConnectionService.syncNow("INS0001", "PASSPERCENT", actor);
    // Waits until the fake adapter's `sync` has actually been entered, which
    // can only happen AFTER the lock's `findOneAndUpdate` has committed —
    // so by this point the first call unambiguously holds the lock.
    await started.promise;

    await expect(ConnectionService.syncNow("INS0001", "PASSPERCENT", actor)).rejects.toThrow(
      /already running/i,
    );

    finish.resolve({ status: "SUCCESS", steps: [], warnings: [] });
    const firstResult = await first;

    expect(firstResult.run.status).toBe("SUCCESS");
    expect(invocations).toBe(1); // the adapter was only ever entered once

    const runs = await SyncRun.find({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(runs).toHaveLength(1);

    // The lock is released afterwards — a third, later call is not stuck.
    registerAdapter(makeFakeAdapter());
    const third = await ConnectionService.syncNow("INS0001", "PASSPERCENT", actor);
    expect(third.run.status).toBe("SUCCESS");
  });

  it("refuses when the institution profile is not PUBLISHED, writes no run, and clears the lock", async () => {
    registerAdapter(makeFakeAdapter());
    await makeCredential();
    await makeConnectableInstitution("INS0001", { profileStatus: "DRAFT" });
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "CONNECTED",
      externalRef: "INS0001",
      grantTokenEncrypted: encryptCredential("grant"),
    });

    await expect(ConnectionService.syncNow("INS0001", "PASSPERCENT", actor)).rejects.toThrow(/publish/i);
    expect(await SyncRun.countDocuments({ institutionId: "INS0001" })).toBe(0);

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.syncInProgress).toBe(false);

    // The lock being cleared means a second refused attempt is refused for
    // the SAME reason, not for "already running".
    await expect(ConnectionService.syncNow("INS0001", "PASSPERCENT", actor)).rejects.toThrow(/publish/i);
  });

  it("ConnectorAuthError flips the connection to ERROR and records a FAILED SyncRun", async () => {
    registerAdapter(
      makeFakeAdapter({
        sync: async () => {
          throw new ConnectorAuthError("PassPercent rejected the grant token (401) while calling PATCH /partner/institution");
        },
      }),
    );
    await connectedFixture("INS0001");

    const result = await ConnectionService.syncNow("INS0001", "PASSPERCENT", actor);
    expect(result.run.status).toBe("FAILED");
    expect(result.connection.status).toBe("ERROR");

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.status).toBe("ERROR");
    expect(conn?.lastError).toMatch(/rejected the grant token/i);
  });

  it("F3 (fix round 2): a mid-run 401 does not discard the steps/warnings already accumulated — the persisted SyncRun keeps them, and the connection still flips to ERROR", async () => {
    registerAdapter(
      makeFakeAdapter({
        sync: async () => {
          throw new ConnectorAuthError(
            "PassPercent rejected the grant token (401) while calling PUT /partner/institution/results/2026",
            [
              { step: "schema", ok: true },
              { step: "profile", ok: true },
              { step: "results:2024-25", ok: true },
              { step: "results:2025-26", ok: true },
            ],
            ["Result r9 in stream \"sslc\" / year \"2025-26\" has no reported \"passed\" — excluded from the rollup"],
          );
        },
      }),
    );
    await connectedFixture("INS0001");

    const result = await ConnectionService.syncNow("INS0001", "PASSPERCENT", actor);

    // Both halves: the connection still flips to ERROR (unchanged behaviour)...
    expect(result.connection.status).toBe("ERROR");
    expect(result.run.status).toBe("FAILED");
    // ...AND the run that already reached the public listing before the 401
    // is not thrown away.
    expect(result.run.steps?.map((s) => s.step)).toEqual([
      "schema",
      "profile",
      "results:2024-25",
      "results:2025-26",
    ]);
    expect(result.run.steps?.every((s) => s.ok)).toBe(true);
    expect(result.run.warnings?.length).toBe(1);

    const persisted = await SyncRun.findById(result.run.id).lean();
    expect(persisted?.steps?.length).toBe(4);
    expect(persisted?.status).toBe("FAILED");

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.status).toBe("ERROR");
  });

  it("a plain Error/network failure from sync does NOT flip status — only ConnectorAuthError does — but still writes a FAILED run", async () => {
    registerAdapter(
      makeFakeAdapter({
        sync: async () => {
          throw new Error("Connector PATCH /partner/institution timed out after 15000ms");
        },
      }),
    );
    await connectedFixture("INS0001");

    const result = await ConnectionService.syncNow("INS0001", "PASSPERCENT", actor);
    expect(result.run.status).toBe("FAILED");
    expect(result.connection.status).toBe("CONNECTED"); // unchanged, not ERROR

    const runs = await SyncRun.find({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("FAILED");
    expect(runs[0].error).toMatch(/timed out/);

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.status).toBe("CONNECTED");
    expect(conn?.lastError).toMatch(/timed out/);
  });

  it("filters results to PUBLISHED only before building SyncSourceData", async () => {
    let captured: SyncSourceData | undefined;
    registerAdapter(
      makeFakeAdapter({
        sync: async (_ctx: AdapterContext, _conn: ConnectionState, data: SyncSourceData) => {
          captured = data;
          return { status: "SUCCESS", steps: [], warnings: [] };
        },
      }),
    );
    await connectedFixture("INS0001");

    await Result.create({
      institutionId: "INS0001",
      board: "CBSE",
      level: "CLASS_10",
      stream: null,
      academicYear: "2024-25",
      appeared: 100,
      passed: 90,
      status: "DRAFT",
    });
    await Result.create({
      institutionId: "INS0001",
      board: "CBSE",
      level: "CLASS_10",
      stream: null,
      academicYear: "2025-26",
      appeared: 120,
      passed: 110,
      status: "PUBLISHED",
    });

    await ConnectionService.syncNow("INS0001", "PASSPERCENT", actor);

    expect(captured?.results).toHaveLength(1);
    expect((captured?.results[0] as { academicYear: string }).academicYear).toBe("2025-26");
  });

  it("logs Activity with the real institutionId, never a sentinel", async () => {
    registerAdapter(makeFakeAdapter());
    await connectedFixture("INS0001");

    await ConnectionService.syncNow("INS0001", "PASSPERCENT", actor);

    const entries = await Activity.find({ entityType: "PLATFORM_CONNECTION" }).lean();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.institutionId).toBe("INS0001");
      expect(entry.institutionId).not.toBe("PLATFORM");
    }
  });

  it("refuses to sync a non-CONNECTED connection, without writing a SyncRun (routed call 2, fix round 1)", async () => {
    registerAdapter(makeFakeAdapter());
    await makeCredential();
    await makeConnectableInstitution("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "PENDING",
      externalRef: "INS0001",
    });

    await expect(ConnectionService.syncNow("INS0001", "PASSPERCENT", actor)).rejects.toThrow(
      /connect to this platform/i,
    );

    // A sequencing mistake shouldn't leave a permanent failure record.
    expect(await SyncRun.countDocuments({ institutionId: "INS0001" })).toBe(0);

    const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(conn?.status).toBe("PENDING"); // unchanged
    expect(conn?.syncInProgress).toBe(false); // lock still cleared by `finally`
  });

  describe("stale lock escape hatch (fix round 1, finding I1)", () => {
    it("a lock older than SYNC_LOCK_STALE_MINUTES can be reacquired by a new syncNow call", async () => {
      registerAdapter(makeFakeAdapter());
      await connectedFixture("INS0001", {
        syncInProgress: true,
        syncStartedAt: new Date(Date.now() - (SYNC_LOCK_STALE_MINUTES + 1) * 60_000),
      });

      const result = await ConnectionService.syncNow("INS0001", "PASSPERCENT", actor);
      expect(result.run.status).toBe("SUCCESS");

      const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
      expect(conn?.syncInProgress).toBe(false);
    });

    it("boundary: a lock started just 1 minute ago is still refused as already running", async () => {
      registerAdapter(makeFakeAdapter());
      await connectedFixture("INS0001", {
        syncInProgress: true,
        syncStartedAt: new Date(Date.now() - 60_000),
      });

      await expect(ConnectionService.syncNow("INS0001", "PASSPERCENT", actor)).rejects.toThrow(
        /already running/i,
      );
    });
  });

  describe("FeesBasket is not yet wired (fix round 1, finding I3)", () => {
    it("returns a clean VALIDATION_ERROR, not an unhandled exception, when syncing FEESBASKET", async () => {
      await makeCredential({ platform: "FEESBASKET", keyEncrypted: encryptCredential("fbk_live_test") });
      await makeConnectableInstitution("INS0001");
      await PlatformConnection.create({
        institutionId: "INS0001",
        platform: "FEESBASKET",
        status: "CONNECTED",
        externalRef: "INS0001",
      });

      let caught: unknown;
      try {
        await ConnectionService.syncNow("INS0001", "FEESBASKET", actor);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).code).toBe("VALIDATION_ERROR");
      expect((caught as AppError).message).toMatch(/not available yet/i);

      // The lock must still be released even though resolveAdapter refused.
      const conn = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "FEESBASKET" }).lean();
      expect(conn?.syncInProgress).toBe(false);
    });
  });

  describe("tenant isolation of the lock filter (mutation-checked, fix round 2, F4)", () => {
    it("INS0001 (with no connection of its own) never locks or reaches the adapter using INS0002's connection row", async () => {
      let syncCalls = 0;
      registerAdapter(
        makeFakeAdapter({
          sync: async () => {
            syncCalls += 1;
            return { status: "SUCCESS", steps: [], warnings: [] };
          },
        }),
      );
      await makeCredential();
      await makeConnectableInstitution("INS0001");
      await makeConnectableInstitution("INS0002");
      // Only INS0002 has ever connected for this platform.
      await PlatformConnection.create({
        institutionId: "INS0002",
        platform: "PASSPERCENT",
        status: "CONNECTED",
        externalRef: "INS0002",
        grantTokenEncrypted: encryptCredential("pp_pgrant_ins0002"),
      });

      await expect(ConnectionService.syncNow("INS0001", "PASSPERCENT", actor)).rejects.toThrow(/not found/i);

      // The load-bearing assertions. A later, correctly-scoped write further
      // down this same method (the final `connectionSet` update, still
      // filtered on the outer `institutionId` "INS0001") independently
      // throws its own "not found" once INS0001 turns out to have no row at
      // all — so the message above alone would still read "not found" even
      // with the LOCK query's `institutionId` removed, and would mask the
      // break. What only a correctly-scoped lock query can guarantee: the
      // fake adapter is never entered, and INS0002's row — the only
      // PASSPERCENT connection that exists anywhere — is never locked.
      expect(syncCalls).toBe(0);

      const other = await PlatformConnection.findOne({ institutionId: "INS0002", platform: "PASSPERCENT" }).lean();
      expect(other?.syncInProgress).toBe(false);
      expect(other?.syncStartedAt).toBeUndefined();
      expect(other?.status).toBe("CONNECTED");
    });
  });
});

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

describe("disconnect", () => {
  it("flips status to DISCONNECTED and removes the grant ciphertext", async () => {
    await makeConnectableInstitution("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "CONNECTED",
      externalRef: "INS0001",
      grantTokenEncrypted: encryptCredential("pp_pgrant_live"),
    });

    const entry = await ConnectionService.disconnect("INS0001", "PASSPERCENT", actor);
    expect(entry.status).toBe("DISCONNECTED");

    const raw = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" })
      .select("+grantTokenEncrypted")
      .lean();
    expect(raw?.status).toBe("DISCONNECTED");
    expect(raw?.grantTokenEncrypted).toBeUndefined();
  });

  it("404s when there is no connection to disconnect", async () => {
    await makeConnectableInstitution("INS0001");
    await expect(ConnectionService.disconnect("INS0001", "PASSPERCENT", actor)).rejects.toThrow(/not found/i);
  });

  it("clears a stuck syncInProgress lock and syncStartedAt (fix round 1, finding I1, point 4)", async () => {
    await makeConnectableInstitution("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "CONNECTED",
      externalRef: "INS0001",
      grantTokenEncrypted: encryptCredential("pp_pgrant_live"),
      syncInProgress: true,
      syncStartedAt: new Date(),
    });

    await ConnectionService.disconnect("INS0001", "PASSPERCENT", actor);

    const raw = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(raw?.syncInProgress).toBe(false);
    expect(raw?.syncStartedAt).toBeUndefined();
  });

  it("clears lastError (fix round 2, F5) — a disconnected connection should not keep showing a stale error banner", async () => {
    await makeConnectableInstitution("INS0001");
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      status: "ERROR",
      externalRef: "INS0001",
      lastError: "PassPercent: grant token rejected (401)",
    });

    await ConnectionService.disconnect("INS0001", "PASSPERCENT", actor);

    const raw = await PlatformConnection.findOne({ institutionId: "INS0001", platform: "PASSPERCENT" }).lean();
    expect(raw?.lastError).toBeUndefined();
  });

  describe("tenant isolation (mutation-checked, fix round 2, F4)", () => {
    it("never touches another institution's connection row — INS0001 (with no row of its own) is refused, and INS0002's row is untouched", async () => {
      await makeConnectableInstitution("INS0001"); // deliberately no PlatformConnection row
      await makeConnectableInstitution("INS0002");
      await PlatformConnection.create({
        institutionId: "INS0002",
        platform: "PASSPERCENT",
        status: "CONNECTED",
        externalRef: "INS0002",
        grantTokenEncrypted: encryptCredential("pp_pgrant_ins0002"),
      });

      // The load-bearing assertion is the throw itself: with `institutionId`
      // removed from `disconnect`'s filter, this call would silently match
      // INS0002's row (the only PASSPERCENT row that exists at all) instead
      // of finding nothing, so it would resolve rather than reject.
      await expect(ConnectionService.disconnect("INS0001", "PASSPERCENT", actor)).rejects.toThrow(/not found/i);

      // Belt and braces: INS0002's row must be completely untouched.
      const other = await PlatformConnection.findOne({ institutionId: "INS0002", platform: "PASSPERCENT" })
        .select("+grantTokenEncrypted")
        .lean();
      expect(other?.status).toBe("CONNECTED");
      expect(other?.grantTokenEncrypted).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// listRuns
// ---------------------------------------------------------------------------

describe("listRuns", () => {
  it("returns newest first", async () => {
    await makeConnectableInstitution("INS0001");
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

    const runs = await ConnectionService.listRuns("INS0001", "PASSPERCENT");
    expect(runs).toHaveLength(2);
    expect(runs[0].status).toBe("FAILED");
    expect(runs[1].status).toBe("SUCCESS");
  });

  describe("tenant isolation (mutation-checked, fix round 2, F4)", () => {
    it("never returns another institution's runs", async () => {
      await makeConnectableInstitution("INS0001");
      await makeConnectableInstitution("INS0002");
      await SyncRun.create({
        institutionId: "INS0002",
        platform: "PASSPERCENT",
        trigger: "MANUAL",
        startedAt: new Date(),
        finishedAt: new Date(),
        status: "SUCCESS",
      });

      // INS0001 has no runs of its own — with `institutionId` removed from
      // the filter, this would return INS0002's run instead of none.
      const runs = await ConnectionService.listRuns("INS0001", "PASSPERCENT");
      expect(runs).toHaveLength(0);
    });
  });
});
