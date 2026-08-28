import { describe, expect, it, vi } from "vitest";
import type { ConnectorHttp } from "@/lib/connectors/http";
import type {
  AdapterContext,
  ConnectionState,
  InstitutionSummary,
  SyncSourceData,
  SyncVacancy,
} from "@/lib/connectors/types";
import { ConnectorAuthError, ConnectorCapExceededError, ConnectorRejectedError } from "@/lib/connectors/types";
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

  // ---------------------------------------------------------------------------
  // sync — the reconciler (Task 7)
  //
  // Two jobs: prove the school's grant is still alive (the ONLY place IDAP
  // ever discovers a revocation), and bring eduFleet back into step for
  // vacancies the school already published. Every push goes through the
  // service-owned closures on `SyncVacancy`, so these tests assert WHICH
  // closure ran on WHICH vacancy — and, at each guard, that neither ran.
  // ---------------------------------------------------------------------------

  describe("sync", () => {
    const SCHOOL_OK = { status: 200, body: { schoolId: "sch-1", schoolName: "Delhi Public School", city: "Bengaluru" } };

    /** An http stub whose FIRST answer is the grant probe. */
    function makeHttp(probe: { status: number; body: unknown } = SCHOOL_OK) {
      return vi.fn().mockResolvedValue(probe);
    }

    let counter = 0;

    function makeVacancy(overrides: Partial<SyncVacancy> = {}): SyncVacancy & {
      repush: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    } {
      counter += 1;
      return {
        vacancyId: `vac-${counter}`,
        title: `Mathematics Teacher ${counter}`,
        status: "OPEN",
        repush: vi.fn().mockResolvedValue({ ok: true }),
        close: vi.fn().mockResolvedValue({ ok: true }),
        ...overrides,
      } as SyncVacancy & { repush: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
    }

    const LIVE = { contract: "AGGREGATED", remoteStatus: "active" } as const;

    function makeData(vacancies?: SyncVacancy[], vacanciesTruncated?: boolean): SyncSourceData {
      return { institution: {}, results: [], readPublicMedia: vi.fn(), vacancies, vacanciesTruncated };
    }

    function grantConnection() {
      return makeConnection({ grantToken: "ef_pgrant_live", scopes: ["jobs:write"] });
    }

    // -- the grant probe ----------------------------------------------------

    it("probes the grant with a GET to /api/partner/school before touching any vacancy, and reports SUCCESS when nothing needs reconciling", async () => {
      const http = makeHttp();
      const outcome = await edufleetAdapter.sync(makeCtx(http), grantConnection(), makeData([]));

      expect(http).toHaveBeenCalledTimes(1);
      const [path, init] = http.mock.calls[0];
      expect(path).toBe("/api/partner/school");
      expect(init.method).toBe("GET");
      expect(init.token).toBe("ef_pgrant_live");
      expect(outcome.status).toBe("SUCCESS");
      expect(outcome.steps).toContainEqual({ step: "grant", ok: true });
    });

    it("MUTATION-DISTINGUISHING: a 401 `revoked` on the probe throws ConnectorAuthError and no vacancy is touched", async () => {
      // The obligation B1 recorded: this is the only path by which IDAP ever
      // learns a school withdrew consent. The assertion is not merely that an
      // error came back — it is that the run stopped before spending a single
      // write unit on a credential already known to be dead.
      const http = makeHttp({ status: 401, body: { reason: "revoked" } });
      const filled = makeVacancy({ status: "FILLED", listing: LIVE });

      await expect(edufleetAdapter.sync(makeCtx(http), grantConnection(), makeData([filled]))).rejects.toBeInstanceOf(
        ConnectorAuthError,
      );

      expect(filled.close).not.toHaveBeenCalled();
      expect(filled.repush).not.toHaveBeenCalled();
      expect(http).toHaveBeenCalledTimes(1);
    });

    it("the grant token never appears in the ConnectorAuthError a revoked probe throws", async () => {
      const http = makeHttp({ status: 401, body: { reason: "revoked" } });
      const connection = makeConnection({ grantToken: "ef_pgrant_secret_value" });

      let caught: unknown;
      try {
        await edufleetAdapter.sync(makeCtx(http), connection, makeData([]));
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ConnectorAuthError);
      expect((caught as Error).message).not.toContain("ef_pgrant_secret_value");
    });

    it("MUTATION-DISTINGUISHING: a 401 with no reason is reported, not treated as revocation — the run is PARTIAL and the connection survives", async () => {
      // eduFleet answers four of its seven grant-rejection paths with a bare
      // `{"error":"Invalid grant token"}`. Treating those as proof of consent
      // withdrawal would let a transient fault tear down a good connection;
      // saying nothing would let a dead token read as healthy forever.
      const http = makeHttp({ status: 401, body: { error: "Invalid grant token" } });

      const outcome = await edufleetAdapter.sync(makeCtx(http), grantConnection(), makeData([]));

      expect(outcome.status).toBe("PARTIAL");
      expect(outcome.steps).toContainEqual({ step: "grant", ok: false, detail: expect.stringContaining("401") });
      expect(outcome.warnings.some((w) => /still live/i.test(w))).toBe(true);
    });

    it("a probe that cannot reach eduFleet at all is PARTIAL, never a revocation", async () => {
      const http = vi.fn().mockRejectedValue(new Error("Connector GET /api/partner/school failed: network error"));

      const outcome = await edufleetAdapter.sync(makeCtx(http), grantConnection(), makeData([]));

      expect(outcome.status).toBe("PARTIAL");
      expect(outcome.steps).toContainEqual({ step: "grant", ok: false, detail: expect.stringContaining("reached") });
    });

    it("a connection holding no grant is PARTIAL and warns, but still reconciles the Contract One listings it can", async () => {
      const http = vi.fn();
      const filled = makeVacancy({ status: "FILLED", listing: LIVE });

      const outcome = await edufleetAdapter.sync(makeCtx(http), makeConnection(), makeData([filled]));

      expect(http).not.toHaveBeenCalled();
      expect(filled.close).toHaveBeenCalledTimes(1);
      expect(outcome.status).toBe("PARTIAL");
      expect(outcome.warnings.some((w) => /no grant token/i.test(w))).toBe(true);
    });

    // -- what gets pushed, and what deliberately does not --------------------

    it("MUTATION-DISTINGUISHING: a vacancy the school never published is never pushed — publishing is an explicit school action", async () => {
      // Spec §7 and §10. A sync that created listings would put adverts on a
      // public jobs board without the publish dialog that discloses it, and
      // would be the single largest write-unit burn available here.
      const open = makeVacancy({ status: "OPEN" });
      const filled = makeVacancy({ status: "FILLED" });

      const outcome = await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([open, filled]));

      expect(open.repush).not.toHaveBeenCalled();
      expect(open.close).not.toHaveBeenCalled();
      expect(filled.repush).not.toHaveBeenCalled();
      expect(filled.close).not.toHaveBeenCalled();
      // Nothing was skipped, because there was no work: SUCCESS, not PARTIAL.
      expect(outcome.status).toBe("SUCCESS");
    });

    it("MUTATION-DISTINGUISHING: an OPEN vacancy whose live listing is in step is not pushed — no write unit for an unchanged advert", async () => {
      const inStep = makeVacancy({ status: "OPEN", listing: LIVE });

      const outcome = await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([inStep]));

      expect(inStep.repush).not.toHaveBeenCalled();
      expect(outcome.status).toBe("SUCCESS");
      expect(outcome.steps).toContainEqual({ step: "vacancies", ok: true, detail: expect.any(String) });
    });

    it("MUTATION-DISTINGUISHING: an OPEN vacancy whose last push did not land IS repushed", async () => {
      const drifted = makeVacancy({
        status: "OPEN",
        listing: { ...LIVE, blockedReason: "eduFleet refused this push (claim_pending)." },
      });

      const outcome = await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([drifted]));

      expect(drifted.repush).toHaveBeenCalledTimes(1);
      expect(drifted.close).not.toHaveBeenCalled();
      expect(outcome.status).toBe("SUCCESS");
      expect(outcome.steps).toContainEqual({ step: `repush:${drifted.vacancyId}`, ok: true, detail: drifted.title });
    });

    it("MUTATION-DISTINGUISHING: a FILLED vacancy with a live listing is closed, not repushed", async () => {
      const filled = makeVacancy({ status: "FILLED", listing: LIVE });
      const closed = makeVacancy({ status: "CLOSED", listing: LIVE });

      const outcome = await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([filled, closed]));

      expect(filled.close).toHaveBeenCalledTimes(1);
      expect(filled.repush).not.toHaveBeenCalled();
      expect(closed.close).toHaveBeenCalledTimes(1);
      expect(outcome.status).toBe("SUCCESS");
      expect(outcome.steps).toContainEqual({ step: `close:${filled.vacancyId}`, ok: true, detail: filled.title });
    });

    it("MUTATION-DISTINGUISHING: a listing eduFleet already shows as closed is left alone, whatever the local status", async () => {
      // Nothing is live over there, and neither contract can reopen an advert
      // — the only route back is a NEW listing, which is a create.
      const dead = { contract: "AGGREGATED", remoteStatus: "closed" } as const;
      const openAgain = makeVacancy({ status: "OPEN", listing: { ...dead, blockedReason: "was refused" } });
      const filled = makeVacancy({ status: "FILLED", listing: dead });

      const outcome = await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([openAgain, filled]));

      expect(openAgain.repush).not.toHaveBeenCalled();
      expect(openAgain.close).not.toHaveBeenCalled();
      expect(filled.close).not.toHaveBeenCalled();
      expect(outcome.status).toBe("SUCCESS");
    });

    it("MUTATION-DISTINGUISHING: a claimed listing is neither pushed nor closed, and the run says so", async () => {
      // `claimed` is terminal: IDAP's key is refused forever, and `spendWrite`
      // runs before validation, so every attempt would burn a write unit to be
      // told something already known.
      const claimedFilled = makeVacancy({
        status: "FILLED",
        listing: { ...LIVE, claimState: "claimed" },
      });

      const outcome = await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([claimedFilled]));

      expect(claimedFilled.close).not.toHaveBeenCalled();
      expect(claimedFilled.repush).not.toHaveBeenCalled();
      expect(outcome.status).toBe("PARTIAL");
      expect(outcome.warnings.some((w) => w.includes(claimedFilled.vacancyId) && /claimed/i.test(w))).toBe(true);
    });

    it("MUTATION-DISTINGUISHING: a withdrawn listing is skipped too, and the warning says takedown rather than claim", async () => {
      // `withdrawn` is the second terminal state behind eduFleet's one
      // `403 claimed` reason: an admin-approved takedown, which
      // `updatePartnerJob` refuses precisely so a partner key cannot
      // resurrect what admin took down. Repushing it burns a unit per sync.
      const withdrawn = makeVacancy({
        status: "FILLED",
        listing: { ...LIVE, claimState: "withdrawn" },
      });

      const outcome = await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([withdrawn]));

      expect(withdrawn.close).not.toHaveBeenCalled();
      expect(withdrawn.repush).not.toHaveBeenCalled();
      expect(outcome.status).toBe("PARTIAL");
      expect(outcome.warnings.some((w) => w.includes(withdrawn.vacancyId) && /taken down/i.test(w))).toBe(true);
    });

    it("a claim still pending is NOT treated as claimed — it reverts on rejection, so the push is still attempted", async () => {
      const pending = makeVacancy({
        status: "FILLED",
        listing: { ...LIVE, claimState: "claim_pending" },
      });

      await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([pending]));

      expect(pending.close).toHaveBeenCalledTimes(1);
    });

    it("a DRAFT vacancy with a live advert is named in a warning, never silently closed", async () => {
      const draft = makeVacancy({ status: "DRAFT", listing: LIVE });

      const outcome = await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([draft]));

      expect(draft.close).not.toHaveBeenCalled();
      expect(draft.repush).not.toHaveBeenCalled();
      expect(outcome.status).toBe("PARTIAL");
      expect(outcome.warnings.some((w) => w.includes(draft.vacancyId) && /draft/i.test(w))).toBe(true);
    });

    // -- how failures are reported -------------------------------------------

    it("MUTATION-DISTINGUISHING: one vacancy's refusal never becomes SUCCESS — the run is PARTIAL and the warning names it", async () => {
      const refused = makeVacancy({ status: "FILLED", listing: LIVE });
      refused.close.mockResolvedValue({ ok: false, scope: "VACANCY", detail: "eduFleet refused this push (claimed)." });
      const fine = makeVacancy({ status: "FILLED", listing: LIVE });

      const outcome = await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([refused, fine]));

      // The sweep continued: a per-vacancy failure is about that vacancy only.
      expect(fine.close).toHaveBeenCalledTimes(1);
      expect(outcome.status).toBe("PARTIAL");
      expect(outcome.warnings.some((w) => w.includes(refused.vacancyId))).toBe(true);
      expect(outcome.steps).toContainEqual({
        step: `close:${refused.vacancyId}`,
        ok: false,
        detail: "eduFleet refused this push (claimed).",
      });
    });

    it("MUTATION-DISTINGUISHING: a RUN-scoped failure abandons the rest of the sweep instead of repeating it per vacancy", async () => {
      // eduFleet unreachable, or the school's 100 daily write units spent (an
      // unclassified 429). Continuing would rediscover the same fact once per
      // vacancy — and on a write-cap refusal, keep asking for units that are
      // already gone.
      const first = makeVacancy({ status: "FILLED", listing: LIVE });
      first.close.mockResolvedValue({ ok: false, scope: "RUN", detail: "eduFleet could not be reached right now." });
      const second = makeVacancy({ status: "FILLED", listing: LIVE });

      const outcome = await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([first, second]));

      expect(second.close).not.toHaveBeenCalled();
      expect(outcome.status).toBe("FAILED");
      expect(outcome.error).toBe("eduFleet could not be reached right now.");
    });

    it("MUTATION-DISTINGUISHING: a grant revoked mid-sweep carries the steps and warnings already accumulated", async () => {
      // Same rule as PassPercent's mid-run 401: a credential dying partway
      // through must not erase the record of which adverts already went up or
      // came down.
      const done = makeVacancy({ status: "FILLED", listing: LIVE });
      const dies = makeVacancy({ status: "FILLED", listing: LIVE });
      dies.close.mockRejectedValue(new ConnectorAuthError("eduFleet: the credential used for this job push has been revoked"));

      let caught: unknown;
      try {
        await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([done, dies]));
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ConnectorAuthError);
      const steps = (caught as ConnectorAuthError).steps.map((step) => step.step);
      expect(steps).toContain("grant");
      expect(steps).toContain(`close:${done.vacancyId}`);
      expect(steps).toContain(`close:${dies.vacancyId}`);
      expect(done.close).toHaveBeenCalledTimes(1);
    });

    it("MUTATION-DISTINGUISHING: a truncated worklist is never reported as SUCCESS, and the warning says how many were looked at", async () => {
      // L3. The service's read is bounded, so a school past the cap hands
      // over a PREFIX. Reconciling it and reporting SUCCESS would tell an
      // admin "eduFleet is in step with IDAP" about vacancies the run never
      // read — and by the oldest-first ordering those are its longest-lived
      // adverts.
      const inStep = makeVacancy({ status: "FILLED", listing: LIVE });

      const outcome = await edufleetAdapter.sync(
        makeCtx(makeHttp()),
        grantConnection(),
        makeData([inStep], true),
      );

      // The work that WAS in the list still happened — truncation is a
      // reporting fact, not a reason to stop.
      expect(inStep.close).toHaveBeenCalledTimes(1);
      expect(outcome.status).toBe("PARTIAL");
      expect(outcome.warnings.some((w) => /only the first 1 vacancies/i.test(w))).toBe(true);
    });

    it("an untruncated worklist says nothing about a cap", async () => {
      const inStep = makeVacancy({ status: "FILLED", listing: LIVE });

      const outcome = await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData([inStep]));

      expect(outcome.status).toBe("SUCCESS");
      expect(outcome.warnings.some((w) => /only the first/i.test(w))).toBe(false);
    });

    it("a sync given no vacancy worklist at all reports PARTIAL rather than fabricating a push that never happened", async () => {
      const outcome = await edufleetAdapter.sync(makeCtx(makeHttp()), grantConnection(), makeData(undefined));

      expect(outcome.status).toBe("PARTIAL");
      expect(outcome.steps).toContainEqual({ step: "vacancies", ok: false, detail: expect.any(String) });
      expect(outcome.warnings.some((w) => /vacanc/i.test(w))).toBe(true);
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

      // `publicUrl` is kept, not discarded: it is the only place eduFleet ever
      // reports the advert's own page, and the school's dashboard renders it
      // as a link. Neither PATCH route repeats it, and it cannot be rebuilt
      // (the slug is minted remotely and `ctx.baseUrl` is the API host), so a
      // create that drops it loses it permanently.
      expect(result).toEqual({
        kind: "OK",
        jobId: "job-1",
        claimState: "unclaimed",
        publicUrl: "https://edufleet.example/jobs/maths-teacher/job-1",
      });
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

      expect(result).toEqual({
        kind: "OK",
        jobId: "job-2",
        publicUrl: "https://edufleet.example/jobs/maths-teacher/job-2",
      });
      expect("claimState" in (result as object)).toBe(false);
      const [path, init] = http.mock.calls[0];
      expect(path).toBe("/api/partner/school/jobs");
      expect(init.method).toBe("POST");
      expect(init.token).toBe(GRANT_TOKEN);
      expect(init.body).toEqual(SCHOOL_BODY);
    });

    /**
     * `publicUrl` is persisted and then rendered as an `<a href>` in the
     * school's dashboard, which makes it the one field on this response that
     * is dangerous to trust. A `javascript:`/`data:` URL from a compromised or
     * misconfigured partner host would be stored XSS the first time somebody
     * clicked the listing.
     *
     * MUTATION CHECK: delete the protocol test in `safePublicUrl` (return
     * `parsed.toString()` unconditionally) and this test fails — the
     * `javascript:` URL is carried straight through onto the result. The push
     * itself must still succeed: the advert IS live on eduFleet by then, and
     * discarding a real `jobId` over a bad convenience link would leave a
     * public listing IDAP could never close.
     */
    it("MUTATION-DISTINGUISHING: drops a publicUrl that is not an http(s) URL, and still returns OK", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 201,
        body: {
          jobId: "job-3",
          externalJobId: "vac-1",
          status: "active",
          publicUrl: "javascript:alert(document.cookie)",
        },
      });

      const result = await edufleetAdapter.createJob!(
        makeCtx(http),
        makeConnection(),
        AGGREGATED_BODY,
        "AGGREGATED",
      );

      expect(result).toEqual({ kind: "OK", jobId: "job-3" });
      expect("publicUrl" in (result as object)).toBe(false);
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

    it("a 401 revoked on a GRANT-authenticated push throws ConnectorAuthError", async () => {
      const http = vi.fn().mockResolvedValue({ status: 401, body: { error: "Grant revoked", reason: "revoked" } });
      const ctx = makeCtx(http);

      await expect(
        edufleetAdapter.createJob!(ctx, makeGrantConnection(), SCHOOL_BODY, "SCHOOL_POSTED"),
      ).rejects.toBeInstanceOf(ConnectorAuthError);
    });

    it("MUTATION-DISTINGUISHING: the SAME 401 revoked body on a PLATFORM-KEY push does NOT throw ConnectorAuthError", async () => {
      // Fix round 1. eduFleet answers a revoked platform key
      // (`partner-auth.ts:100`) and a revoked school grant (`:121`) with the
      // byte-identical `{reason: "revoked"}`. Only the credential IDAP sent
      // separates them — and `ConnectorAuthError` is wired to disconnect a
      // school, which is the wrong answer to "IDAP's own key was pulled":
      // no school caused it, none can fix it, and the reconciler would have
      // marched through them one at a time.
      const body = { error: "Partner key revoked", reason: "revoked" };
      const http = vi.fn().mockResolvedValue({ status: 401, body });
      const ctx = makeCtx(http);

      let caught: unknown;
      try {
        await edufleetAdapter.createJob!(ctx, makeGrantConnection(), AGGREGATED_BODY, "AGGREGATED");
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(ConnectorAuthError);
      // The operator fix is not guessable from anywhere downstream, so the
      // message has to name it.
      expect((caught as Error).message).toMatch(/platform key/i);
      expect((caught as Error).message).toMatch(/re-issued/i);
    });

    it("the platform-key/grant split holds on closeJob too, not just createJob", async () => {
      const body = { error: "Partner key revoked", reason: "revoked" };

      const platformHttp = vi.fn().mockResolvedValue({ status: 401, body });
      await expect(
        edufleetAdapter.closeJob!(makeCtx(platformHttp), makeGrantConnection(), "vac-1", "AGGREGATED"),
      ).rejects.not.toBeInstanceOf(ConnectorAuthError);

      const grantHttp = vi.fn().mockResolvedValue({ status: 401, body });
      await expect(
        edufleetAdapter.closeJob!(makeCtx(grantHttp), makeGrantConnection(), "ef-job-1", "SCHOOL_POSTED"),
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

      // No `publicUrl`: eduFleet's PATCH routes never report one, so this
      // response has none to carry. The URL recorded at create time survives
      // untouched because the publish service's patch branch writes named
      // paths only.
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

      // No `publicUrl`: eduFleet's PATCH routes never report one, so this
      // response has none to carry. The URL recorded at create time survives
      // untouched because the publish service's patch branch writes named
      // paths only.
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

  // -------------------------------------------------------------------------
  // M4 / L2 — the two answers that used to fall to "could not be reached"
  // -------------------------------------------------------------------------

  describe("429 and 404 classification", () => {
    it("MUTATION-DISTINGUISHING: a spent daily cap throws ConnectorCapExceededError naming the cap and the reset, not a transient failure", async () => {
      // M4. eduFleet answered instantly and precisely; "could not be reached
      // right now — try again shortly" is false in both halves, and it is the
      // one instruction that cannot succeed until the cap resets.
      const http = vi.fn().mockResolvedValue({
        status: 429,
        body: { error: "Daily write cap reached", reason: "write_cap_exceeded", dailyWriteCap: 100 },
      });

      const error = await edufleetAdapter
        .createJob!(makeCtx(http), makeGrantConnection(), SCHOOL_BODY, "SCHOOL_POSTED")
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConnectorCapExceededError);
      expect((error as ConnectorCapExceededError).dailyWriteCap).toBe(100);
      expect((error as Error).message).toMatch(/100/);
      expect((error as Error).message).toMatch(/midnight IST/);
      expect((error as Error).message).not.toMatch(/try again shortly/);
    });

    it("MUTATION-DISTINGUISHING: a Contract One cap names the SHARED pool, not the school's own limit", async () => {
      // Contract One spends `spendWrite(auth.partner)` — the platform-wide
      // 500/day pool every unconnected school shares. Telling a school "your
      // daily limit" there would be wrong, and only the credential IDAP chose
      // to send can tell the two budgets apart.
      const http = vi.fn().mockResolvedValue({
        status: 429,
        body: { error: "Daily write cap reached", reason: "write_cap_exceeded", dailyWriteCap: 500 },
      });

      const error = await edufleetAdapter
        .createJob!(makeCtx(http), makeConnection(), AGGREGATED_BODY, "AGGREGATED")
        .catch((e: unknown) => e);

      expect((error as Error).message).toMatch(/shared/i);
      expect((error as Error).message).toMatch(/500/);
    });

    it("leaves a burst 429 on the transient path — a per-minute limiter really does clear in moments", async () => {
      const http = vi.fn().mockResolvedValue({
        status: 429,
        body: { error: "Rate limit exceeded", reason: "rate_limited" },
      });

      const error = await edufleetAdapter
        .createJob!(makeCtx(http), makeGrantConnection(), SCHOOL_BODY, "SCHOOL_POSTED")
        .catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(ConnectorCapExceededError);
      expect(error).toBeInstanceOf(Error);
    });

    it("MUTATION-DISTINGUISHING: a 404 comes back BLOCKED with reason not_found rather than as something to retry", async () => {
      // L2. Both PATCH routes 404 AFTER `spendWrite`, so every retry of "try
      // again shortly" costs another unit to be told the same thing.
      const http = vi.fn().mockResolvedValue({
        status: 404,
        body: { error: "Job not found for this partner", reason: "not_found" },
      });

      const result = await edufleetAdapter.patchJob!(
        makeCtx(http),
        makeConnection(),
        "vac-1",
        { title: "x" },
        "AGGREGATED",
      );

      expect(result).toMatchObject({ kind: "BLOCKED", reason: "not_found" });
      // The action that must not happen: no second attempt.
      expect(http).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // H1 — resolving a 403 `claimed` against the free job list
  //
  // `updatePartnerJob` raises ONE reason for `claimed`, `claim_pending` AND
  // `withdrawn`, which have two different futures, and no success body on any
  // of the four job routes ever reports a claim state. `GET
  // /api/partner/jobs` is the only source that can say, and its route calls
  // `requirePlatformKey` then `listPartnerJobs` — no `spendWrite` anywhere.
  // -------------------------------------------------------------------------

  describe("claim state resolution behind a 403", () => {
    /** A 403 `claimed` first, then whatever the job list answers. */
    function claimedThen(listResponse: { status: number; body: unknown }) {
      return vi
        .fn()
        .mockResolvedValueOnce({
          status: 403,
          body: {
            error: "This listing has been claimed by the school and can no longer be edited by a partner key",
            reason: "claimed",
          },
        })
        .mockResolvedValueOnce(listResponse);
    }

    it("MUTATION-DISTINGUISHING: a Contract One 403 claimed is followed by a free GET, and the matched job's claimStatus rides on the result", async () => {
      const http = claimedThen({
        status: 200,
        body: {
          jobs: [
            { externalJobId: "someone-else", claimStatus: "unclaimed" },
            { externalJobId: "vac-1", claimStatus: "claimed", status: "active", jobId: "job-1" },
          ],
        },
      });

      const result = await edufleetAdapter.patchJob!(
        makeCtx(http),
        makeConnection(),
        "vac-1",
        { title: "x" },
        "AGGREGATED",
      );

      expect(result).toEqual({
        kind: "BLOCKED",
        reason: "claimed",
        detail: expect.any(String),
        claimState: "claimed",
      });
      expect(http).toHaveBeenCalledTimes(2);
      const [path, init] = http.mock.calls[1];
      expect(path).toBe("/api/partner/jobs");
      expect(init.method).toBe("GET");
      expect(init.token).toBe(PLATFORM_KEY);
      // No body: a GET that carried one would be a write in disguise.
      expect(init.body).toBeUndefined();
    });

    it("MUTATION-DISTINGUISHING: matches on externalJobId rather than taking whichever job came first", async () => {
      const http = claimedThen({
        status: 200,
        body: {
          jobs: [
            { externalJobId: "newest-first", claimStatus: "claimed" },
            { externalJobId: "vac-1", claimStatus: "claim_pending" },
          ],
        },
      });

      const result = await edufleetAdapter.closeJob!(makeCtx(http), makeConnection(), "vac-1", "AGGREGATED");

      // The list is newest-first and caps at 200, so "the first row" is a
      // different job almost every time — and `claim_pending` reverts on
      // rejection while `claimed` never does, so getting this wrong retires a
      // live advert IDAP is still responsible for.
      expect(result).toMatchObject({ kind: "BLOCKED", claimState: "claim_pending" });
    });

    it("reports no claim state when the job is not on the list — unknown is not unclaimed", async () => {
      const http = claimedThen({ status: 200, body: { jobs: [{ externalJobId: "other", claimStatus: "claimed" }] } });

      const result = await edufleetAdapter.closeJob!(makeCtx(http), makeConnection(), "vac-1", "AGGREGATED");

      expect(result.kind).toBe("BLOCKED");
      expect("claimState" in (result as object)).toBe(false);
    });

    it("a failed list read never turns a classified BLOCKED into a throw", async () => {
      const http = vi
        .fn()
        .mockResolvedValueOnce({ status: 403, body: { error: "claimed", reason: "claimed" } })
        .mockRejectedValueOnce(new Error("network down"));

      const result = await edufleetAdapter.closeJob!(makeCtx(http), makeConnection(), "vac-1", "AGGREGATED");

      expect(result.kind).toBe("BLOCKED");
      expect("claimState" in (result as object)).toBe(false);
    });

    it("MUTATION-DISTINGUISHING: a 403 that is not `claimed` reads no list — nothing about it is ambiguous", async () => {
      const http = vi
        .fn()
        .mockResolvedValue({ status: 403, body: { error: "no room", reason: "upgrade_required" } });

      const result = await edufleetAdapter.patchJob!(
        makeCtx(http),
        makeConnection(),
        "vac-1",
        { title: "x" },
        "AGGREGATED",
      );

      expect(result).toMatchObject({ kind: "BLOCKED", reason: "upgrade_required" });
      expect(http).toHaveBeenCalledTimes(1);
    });

    it("MUTATION-DISTINGUISHING: a Contract Two 403 reads no list — a school_posted job is never claimable", async () => {
      const http = vi.fn().mockResolvedValue({ status: 403, body: { error: "claimed", reason: "claimed" } });

      const result = await edufleetAdapter.closeJob!(
        makeCtx(http),
        makeGrantConnection(),
        "job-2",
        "SCHOOL_POSTED",
      );

      expect(result.kind).toBe("BLOCKED");
      // The action that must not happen: Contract One's job list is not this
      // school's, so reading it spends a rate-limit slot to learn nothing.
      expect(http).toHaveBeenCalledTimes(1);
    });
  });
});
