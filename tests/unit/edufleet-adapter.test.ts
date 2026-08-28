import { describe, expect, it, vi } from "vitest";
import type { ConnectorHttp } from "@/lib/connectors/http";
import type { AdapterContext, InstitutionSummary } from "@/lib/connectors/types";
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

      await expect(edufleetAdapter.initiate!(ctx, makeInstitution())).rejects.toThrow();
    });

    it("throws on any other non-2xx status", async () => {
      const http = vi.fn().mockResolvedValue({ status: 500, body: { error: "internal" } });
      const ctx = makeCtx(http);

      await expect(edufleetAdapter.initiate!(ctx, makeInstitution())).rejects.toThrow();
    });

    it("sends externalRef and payload.institutionName, and never the platform key in the body", async () => {
      const http = vi.fn().mockResolvedValue({ status: 201, body: { requestId: "req-abc", status: "pending" } });
      const ctx = makeCtx(http);

      await edufleetAdapter.initiate!(ctx, makeInstitution({ institutionId: "inst-42", name: "St. Xavier's" }));

      const [, init] = http.mock.calls[0];
      const body = init.body as Record<string, unknown>;
      expect(body.externalRef).toBe("inst-42");
      expect((body.payload as Record<string, unknown>).institutionName).toBe("St. Xavier's");

      // The platform key must live only in the Authorization header (via
      // `init.token`), never anywhere inside the request body.
      expect(JSON.stringify(body)).not.toContain(PLATFORM_KEY);
      expect(body.platformKey).toBeUndefined();
      expect(body.token).toBeUndefined();
    });
  });
});
