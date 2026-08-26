import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorHttp } from "@/lib/connectors/http";
import { ConnectorAuthError } from "@/lib/connectors/types";
import type { AdapterContext, ConnectionState, InstitutionSummary, SyncSourceData } from "@/lib/connectors/types";
import { passpercentAdapter } from "@/lib/connectors/passpercent";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCtx(http: ConnectorHttp): AdapterContext {
  return { baseUrl: "https://api.passpercent.example", platformKey: "pp_pkey_test", http };
}

function makeInstitution(overrides: Partial<InstitutionSummary> = {}): InstitutionSummary {
  return {
    institutionId: "inst-1",
    name: "Delhi Public School",
    city: "Bengaluru",
    address: { addressLine: "12 MG Road", area: "Indiranagar", district: "Bengaluru Urban", state: "KA", pincode: "560038" },
    phone: "9999999999",
    website: "https://dps.example",
    contactName: "Principal",
    contactEmail: "principal@dps.example",
    ...overrides,
  };
}

function makeConnection(overrides: Partial<ConnectionState> = {}): ConnectionState {
  return {
    institutionId: "inst-1",
    externalRef: "inst-1",
    remoteRequestId: "req-1",
    grantToken: "pp_pgrant_test",
    scopes: ["profile:write", "results:write"],
    ...overrides,
  };
}

const SCHEMA_FIELDS = [
  { name: "board", type: "string", enum: ["CBSE", "ICSE", "STATE_BOARD"] },
  { name: "name", type: "string" },
];

function schemaBody(opts: { photoEncoding?: "base64" | "dataUri" } = {}): Record<string, unknown> {
  return {
    fields: SCHEMA_FIELDS,
    enums: {},
    rules: {},
    example: {},
    results: opts.photoEncoding ? { photoEncoding: opts.photoEncoding } : {},
  };
}

function makeSyncData(overrides: Partial<SyncSourceData> = {}): SyncSourceData {
  return {
    institution: {
      institutionName: "Delhi Public School",
      city: "Bengaluru",
      institutionType: "SCHOOL",
      academic: { board: "CBSE", segments: ["SCHOOL"] },
    },
    results: [{ id: "r1", level: "CLASS_10", academicYear: "2024-25", appeared: 100, passed: 90 }],
    readPublicMedia: vi.fn(async () => null),
    ...overrides,
  };
}

/** Records calls as "METHOD path" strings for order assertions. */
function callLog(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((call) => {
    const [path, init] = call as [string, { method: string }];
    return `${init.method} ${path}`;
  });
}

