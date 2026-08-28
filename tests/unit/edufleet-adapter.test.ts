import { describe, expect, it, vi } from "vitest";
import type { ConnectorHttp } from "@/lib/connectors/http";
import type { AdapterContext, ConnectionState, InstitutionSummary, SyncSourceData } from "@/lib/connectors/types";
import { ConnectorAuthError } from "@/lib/connectors/types";
import { edufleetAdapter } from "@/lib/connectors/edufleet";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLATFORM_KEY = "ef_pkey_test_secret";

function makeCtx(http: ConnectorHttp): AdapterContext {
  return { baseUrl: "https://api.edufleet.example", platformKey: PLATFORM_KEY, http };
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
    remoteRequestId: "req-abc",
    ...overrides,
  };
}

describe("edufleetAdapter", () => {
  it("declares REQUEST_APPROVE_REDEEM as its connect mode", () => {
    expect(edufleetAdapter.platform).toBe("EDUFLEET");
    expect(edufleetAdapter.connectMode).toBe("REQUEST_APPROVE_REDEEM");
  });

  describe("initiate", () => {
    it("submits a connection request and returns the new id on 201", async () => {
      const http = vi.fn().mockResolvedValue({ status: 201, body: { requestId: "req-abc", status: "pending" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.initiate!(ctx, makeInstitution());

      expect(result).toEqual({ remoteRequestId: "req-abc", remoteStatus: "pending" });
      expect(http).toHaveBeenCalledTimes(1);
      const [path, init] = http.mock.calls[0];
      expect(path).toBe("/api/partner/connection-requests");
      expect(init.method).toBe("POST");
      expect(init.token).toBe(PLATFORM_KEY);
    });

    it("MUTATION-DISTINGUISHING: an existing open request is adopted, not treated as a failure", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 409,
        body: { error: "duplicate_open_request", requestId: "req-existing", status: "awaiting_school" },
      });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.initiate!(ctx, makeInstitution());

      expect(result).toEqual({ remoteRequestId: "req-existing", remoteStatus: "awaiting_school" });
    });

    it("throws on a 409 that carries no requestId to adopt", async () => {
      const http = vi.fn().mockResolvedValue({ status: 409, body: { error: "duplicate_open_request" } });
      const ctx = makeCtx(http);

      await expect(edufleetAdapter.initiate!(ctx, makeInstitution())).rejects.toThrow(
        /submitting the connection request failed \(status 409\)/,
      );
    });

    it("throws on any other non-2xx status", async () => {
      const http = vi.fn().mockResolvedValue({ status: 500, body: { error: "internal" } });
      const ctx = makeCtx(http);

      await expect(edufleetAdapter.initiate!(ctx, makeInstitution())).rejects.toThrow(/status 500/);
    });

    it("surfaces eduFleet's reason and first detail so a 400 is diagnosable", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 400,
        body: {
          error: "Validation failed",
          reason: "validation_failed",
          details: [{ field: "body", message: "scopes must include at least one capability" }],
        },
      });
      const ctx = makeCtx(http);

      await expect(edufleetAdapter.initiate!(ctx, makeInstitution())).rejects.toThrow(
        /status 400 — validation_failed — scopes must include at least one capability/,
      );
    });

    it("MUTATION-DISTINGUISHING: a remote body cannot smuggle unbounded text into lastError", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 400,
        body: { reason: "x".repeat(500), details: [{ message: "y".repeat(500) }] },
      });
      const ctx = makeCtx(http);

      await expect(edufleetAdapter.initiate!(ctx, makeInstitution())).rejects.toThrow(
        /^eduFleet: submitting the connection request failed \(.{1,200}\)$/,
      );
    });

    it("sends externalRef, payload.institutionName and a non-empty scopes array, and never the platform key in the body", async () => {
      const http = vi.fn().mockResolvedValue({ status: 201, body: { requestId: "req-abc", status: "pending" } });
      const ctx = makeCtx(http);

      await edufleetAdapter.initiate!(ctx, makeInstitution({ institutionId: "inst-42", name: "St. Xavier's" }));

      const [, init] = http.mock.calls[0];
      const body = init.body as Record<string, unknown>;
      expect(body.externalRef).toBe("inst-42");
      expect((body.payload as Record<string, unknown>).institutionName).toBe("St. Xavier's");
      expect(init.body).toMatchObject({ scopes: ["jobs:write"] });

      // The platform key must live only in the Authorization header (via
      // `init.token`), never anywhere inside the request body.
      expect(JSON.stringify(body)).not.toContain(PLATFORM_KEY);
      expect(body.platformKey).toBeUndefined();
      expect(body.token).toBeUndefined();
    });

    it("MUTATION-DISTINGUISHING: the requested scopes are non-empty — eduFleet 400s on an empty array", async () => {
      const http = vi.fn().mockResolvedValue({ status: 201, body: { requestId: "req-abc", status: "pending" } });
      const ctx = makeCtx(http);

      await edufleetAdapter.initiate!(ctx, makeInstitution());

      const [, init] = http.mock.calls[0];
      const scopes = (init.body as { scopes?: unknown }).scopes;
      expect(Array.isArray(scopes)).toBe(true);
      expect(scopes as string[]).toHaveLength(1);
      expect(scopes as string[]).toContain("jobs:write");
    });
  });

  describe("refresh", () => {
    it("throws when called without a remoteRequestId", async () => {
      const http = vi.fn();
      const ctx = makeCtx(http);

      await expect(edufleetAdapter.refresh!(ctx, makeConnection({ remoteRequestId: undefined }))).rejects.toThrow(
        /refresh requires a remoteRequestId/,
      );
      expect(http).not.toHaveBeenCalled();
    });

    it("throws when polling the connection request fails", async () => {
      const http = vi.fn().mockResolvedValue({ status: 500, body: { error: "internal" } });
      const ctx = makeCtx(http);

      await expect(edufleetAdapter.refresh!(ctx, makeConnection())).rejects.toThrow(
        /polling the connection request failed \(status 500\)/,
      );
    });

    it("maps pending to PENDING", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { status: "pending" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.refresh!(ctx, makeConnection());

      expect(result).toEqual({ kind: "PENDING", remoteStatus: "pending" });
      const [path, init] = http.mock.calls[0];
      expect(path).toBe("/api/partner/connection-requests/req-abc");
      expect(init.method).toBe("GET");
      expect(init.token).toBe(PLATFORM_KEY);
    });

    it("maps awaiting_school to AWAITING_APPROVAL", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { status: "awaiting_school" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.refresh!(ctx, makeConnection());

      expect(result).toEqual({ kind: "AWAITING_APPROVAL", remoteStatus: "awaiting_school" });
    });

    it("maps rejected to REJECTED, carrying the school's rejectReason as detail", async () => {
      const http = vi
        .fn()
        .mockResolvedValue({ status: 200, body: { status: "rejected", rejectReason: "Declined by the school" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.refresh!(ctx, makeConnection());

      expect(result).toEqual({ kind: "REJECTED", remoteStatus: "rejected", detail: "Declined by the school" });
    });

    it("throws on an unrecognized status, naming it rather than silently resembling PENDING", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { status: "mystery" } });
      const ctx = makeCtx(http);

      await expect(edufleetAdapter.refresh!(ctx, makeConnection())).rejects.toThrow(/unrecognized status "mystery"/);
    });

    it("completed returns a non-CONNECTED result carrying an actionable detail", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { status: "completed" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.refresh!(ctx, makeConnection());

      expect(result.kind).not.toBe("CONNECTED");
      expect((result as { detail?: string }).detail).toBeTruthy();
    });

    it("MUTATION-DISTINGUISHING: polling a connection that already holds a grant keeps it CONNECTED", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { status: "completed" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.refresh!(
        ctx,
        makeConnection({ grantToken: "ef_pgrant_live_abc", scopes: ["jobs:write"] }),
      );

      expect(result.kind).toBe("CONNECTED");
      expect(result).toMatchObject({ grantToken: "ef_pgrant_live_abc", scopes: ["jobs:write"] });
      // Exactly one call: the poll. Re-fetching the school would spend a grant call.
      expect(http).toHaveBeenCalledTimes(1);
    });

    it("still reports REJECTED for a completed request when no grant was ever held", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { status: "completed" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.refresh!(ctx, makeConnection());

      expect(result.kind).toBe("REJECTED");
      expect(result).toMatchObject({ detail: expect.stringContaining("already redeemed") });
    });

    describe("approved -> redeem", () => {
      function mockApprovedThenRedeem(
        http: ReturnType<typeof vi.fn>,
        redeemResponse: { status: number; body: unknown },
      ) {
        http.mockResolvedValueOnce({ status: 200, body: { status: "approved" } }).mockResolvedValueOnce(redeemResponse);
      }

      it("redeems and returns CONNECTED with the grant token and scopes", async () => {
        const http = vi.fn();
        mockApprovedThenRedeem(http, {
          status: 200,
          body: {
            token: "ef_pgrant_abc123",
            schoolId: "school-1",
            externalRef: "inst-1",
            scopes: ["jobs:write"],
            prefix: "ef_pgrant_abc1",
          },
        });
        http.mockResolvedValueOnce({
          status: 200,
          body: { schoolId: "school-1", schoolName: "Delhi Public School", city: "Bengaluru", plan: "free" },
        });
        const ctx = makeCtx(http);

        const result = await edufleetAdapter.refresh!(ctx, makeConnection());

        expect(result.kind).toBe("CONNECTED");
        if (result.kind !== "CONNECTED") throw new Error("unreachable");
        expect(result.grantToken).toBe("ef_pgrant_abc123");
        expect(result.scopes).toEqual(["jobs:write"]);
        expect(result.remoteInstitution).toEqual({ name: "Delhi Public School", city: "Bengaluru" });

        const redeemCall = http.mock.calls[1];
        expect(redeemCall[0]).toBe("/api/partner/connection-requests/req-abc/redeem");
        expect(redeemCall[1].method).toBe("POST");
        expect(redeemCall[1].token).toBe(PLATFORM_KEY);

        const followUpCall = http.mock.calls[2];
        expect(followUpCall[0]).toBe("/api/partner/school");
        expect(followUpCall[1].method).toBe("GET");
        // The follow-up call must use the just-minted grant, never the
        // platform key.
        expect(followUpCall[1].token).toBe("ef_pgrant_abc123");
      });

      it("MUTATION-DISTINGUISHING: slug has no source in eduFleet and is never invented", async () => {
        const http = vi.fn();
        mockApprovedThenRedeem(http, {
          status: 200,
          body: { token: "ef_pgrant_xyz789", scopes: ["jobs:write"] },
        });
        http.mockResolvedValueOnce({
          status: 200,
          body: { schoolName: "St. Xavier's High School", city: "Mangaluru" },
        });
        const ctx = makeCtx(http);

        const result = await edufleetAdapter.refresh!(ctx, makeConnection());

        if (result.kind !== "CONNECTED") throw new Error("expected CONNECTED");
        expect(result.remoteInstitution?.slug).toBeUndefined();
        // The assertion above passes vacuously if `remoteInstitution` itself
        // is undefined (optional chaining short-circuits to `undefined`,
        // same as a populated object with no slug). Assert a field that
        // must be present to prove the object itself actually came back.
        expect(result.remoteInstitution?.name).toBe("St. Xavier's High School");
      });

      it("MUTATION-DISTINGUISHING: a cosmetic lookup failure never costs the grant", async () => {
        const http = vi.fn();
        mockApprovedThenRedeem(http, {
          status: 200,
          body: { token: "ef_pgrant_keep_me", scopes: ["jobs:write"] },
        });
        // The follow-up school lookup fails outright (a plain 500) — this
        // must not stop the just-redeemed grant from coming back.
        http.mockResolvedValueOnce({ status: 500, body: { error: "internal" } });
        const ctx = makeCtx(http);

        const result = await edufleetAdapter.refresh!(ctx, makeConnection());

        expect(result.kind).toBe("CONNECTED");
        if (result.kind !== "CONNECTED") throw new Error("unreachable");
        expect(result.grantToken).toBe("ef_pgrant_keep_me");
      });

      it("a follow-up call that throws outright (network failure) also never costs the grant", async () => {
        const http = vi.fn();
        mockApprovedThenRedeem(http, {
          status: 200,
          body: { token: "ef_pgrant_keep_me_too", scopes: ["jobs:write"] },
        });
        http.mockRejectedValueOnce(new Error("network down"));
        const ctx = makeCtx(http);

        const result = await edufleetAdapter.refresh!(ctx, makeConnection());

        expect(result.kind).toBe("CONNECTED");
        if (result.kind !== "CONNECTED") throw new Error("unreachable");
        expect(result.grantToken).toBe("ef_pgrant_keep_me_too");
        expect(result.remoteInstitution).toBeUndefined();
      });

      it("a 401 reason `revoked` on the follow-up call throws ConnectorAuthError, and the grant token appears nowhere in it", async () => {
        const http = vi.fn();
        mockApprovedThenRedeem(http, {
          status: 200,
          body: { token: "ef_pgrant_secret_dead_on_arrival", scopes: ["jobs:write"] },
        });
        http.mockResolvedValueOnce({ status: 401, body: { reason: "revoked" } });
        const ctx = makeCtx(http);

        let caught: unknown;
        try {
          await edufleetAdapter.refresh!(ctx, makeConnection());
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(ConnectorAuthError);
        expect((caught as Error).message).not.toContain("ef_pgrant_secret_dead_on_arrival");
      });

      it("a 401 with a different reason on the follow-up call does NOT throw ConnectorAuthError — the grant still comes back", async () => {
        const http = vi.fn();
        mockApprovedThenRedeem(http, {
          status: 200,
          body: { token: "ef_pgrant_still_ok", scopes: ["jobs:write"] },
        });
        http.mockResolvedValueOnce({ status: 401, body: { reason: "partner_inactive" } });
        const ctx = makeCtx(http);

        const result = await edufleetAdapter.refresh!(ctx, makeConnection());

        expect(result.kind).toBe("CONNECTED");
        if (result.kind !== "CONNECTED") throw new Error("unreachable");
        expect(result.grantToken).toBe("ef_pgrant_still_ok");
      });

      it('MUTATION-DISTINGUISHING: `partner_revoked` — a distinct failure that merely contains the substring "revoked" — does NOT throw ConnectorAuthError', async () => {
        const http = vi.fn();
        mockApprovedThenRedeem(http, {
          status: 200,
          body: { token: "ef_pgrant_survives_the_substring", scopes: ["jobs:write"] },
        });
        // `partner_revoked` means the *partner registration* was revoked —
        // nothing a school can act on — as distinct from `revoked`, which
        // for a grant call means the school itself disconnected. The two
        // reason strings share a substring; the check at `resp.status ===
        // 401 && ... === "revoked"` must stay an exact match, not
        // `.includes("revoked")`.
        http.mockResolvedValueOnce({ status: 401, body: { reason: "partner_revoked" } });
        const ctx = makeCtx(http);

        const result = await edufleetAdapter.refresh!(ctx, makeConnection());

        expect(result.kind).toBe("CONNECTED");
        if (result.kind !== "CONNECTED") throw new Error("unreachable");
        expect(result.grantToken).toBe("ef_pgrant_survives_the_substring");
      });

      it("returns a non-CONNECTED result carrying an actionable detail on a 409 redeem race (api-map §5: already_redeemed and not_approved take this identical, undifferentiated path — body.reason is never read)", async () => {
        const http = vi.fn();
        mockApprovedThenRedeem(http, { status: 409, body: { error: "already_redeemed" } });
        const ctx = makeCtx(http);

        const result = await edufleetAdapter.refresh!(ctx, makeConnection());

        expect(result.kind).not.toBe("CONNECTED");
        expect((result as { detail?: string }).detail).toBe(
          "already redeemed (or no longer approved) — reconnect from eduFleet if needed",
        );
      });

      it("throws on any other non-2xx redeem status", async () => {
        const http = vi.fn();
        mockApprovedThenRedeem(http, { status: 500, body: { error: "internal" } });
        const ctx = makeCtx(http);

        await expect(edufleetAdapter.refresh!(ctx, makeConnection())).rejects.toThrow(
          /redeeming the connection request failed \(status 500\)/,
        );
      });
    });
  });

  describe("sync", () => {
    it("returns PARTIAL with a single failed step and a warning naming the reason, without throwing or calling out", async () => {
      const http = vi.fn();
      const ctx = makeCtx(http);
      const connection = makeConnection({ grantToken: "ef_pgrant_whatever" });
      const data: SyncSourceData = { institution: {}, results: [], readPublicMedia: vi.fn() };

      const outcome = await edufleetAdapter.sync(ctx, connection, data);

      expect(outcome.status).toBe("PARTIAL");
      expect(outcome.steps).toEqual([{ step: "vacancies", ok: false, detail: expect.any(String) }]);
      expect(outcome.warnings.length).toBeGreaterThan(0);
      expect(outcome.warnings.some((w) => /vacanc/i.test(w))).toBe(true);
      expect(http).not.toHaveBeenCalled();
    });
  });
});
