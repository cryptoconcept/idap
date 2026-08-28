import { describe, expect, it, vi } from "vitest";
import type { ConnectorHttp } from "@/lib/connectors/http";
import type { AdapterContext, ConnectionState, InstitutionSummary, SyncSourceData } from "@/lib/connectors/types";
import { ConnectorAuthError, ConnectorRejectedError } from "@/lib/connectors/types";
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

      expect(result).toEqual({ remoteRequestId: "req-abc", remoteStatus: "pending", kind: "PENDING" });
      expect(http).toHaveBeenCalledTimes(1);
      const [path, init] = http.mock.calls[0];
      expect(path).toBe("/api/partner/connection-requests");
      expect(init.method).toBe("POST");
      expect(init.token).toBe(PLATFORM_KEY);
    });

    it("MUTATION-DISTINGUISHING: an existing open request is adopted, not treated as a failure", async () => {
      // The Path-A body is exactly what eduFleet sends: `{error, reason,
      // requestId?}` and nothing else (`route.ts:30` + `jsonError`,
      // `partner-auth.ts:26-28`). There is no `status` key on a 409 ever, so
      // an adopted request's state is unknowable until the first poll and the
      // adapter must fall back to "pending".
      const http = vi.fn().mockResolvedValue({
        status: 409,
        body: {
          error: 'A request for externalRef "inst-1" is already open',
          reason: "duplicate_open_request",
          requestId: "req-existing",
        },
      });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.initiate!(ctx, makeInstitution());

      expect(result).toEqual({
        remoteRequestId: "req-existing",
        remoteStatus: "pending",
        kind: "PENDING",
      });
    });

    it("MUTATION-DISTINGUISHING: refuses an auto-remap clash instead of adopting another institution's request", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 409,
        body: {
          error: "Another open request already targets this school",
          reason: "duplicate_open_request",
          requestId: "req-belonging-to-someone-else",
        },
      });
      const ctx = makeCtx(http);

      await expect(edufleetAdapter.initiate!(ctx, makeInstitution())).rejects.toThrow(
        /another institution already has an open connection request for this school/,
      );
    });

    it("a 201 auto-remap (`awaiting_school`) reports AWAITING_APPROVAL, not PENDING", async () => {
      // eduFleet auto-remaps an `externalRef` it has matched to a school
      // before: the request is created already matched and comes back past
      // `pending`, so a re-connect must not read as "Requested".
      const http = vi
        .fn()
        .mockResolvedValue({ status: 201, body: { requestId: "req-remap", status: "awaiting_school" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.initiate!(ctx, makeInstitution());

      expect(result).toEqual({
        remoteRequestId: "req-remap",
        remoteStatus: "awaiting_school",
        kind: "AWAITING_APPROVAL",
      });
    });

    it('MUTATION-DISTINGUISHING: a 201 with no requestId throws rather than persisting the string "undefined"', async () => {
      // Unguarded, `String(undefined)` stores "undefined" as the
      // remoteRequestId and every later poll requests
      // `/api/partner/connection-requests/undefined` → 404 → a generic 502
      // with the real cause invisible.
      const http = vi.fn().mockResolvedValue({ status: 201, body: { status: "pending" } });
      const ctx = makeCtx(http);

      await expect(edufleetAdapter.initiate!(ctx, makeInstitution())).rejects.toThrow(
        /the 201 response carried no requestId/,
      );
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

    it("sends every payload field eduFleet's ConnectionPayload accepts and has a source for", async () => {
      // Step 2 is a human admin matching this request to a real school; a
      // name-only request is what produces a wrong match. `board` and `type`
      // are accepted by eduFleet but have no source on `InstitutionSummary`,
      // so they must not appear.
      const http = vi.fn().mockResolvedValue({ status: 201, body: { requestId: "req-abc", status: "pending" } });
      const ctx = makeCtx(http);

      await edufleetAdapter.initiate!(ctx, makeInstitution());

      const [, init] = http.mock.calls[0];
      const payload = (init.body as { payload: Record<string, unknown> }).payload;
      expect(payload).toEqual({
        institutionName: "Delhi Public School",
        city: "Bengaluru",
        district: "Bengaluru Urban",
        state: "KA",
        phone: "9999999999",
        email: "principal@dps.example",
        website: "https://dps.example",
        contactName: "Principal",
      });
      expect(payload.board).toBeUndefined();
      expect(payload.type).toBeUndefined();
    });

    it("MUTATION-DISTINGUISHING: a sparse institution sends no empty optional keys at all", async () => {
      const http = vi.fn().mockResolvedValue({ status: 201, body: { requestId: "req-abc", status: "pending" } });
      const ctx = makeCtx(http);

      // Deliberately not `makeInstitution({...})` — the fixture populates
      // every optional field, and overriding them one by one would leave the
      // keys present with `undefined` values, which is the very thing under
      // test.
      await edufleetAdapter.initiate!(ctx, { institutionId: "inst-sparse", name: "Nameless High" });

      const [, init] = http.mock.calls[0];
      const body = init.body as Record<string, unknown>;
      const payload = body.payload as Record<string, unknown>;
      // `Object.keys` (not `toEqual`) is the point: an explicit
      // `city: undefined` passes a `toEqual` against `{institutionName}` but
      // is still a key on the wire.
      expect(Object.keys(payload)).toEqual(["institutionName"]);
      expect("city" in payload).toBe(false);
      expect("district" in payload).toBe(false);
      expect("phone" in payload).toBe(false);
      expect(body.scopes).toEqual(["jobs:write"]);
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

    it("MUTATION-DISTINGUISHING: refuses to act on a request belonging to another externalRef", async () => {
      // "approved" is deliberate: without the guard this proceeds to redeem,
      // so the assertion on the call count fails as loudly as the throw.
      const http = vi.fn().mockResolvedValue({
        status: 200,
        body: { requestId: "req-abc", externalRef: "inst-99", status: "approved" },
      });
      const ctx = makeCtx(http);

      await expect(edufleetAdapter.refresh!(ctx, makeConnection())).rejects.toThrow(
        /belongs to externalRef "inst-99", not "inst-1"/,
      );
      // The poll, and nothing after it — no redeem was attempted.
      expect(http).toHaveBeenCalledTimes(1);
    });

    it("MUTATION-DISTINGUISHING: a 500-character externalRef from the remote side cannot flood lastError", async () => {
      // The file's own policy (`describeFailure`/`clip`): remote-derived text
      // reaching `lastError` is bounded, because `lastError` is persisted with
      // no `maxlength` and returned to the browser.
      const hostile = "z".repeat(500);
      const http = vi.fn().mockResolvedValue({
        status: 200,
        body: { requestId: "req-abc", externalRef: hostile, status: "approved" },
      });
      const ctx = makeCtx(http);

      let caught: unknown;
      try {
        await edufleetAdapter.refresh!(ctx, makeConnection());
      } catch (error) {
        caught = error;
      }

      const message = (caught as Error).message;
      expect(message).toMatch(/refusing to act on it$/);
      expect(message).not.toContain(hostile);
      expect(message).toContain("z".repeat(80));
      expect(message).not.toContain("z".repeat(81));
      expect(message.length).toBeLessThan(200);
    });

    it("proceeds normally when the polled externalRef matches", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 200,
        body: { requestId: "req-abc", externalRef: "inst-1", status: "pending" },
      });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.refresh!(ctx, makeConnection());

      expect(result).toMatchObject({ kind: "PENDING", remoteStatus: "pending" });
    });

    it("does not break when eduFleet omits externalRef from the poll response", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { status: "pending" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.refresh!(ctx, makeConnection());

      expect(result).toMatchObject({ kind: "PENDING" });
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

  // ---------------------------------------------------------------------------
  // createJob / patchJob / closeJob — the wire layer for Task 2's builders.
  // These methods take an already-built body (or, for closeJob, build their
  // own fixed one) and classify the response; they never construct or
  // validate a body themselves.
  // ---------------------------------------------------------------------------

  const GRANT_TOKEN = "ef_pgrant_live_abc";

  function makeGrantConnection(overrides: Partial<ConnectionState> = {}): ConnectionState {
    return makeConnection({ grantToken: GRANT_TOKEN, scopes: ["jobs:write"], ...overrides });
  }

  const AGGREGATED_BODY = {
    externalJobId: "vac-1",
    title: "Mathematics Teacher",
    subject: "Mathematics",
    description: "Teach mathematics to grades 9-10.",
    institutionName: "Delhi Public School",
    city: "Bengaluru",
  };

  const SCHOOL_BODY = {
    externalJobId: "vac-1",
    title: "Mathematics Teacher",
    subject: "Mathematics",
    description: "Teach mathematics to grades 9-10.",
    city: "Bengaluru",
  };

  describe("createJob", () => {
    it("AGGREGATED: posts to /api/partner/jobs with the platform key and returns OK carrying jobId and claimState", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 201,
        body: {
          jobId: "job-1",
          externalJobId: "vac-1",
          slug: "maths-teacher",
          status: "active",
          claimStatus: "unclaimed",
          publicUrl: "https://edufleet.example/jobs/maths-teacher/job-1",
          claimUrl: "https://edufleet.example/claim/tok-1",
        },
      });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.createJob!(ctx, makeConnection(), AGGREGATED_BODY, "AGGREGATED");

      expect(result).toEqual({ kind: "OK", jobId: "job-1", claimState: "unclaimed" });
      expect(http).toHaveBeenCalledTimes(1);
      const [path, init] = http.mock.calls[0];
      expect(path).toBe("/api/partner/jobs");
      expect(init.method).toBe("POST");
      expect(init.token).toBe(PLATFORM_KEY);
      expect(init.body).toEqual(AGGREGATED_BODY);
    });

    it("SCHOOL_POSTED: posts to /api/partner/school/jobs with the grant token and returns OK with no claimState", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 201,
        body: {
          jobId: "job-2",
          externalJobId: "vac-1",
          status: "active",
          featured: false,
          publicUrl: "https://edufleet.example/jobs/maths-teacher/job-2",
        },
      });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.createJob!(
        ctx,
        makeGrantConnection(),
        SCHOOL_BODY,
        "SCHOOL_POSTED",
      );

      expect(result).toEqual({ kind: "OK", jobId: "job-2" });
      expect("claimState" in (result as object)).toBe(false);
      const [path, init] = http.mock.calls[0];
      expect(path).toBe("/api/partner/school/jobs");
      expect(init.method).toBe("POST");
      expect(init.token).toBe(GRANT_TOKEN);
      expect(init.body).toEqual(SCHOOL_BODY);
    });

    it("throws when SCHOOL_POSTED is called on a connection with no grant token", async () => {
      const http = vi.fn();
      const ctx = makeCtx(http);

      await expect(
        edufleetAdapter.createJob!(ctx, makeConnection({ grantToken: undefined }), SCHOOL_BODY, "SCHOOL_POSTED"),
      ).rejects.toThrow(/grant token/);
      expect(http).not.toHaveBeenCalled();
    });

    it("MUTATION-DISTINGUISHING: a 403 returns kind BLOCKED and does not throw — two of eduFleet's four triggers are reversible", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 403,
        body: {
          error: "This listing has been claimed by the school and can no longer be edited by a partner key",
          reason: "claimed",
        },
      });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.createJob!(ctx, makeConnection(), AGGREGATED_BODY, "AGGREGATED");

      expect(result).toEqual({
        kind: "BLOCKED",
        reason: "claimed",
        detail: expect.stringContaining("403"),
      });
    });

    it("a 403 upgrade_required returns BLOCKED with a reason naming the plan cap", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 403,
        body: { error: "This school's plan has no active-job slots left", reason: "upgrade_required" },
      });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.createJob!(ctx, makeGrantConnection(), SCHOOL_BODY, "SCHOOL_POSTED");

      expect(result).toEqual({
        kind: "BLOCKED",
        reason: "upgrade_required",
        detail: expect.any(String),
      });
    });

    it("MUTATION-DISTINGUISHING: a 409 carries the response's OWN contract field, not the contract the caller used", async () => {
      // Caller pushed via AGGREGATED, but eduFleet reports the colliding
      // externalJobId is actually owned by the "school" (Contract Two) side —
      // exactly the cross-contract collision api-map §4 describes. A mutant
      // that echoes the caller's own contract ("AGGREGATED") instead of the
      // response's ("school") must fail this assertion.
      const http = vi.fn().mockResolvedValue({
        status: 409,
        body: {
          error: 'A job with externalJobId "vac-1" already exists — PATCH it instead',
          reason: "duplicate_external_job",
          jobId: "job-owned-by-school",
          contract: "school",
        },
      });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.createJob!(ctx, makeConnection(), AGGREGATED_BODY, "AGGREGATED");

      expect(result).toEqual({
        kind: "CONFLICT",
        ownedByContract: "school",
        // The existing job's id, kept rather than dropped: it is the only
        // handle IDAP is ever offered on an advert it created but failed to
        // record, and without it that advert can never be closed.
        jobId: "job-owned-by-school",
        detail: expect.any(String),
      });
    });

    it("MUTATION-DISTINGUISHING: a 400 throws ConnectorRejectedError, not a plain Error, carrying eduFleet's own words", async () => {
      // A 400 is deterministic and has already cost a write unit. Telling
      // these apart from an outage is what stops a caller writing "try again
      // shortly" over a refusal that will repeat identically — at one of the
      // school's 100 daily units per attempt.
      const http = vi.fn().mockResolvedValue({
        status: 400,
        body: {
          error: "Validation failed",
          reason: "validation_failed",
          details: [{ field: "body", message: '"Astrophysics" is not in the job taxonomy' }],
        },
      });
      const ctx = makeCtx(http);

      const error = await edufleetAdapter
        .createJob!(ctx, makeConnection(), AGGREGATED_BODY, "AGGREGATED")
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConnectorRejectedError);
      expect((error as ConnectorRejectedError).reason).toBe("validation_failed");
      expect((error as ConnectorRejectedError).detail).toBe('"Astrophysics" is not in the job taxonomy');
      expect(http).toHaveBeenCalledTimes(1); // never retried
    });

    it("a 500 stays a plain Error — an outage genuinely is worth retrying", async () => {
      const http = vi.fn().mockResolvedValue({ status: 500, body: { error: "boom" } });
      const ctx = makeCtx(http);

      const error = await edufleetAdapter
        .createJob!(ctx, makeConnection(), AGGREGATED_BODY, "AGGREGATED")
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ConnectorRejectedError);
    });

    it("throws when a 409 carries no contract field to trust", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 409,
        body: { error: "duplicate", reason: "duplicate_external_job", jobId: "job-x" },
      });
      const ctx = makeCtx(http);

      await expect(
        edufleetAdapter.createJob!(ctx, makeConnection(), AGGREGATED_BODY, "AGGREGATED"),
      ).rejects.toThrow(/contract/);
    });

    it("a 401 revoked throws ConnectorAuthError", async () => {
      const http = vi.fn().mockResolvedValue({ status: 401, body: { error: "Grant revoked", reason: "revoked" } });
      const ctx = makeCtx(http);

      await expect(
        edufleetAdapter.createJob!(ctx, makeGrantConnection(), SCHOOL_BODY, "SCHOOL_POSTED"),
      ).rejects.toBeInstanceOf(ConnectorAuthError);
    });

    it("a 401 with a different reason throws a plain Error, not ConnectorAuthError", async () => {
      const http = vi
        .fn()
        .mockResolvedValue({ status: 401, body: { error: "Partner inactive", reason: "partner_inactive" } });
      const ctx = makeCtx(http);

      let caught: unknown;
      try {
        await edufleetAdapter.createJob!(ctx, makeConnection(), AGGREGATED_BODY, "AGGREGATED");
      } catch (error) {
        caught = error;
      }
      expect(caught).not.toBeInstanceOf(ConnectorAuthError);
      expect(caught).toBeInstanceOf(Error);
    });

    it("throws on any other non-2xx status", async () => {
      const http = vi.fn().mockResolvedValue({ status: 500, body: { error: "internal" } });
      const ctx = makeCtx(http);

      await expect(
        edufleetAdapter.createJob!(ctx, makeConnection(), AGGREGATED_BODY, "AGGREGATED"),
      ).rejects.toThrow(/status 500/);
    });

    it("MUTATION-DISTINGUISHING: a success response with no jobId throws rather than returning an empty id", async () => {
      const http = vi.fn().mockResolvedValue({ status: 201, body: { status: "active" } });
      const ctx = makeCtx(http);

      await expect(
        edufleetAdapter.createJob!(ctx, makeConnection(), AGGREGATED_BODY, "AGGREGATED"),
      ).rejects.toThrow(/no jobId/);
    });
  });

  describe("patchJob", () => {
    it("AGGREGATED: PATCHes /api/partner/jobs/{jobId} with the platform key, encoded", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 200,
        body: { jobId: "job-1", externalJobId: "vac 1/x", title: "Updated", status: "active", claimStatus: "unclaimed" },
      });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.patchJob!(
        ctx,
        makeConnection(),
        "vac 1/x",
        { title: "Updated" },
        "AGGREGATED",
      );

      expect(result).toEqual({ kind: "OK", jobId: "job-1", claimState: "unclaimed" });
      const [path, init] = http.mock.calls[0];
      expect(path).toBe(`/api/partner/jobs/${encodeURIComponent("vac 1/x")}`);
      expect(init.method).toBe("PATCH");
      expect(init.token).toBe(PLATFORM_KEY);
      expect(init.body).toEqual({ title: "Updated" });
    });

    it("SCHOOL_POSTED: PATCHes /api/partner/school/jobs/{id} with the grant token", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { jobId: "job-2", title: "Updated", status: "active" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.patchJob!(
        ctx,
        makeGrantConnection(),
        "job-2",
        { title: "Updated" },
        "SCHOOL_POSTED",
      );

      expect(result).toEqual({ kind: "OK", jobId: "job-2" });
      const [path, init] = http.mock.calls[0];
      expect(path).toBe("/api/partner/school/jobs/job-2");
      expect(init.method).toBe("PATCH");
      expect(init.token).toBe(GRANT_TOKEN);
      expect(init.body).toEqual({ title: "Updated" });
    });

    it("throws when SCHOOL_POSTED is called on a connection with no grant token", async () => {
      const http = vi.fn();
      const ctx = makeCtx(http);

      await expect(
        edufleetAdapter.patchJob!(
          ctx,
          makeConnection({ grantToken: undefined }),
          "job-2",
          { title: "x" },
          "SCHOOL_POSTED",
        ),
      ).rejects.toThrow(/grant token/);
      expect(http).not.toHaveBeenCalled();
    });

    it("MUTATION-DISTINGUISHING: a body containing status throws before any HTTP call — status changes must go through closeJob", async () => {
      // Contract Two's updateSchoolJob short-circuits the instant `status`
      // is present and silently discards every other field in the same
      // body, reporting a 200 with the pre-patch values. The guard must fire
      // BEFORE ctx.http is ever called — a caller that sent status believed
      // it was closing the listing, and a throw that still spent a write
      // unit would be no better than the silent discard it exists to avoid.
      const http = vi.fn();
      const ctx = makeCtx(http);

      await expect(
        edufleetAdapter.patchJob!(
          ctx,
          makeConnection(),
          "job-1",
          { title: "x", status: "closed" },
          "AGGREGATED",
        ),
      ).rejects.toThrow(/closeJob/);
      expect(http).not.toHaveBeenCalled();
    });

    it("a body with no status key still passes through untouched", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { jobId: "job-1", title: "x", status: "active" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.patchJob!(
        ctx,
        makeConnection(),
        "job-1",
        { title: "x", salaryMin: 20000 },
        "AGGREGATED",
      );

      expect(result).toEqual({ kind: "OK", jobId: "job-1" });
      expect(http).toHaveBeenCalledTimes(1);
      const [, init] = http.mock.calls[0];
      expect(init.body).toEqual({ title: "x", salaryMin: 20000 });
    });

    it("a 403 returns BLOCKED without throwing", async () => {
      const http = vi.fn().mockResolvedValue({ status: 403, body: { error: "claimed", reason: "claimed" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.patchJob!(ctx, makeConnection(), "job-1", { title: "x" }, "AGGREGATED");

      expect(result.kind).toBe("BLOCKED");
    });

    it("a 409 carries the response's contract field", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 409,
        body: { error: "dup", reason: "duplicate_external_job", jobId: "job-3", contract: "platform" },
      });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.patchJob!(
        ctx,
        makeGrantConnection(),
        "job-3",
        { title: "x" },
        "SCHOOL_POSTED",
      );

      expect(result).toMatchObject({ kind: "CONFLICT", ownedByContract: "platform" });
    });
  });

  describe("closeJob", () => {
    it("MUTATION-DISTINGUISHING: on Contract Two, sends status \"closed\" and nothing else — eduFleet silently discards any co-sent field", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { jobId: "job-2", title: "Old title", status: "closed" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.closeJob!(ctx, makeGrantConnection(), "job-2", "SCHOOL_POSTED");

      expect(result).toEqual({ kind: "OK", jobId: "job-2" });
      const [path, init] = http.mock.calls[0];
      expect(path).toBe("/api/partner/school/jobs/job-2");
      expect(init.method).toBe("PATCH");
      expect(init.token).toBe(GRANT_TOKEN);
      const body = init.body as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["status"]);
      expect(body.status).toBe("closed");
    });

    it("on Contract One, also sends status \"closed\" and nothing else", async () => {
      const http = vi
        .fn()
        .mockResolvedValue({ status: 200, body: { jobId: "job-1", externalJobId: "vac-1", title: "x", status: "closed", claimStatus: "unclaimed" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.closeJob!(ctx, makeConnection(), "vac-1", "AGGREGATED");

      expect(result).toEqual({ kind: "OK", jobId: "job-1", claimState: "unclaimed" });
      const [path, init] = http.mock.calls[0];
      expect(path).toBe("/api/partner/jobs/vac-1");
      expect(init.token).toBe(PLATFORM_KEY);
      const body = init.body as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["status"]);
      expect(body.status).toBe("closed");
    });

    it("throws when SCHOOL_POSTED is called on a connection with no grant token", async () => {
      const http = vi.fn();
      const ctx = makeCtx(http);

      await expect(
        edufleetAdapter.closeJob!(ctx, makeConnection({ grantToken: undefined }), "job-2", "SCHOOL_POSTED"),
      ).rejects.toThrow(/grant token/);
      expect(http).not.toHaveBeenCalled();
    });

    it("a 403 (e.g. already withdrawn) returns BLOCKED without throwing", async () => {
      const http = vi.fn().mockResolvedValue({ status: 403, body: { error: "claimed", reason: "claimed" } });
      const ctx = makeCtx(http);

      const result = await edufleetAdapter.closeJob!(ctx, makeConnection(), "vac-1", "AGGREGATED");

      expect(result.kind).toBe("BLOCKED");
    });
  });
});