describe("passpercentAdapter", () => {
  it("declares REQUEST_APPROVE_REDEEM as its connect mode", () => {
    expect(passpercentAdapter.platform).toBe("PASSPERCENT");
    expect(passpercentAdapter.connectMode).toBe("REQUEST_APPROVE_REDEEM");
  });

  // -------------------------------------------------------------------------
  // initiate
  // -------------------------------------------------------------------------

  describe("initiate", () => {
    it("submits a connection request and returns the new id on 201", async () => {
      const http = vi.fn().mockResolvedValue({ status: 201, body: { requestId: "req-abc", status: "pending" } });
      const ctx = makeCtx(http);

      const result = await passpercentAdapter.initiate!(ctx, makeInstitution());

      expect(result).toEqual({ remoteRequestId: "req-abc", remoteStatus: "pending" });
      expect(http).toHaveBeenCalledTimes(1);
      const [path, init] = http.mock.calls[0];
      expect(path).toBe("/api/partner/connection-requests");
      expect(init.method).toBe("POST");
      expect(init.token).toBe("pp_pkey_test");
      expect(init.body).toMatchObject({ externalRef: "inst-1", name: "Delhi Public School", city: "Bengaluru" });
    });

    it("adopts the requestId from a 409 instead of treating it as an error", async () => {
      const http = vi
        .fn()
        .mockResolvedValue({ status: 409, body: { error: "open request exists", requestId: "req-existing", status: "awaiting_school" } });
      const ctx = makeCtx(http);

      const result = await passpercentAdapter.initiate!(ctx, makeInstitution());

      expect(result).toEqual({ remoteRequestId: "req-existing", remoteStatus: "awaiting_school" });
    });

    it("throws on a 409 that carries no requestId to adopt", async () => {
      const http = vi.fn().mockResolvedValue({ status: 409, body: { error: "some other conflict" } });
      const ctx = makeCtx(http);

      await expect(passpercentAdapter.initiate!(ctx, makeInstitution())).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // refresh / redeem
  // -------------------------------------------------------------------------

  describe("refresh", () => {
    it("maps pending -> PENDING without calling redeem", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { status: "pending" } });
      const result = await passpercentAdapter.refresh!(makeCtx(http), makeConnection());

      expect(result).toEqual({ kind: "PENDING", remoteStatus: "pending" });
      expect(http).toHaveBeenCalledTimes(1);
    });

    it("maps awaiting_school -> AWAITING_APPROVAL", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { status: "awaiting_school" } });
      const result = await passpercentAdapter.refresh!(makeCtx(http), makeConnection());

      expect(result).toEqual({ kind: "AWAITING_APPROVAL", remoteStatus: "awaiting_school" });
    });

    it("maps rejected -> REJECTED with rejectReason as detail", async () => {
      const http = vi
        .fn()
        .mockResolvedValue({ status: 200, body: { status: "rejected", rejectReason: "Declined by the institution" } });
      const result = await passpercentAdapter.refresh!(makeCtx(http), makeConnection());

      expect(result).toEqual({ kind: "REJECTED", remoteStatus: "rejected", detail: "Declined by the institution" });
    });

    it("on approved, redeems immediately and returns CONNECTED with the grant token, calling redeem exactly once and never logging the token", async () => {
      const token = "pp_pgrant_super_secret_value";
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: { status: "pending" } })
        .mockResolvedValueOnce({ status: 200, body: { status: "awaiting_school" } })
        .mockResolvedValueOnce({ status: 200, body: { status: "approved" } })
        .mockResolvedValueOnce({
          status: 200,
          body: {
            token,
            instId: "pp-inst-1",
            externalRef: "inst-1",
            scopes: ["profile:write", "results:write"],
            partner: { id: "p1", name: "IDAP", slug: "idap" },
            institution: { name: "Delhi Public School", city: "Bengaluru", slug: "dps-bengaluru" },
            warning: null,
          },
        });
      const ctx = makeCtx(http);
      const connection = makeConnection();

      const consoleSpies = [
        vi.spyOn(console, "log").mockImplementation(() => {}),
        vi.spyOn(console, "error").mockImplementation(() => {}),
        vi.spyOn(console, "warn").mockImplementation(() => {}),
        vi.spyOn(console, "info").mockImplementation(() => {}),
      ];

      const r1 = await passpercentAdapter.refresh!(ctx, connection);
      expect(r1.kind).toBe("PENDING");
      const r2 = await passpercentAdapter.refresh!(ctx, connection);
      expect(r2.kind).toBe("AWAITING_APPROVAL");
      const r3 = await passpercentAdapter.refresh!(ctx, connection);

      expect(r3).toEqual({
        kind: "CONNECTED",
        remoteStatus: "completed",
        grantToken: token,
        scopes: ["profile:write", "results:write"],
        remoteInstitution: { name: "Delhi Public School", city: "Bengaluru", slug: "dps-bengaluru" },
      });

      // redeem is the 4th call overall (poll, poll, poll, redeem) — exactly once.
      const redeemCalls = http.mock.calls.filter(([path]) => String(path).endsWith("/redeem"));
      expect(redeemCalls).toHaveLength(1);

      for (const spy of consoleSpies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(token);
        }
        spy.mockRestore();
      }
    });

    it("surfaces a redeem race (409) as REJECTED with the reconnect detail, not as a thrown error", async () => {
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: { status: "approved" } })
        .mockResolvedValueOnce({ status: 409, body: { error: "already redeemed" } });

      const result = await passpercentAdapter.refresh!(makeCtx(http), makeConnection());

      expect(result).toEqual({ kind: "REJECTED", remoteStatus: "rejected", detail: "already redeemed — reconnect from PassPercent" });
    });

    it("surfaces a redeem race (404) the same way as a 409", async () => {
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: { status: "approved" } })
        .mockResolvedValueOnce({ status: 404, body: {} });

      const result = await passpercentAdapter.refresh!(makeCtx(http), makeConnection());

      expect(result.kind).toBe("REJECTED");
      expect((result as { detail?: string }).detail).toBe("already redeemed — reconnect from PassPercent");
    });
  });

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  describe("sync", () => {
    it("runs schema -> PATCH -> PUTs ascending by year, in that exact order", async () => {
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: schemaBody() })
        .mockResolvedValueOnce({ status: 200, body: { updated: true } })
        .mockResolvedValueOnce({ status: 200, body: { updated: true, year: "2023-24" } })
        .mockResolvedValueOnce({ status: 200, body: { updated: true, year: "2024-25" } });

      const data = makeSyncData({
        results: [
          { id: "r2", level: "CLASS_10", academicYear: "2024-25", appeared: 50, passed: 45 },
          { id: "r1", level: "CLASS_10", academicYear: "2023-24", appeared: 40, passed: 36 },
        ],
      });

      const outcome = await passpercentAdapter.sync(makeCtx(http), makeConnection(), data);

      expect(outcome.status).toBe("SUCCESS");
      // The mutation-distinguishing assertion: exact call sequence, not just
      // "all four calls happened". An implementation that PUT-then-PATCHed,
      // or pushed years out of order, fails this even though it made the
      // same four calls.
      expect(callLog(http)).toEqual([
        "GET /api/partner/schema",
        "PATCH /api/partner/institution",
        "PUT /api/partner/institution/results/2023-24",
        "PUT /api/partner/institution/results/2024-25",
      ]);
    });

    it("aborts before any PUT when the profile PATCH fails, and reports FAILED", async () => {
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: schemaBody() })
        .mockResolvedValueOnce({ status: 400, body: { error: "Unknown field" } });

      const data = makeSyncData({
        results: [
          { id: "r1", level: "CLASS_10", academicYear: "2024-25", appeared: 50, passed: 45 },
          { id: "r2", level: "CLASS_10", academicYear: "2023-24", appeared: 40, passed: 36 },
        ],
      });

      const outcome = await passpercentAdapter.sync(makeCtx(http), makeConnection(), data);

      expect(outcome.status).toBe("FAILED");
      expect(callLog(http)).toEqual(["GET /api/partner/schema", "PATCH /api/partner/institution"]);
      expect(outcome.steps).toEqual([
        { step: "schema", ok: true },
        { step: "profile", ok: false, detail: expect.any(String) },
      ]);
    });

    it("continues after one year's PUT fails, still pushing the other year, yielding PARTIAL", async () => {
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: schemaBody() })
        .mockResolvedValueOnce({ status: 200, body: { updated: true } })
        .mockResolvedValueOnce({ status: 400, body: { error: "Stream not offered by this institution" } })
        .mockResolvedValueOnce({ status: 200, body: { updated: true } });

      const data = makeSyncData({
        results: [
          { id: "r1", level: "CLASS_10", academicYear: "2023-24", appeared: 40, passed: 36 },
          { id: "r2", level: "CLASS_10", academicYear: "2024-25", appeared: 50, passed: 45 },
        ],
      });

      const outcome = await passpercentAdapter.sync(makeCtx(http), makeConnection(), data);

      expect(outcome.status).toBe("PARTIAL");
      expect(callLog(http)).toEqual([
        "GET /api/partner/schema",
        "PATCH /api/partner/institution",
        "PUT /api/partner/institution/results/2023-24",
        "PUT /api/partner/institution/results/2024-25",
      ]);
      expect(outcome.steps).toEqual([
        { step: "schema", ok: true },
        { step: "profile", ok: true },
        { step: "results:2023-24", ok: false, detail: expect.any(String) },
        { step: "results:2024-25", ok: true },
      ]);
    });

    it("classifies a 403 needs_school_consent as FAILED with the verbatim message, and stops the run", async () => {
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: schemaBody() })
        .mockResolvedValueOnce({ status: 200, body: { updated: true } })
        .mockResolvedValueOnce({ status: 403, body: { reason: "needs_school_consent" } });

      const data = makeSyncData({
        results: [
          { id: "r1", level: "CLASS_10", academicYear: "2023-24", appeared: 40, passed: 36 },
          { id: "r2", level: "CLASS_10", academicYear: "2024-25", appeared: 50, passed: 45 },
        ],
      });

      const outcome = await passpercentAdapter.sync(makeCtx(http), makeConnection(), data);

      expect(outcome.status).toBe("FAILED");
      expect(outcome.error).toBe(
        "PassPercent: the school has not consented (or has withdrawn consent) — ask them to approve the connection on their PassPercent dashboard",
      );
      // Consent failure applies to every subsequent call too — the second
      // year's PUT must never be attempted.
      expect(callLog(http)).toEqual([
        "GET /api/partner/schema",
        "PATCH /api/partner/institution",
        "PUT /api/partner/institution/results/2023-24",
      ]);
    });

    it("throws ConnectorAuthError on a 401 from a grant call, instead of returning a FAILED outcome", async () => {
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: schemaBody() })
        .mockResolvedValueOnce({ status: 401, body: { error: "invalid token" } });

      await expect(passpercentAdapter.sync(makeCtx(http), makeConnection(), makeSyncData())).rejects.toBeInstanceOf(
        ConnectorAuthError,
      );
    });

    it("treats a 429 quota response as FAILED (not PARTIAL) and stops the run", async () => {
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: schemaBody() })
        .mockResolvedValueOnce({ status: 200, body: { updated: true } })
        .mockResolvedValueOnce({
          status: 429,
          body: { error: "Daily write cap reached", dailyWriteCap: 500, quotaRemaining: 0 },
        });

      const data = makeSyncData({
        results: [
          { id: "r1", level: "CLASS_10", academicYear: "2023-24", appeared: 40, passed: 36 },
          { id: "r2", level: "CLASS_10", academicYear: "2024-25", appeared: 50, passed: 45 },
        ],
      });

      const outcome = await passpercentAdapter.sync(makeCtx(http), makeConnection(), data);

      expect(outcome.status).toBe("FAILED");
      expect(outcome.error).toBe("Daily write cap reached");
      expect(callLog(http)).toEqual([
        "GET /api/partner/schema",
        "PATCH /api/partner/institution",
        "PUT /api/partner/institution/results/2023-24",
      ]);
    });

    it("resolves a topper photo under the size cap when the schema documents an encoding", async () => {
      const bytes = Buffer.from("small-fake-jpeg-bytes");
      const readPublicMedia = vi.fn(async () => ({ body: bytes, contentType: "image/jpeg" }));
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: schemaBody({ photoEncoding: "base64" }) })
        .mockResolvedValueOnce({ status: 200, body: { updated: true } })
        .mockResolvedValueOnce({ status: 200, body: { updated: true } });

      const data = makeSyncData({
        results: [
          {
            id: "r1",
            level: "CLASS_10",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            toppers: [{ name: "A. Rao", percentage: 99.2, rank: 1, photoUrl: "media/toppers/a.jpg" }],
          },
        ],
        readPublicMedia,
      });

      const outcome = await passpercentAdapter.sync(makeCtx(http), makeConnection(), data);

      expect(outcome.status).toBe("SUCCESS");
      expect(readPublicMedia).toHaveBeenCalledWith("media/toppers/a.jpg");

      const putCall = http.mock.calls[2];
      const body = putCall[1].body as { streams: { sslc: { toppers: Record<string, unknown>[] } } };
      const topper = body.streams.sslc.toppers[0];
      expect(topper.photoKey).toBeUndefined();
      expect(topper.photo).toBe(bytes.toString("base64"));
      expect(outcome.warnings.some((w) => w.includes("does not document an inline encoding"))).toBe(false);
    });

    it("drops an oversized topper photo (>200KB raw) with a warning, but still sends the rest of the topper", async () => {
      const oversized = Buffer.alloc(210_000);
      const readPublicMedia = vi.fn(async () => ({ body: oversized, contentType: "image/jpeg" }));
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: schemaBody({ photoEncoding: "base64" }) })
        .mockResolvedValueOnce({ status: 200, body: { updated: true } })
        .mockResolvedValueOnce({ status: 200, body: { updated: true } });

      const data = makeSyncData({
        results: [
          {
            id: "r1",
            level: "CLASS_10",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            toppers: [{ name: "A. Rao", percentage: 99.2, rank: 1, photoUrl: "media/toppers/a.jpg" }],
          },
        ],
        readPublicMedia,
      });

      const outcome = await passpercentAdapter.sync(makeCtx(http), makeConnection(), data);

      expect(outcome.status).toBe("SUCCESS");
      const putCall = http.mock.calls[2];
      const body = putCall[1].body as { streams: { sslc: { toppers: Record<string, unknown>[] } } };
      const topper = body.streams.sslc.toppers[0];
      expect(topper.photoKey).toBeUndefined();
      expect(topper.photo).toBeUndefined();
      expect(topper.name).toBe("A. Rao");
      expect(outcome.warnings.some((w) => w.includes("over PassPercent's ~200KB raw cap"))).toBe(true);
    });

    it("skips all topper photos with exactly one run-level warning when the schema documents no encoding, without calling readPublicMedia", async () => {
      const readPublicMedia = vi.fn(async () => ({ body: Buffer.from("x"), contentType: "image/jpeg" }));
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: schemaBody() }) // no photoEncoding
        .mockResolvedValueOnce({ status: 200, body: { updated: true } })
        .mockResolvedValueOnce({ status: 200, body: { updated: true } })
        .mockResolvedValueOnce({ status: 200, body: { updated: true } });

      const data = makeSyncData({
        results: [
          {
            id: "r1",
            level: "CLASS_10",
            academicYear: "2023-24",
            appeared: 10,
            passed: 9,
            toppers: [{ name: "A", percentage: 99, rank: 1, photoUrl: "media/a.jpg" }],
          },
          {
            id: "r2",
            level: "CLASS_10",
            academicYear: "2024-25",
            appeared: 10,
            passed: 9,
            toppers: [{ name: "B", percentage: 98, rank: 1, photoUrl: "media/b.jpg" }],
          },
        ],
        readPublicMedia,
      });

      const outcome = await passpercentAdapter.sync(makeCtx(http), makeConnection(), data);

      expect(outcome.status).toBe("SUCCESS");
      expect(readPublicMedia).not.toHaveBeenCalled();

      const warningMatches = outcome.warnings.filter((w) => w.includes("does not document an inline encoding"));
      expect(warningMatches).toEqual(["topper photos skipped: PassPercent schema does not document an inline encoding"]);

      for (const call of [http.mock.calls[2], http.mock.calls[3]]) {
        const body = call[1].body as { streams: { sslc: { toppers: Record<string, unknown>[] } } };
        const topper = body.streams.sslc.toppers[0];
        expect(topper.photoKey).toBeUndefined();
        expect(topper.photo).toBeUndefined();
      }
    });

    it("throws when called without a grant token", async () => {
      const http = vi.fn();
      const connection = makeConnection({ grantToken: undefined });

      await expect(passpercentAdapter.sync(makeCtx(http), connection, makeSyncData())).rejects.toThrow();
      expect(http).not.toHaveBeenCalled();
    });
  });
});
