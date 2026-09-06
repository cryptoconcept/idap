import { describe, it, expect, vi } from "vitest";
import { scholarshipHubAdapter } from "@/lib/connectors/scholarship-hub";
import type { AdapterContext, ConnectionState, InstitutionSummary } from "@/lib/connectors/types";
import { ConnectorRejectedError, ConnectorCapExceededError } from "@/lib/connectors/types";

const conn: ConnectionState = { institutionId: "INS0001", externalRef: "IDAP:INS0001" };
const REF = "IDAP:INS0001:6a8f1a72017ca1920491b71a";
const ctx = (http: AdapterContext["http"]): AdapterContext => ({ baseUrl: "https://hub.test", platformKey: "sh_pkey_x", http });

describe("scholarshipHubAdapter", () => {
  describe("initiate", () => {
    it("provisions the Hub provider and returns the PENDING-mapped result with the providerId captured", async () => {
      const http = vi.fn().mockResolvedValue({ status: 200, body: { providerId: "prov-1" } });
      const institution: InstitutionSummary = { institutionId: "INS0001", name: "Delhi Public School", city: "Bengaluru" };

      const result = await scholarshipHubAdapter.initiate!(ctx(http), institution);

      expect(result).toEqual({ remoteRequestId: "prov-1", remoteStatus: "provisioned", kind: "PENDING" });
      expect(http).toHaveBeenCalledTimes(1);
      const [path, init] = http.mock.calls[0];
      expect(path).toBe("/api/partner/providers");
      expect(init).toMatchObject({
        method: "POST",
        token: "sh_pkey_x",
        body: { externalRef: "IDAP:INS0001", name: "Delhi Public School", city: "Bengaluru" },
      });
    });
  });

  describe("refresh", () => {
    it("returns the CONNECTED-mapped result immediately, with no http call", async () => {
      const http = vi.fn();
      const connected: ConnectionState = { institutionId: "INS0001", externalRef: "IDAP:INS0001", remoteRequestId: "prov-1" };

      const result = await scholarshipHubAdapter.refresh!(ctx(http), connected);

      expect(result).toEqual({ kind: "CONNECTED", remoteStatus: "connected", grantToken: "prov-1", scopes: [] });
      expect(http).not.toHaveBeenCalled();
    });

    it("throws when the connection has no remoteRequestId", async () => {
      await expect(scholarshipHubAdapter.refresh!(ctx(vi.fn()), conn)).rejects.toThrow(/remoteRequestId/);
    });
  });

  it("upsert OK → maps hubId/slug/publicUrl and sends PUT with the partner key", async () => {
    const http = vi.fn().mockResolvedValue({ status: 200, body: { hubId: "h1", slug: "infinity-merit", publicUrl: "https://hub.test/scholarships/infinity-merit", remoteStatus: "published" } });
    const r = await scholarshipHubAdapter.upsertScholarship!(ctx(http), conn, REF, { title: "Infinity Merit" });
    expect(r).toEqual({ kind: "OK", hubId: "h1", slug: "infinity-merit", publicUrl: "https://hub.test/scholarships/infinity-merit", remoteStatus: "published" });
    expect(http.mock.calls[0][0]).toBe(`/api/partner/scholarships/${encodeURIComponent(REF)}`);
    expect(http.mock.calls[0][1]).toMatchObject({ method: "PUT", token: "sh_pkey_x", body: { title: "Infinity Merit" } });
  });
  it("upsert 409 → BLOCKED (moderation), 422 → ConnectorRejectedError, 429 → ConnectorCapExceededError", async () => {
    const blocked = await scholarshipHubAdapter.upsertScholarship!(ctx(vi.fn().mockResolvedValue({ status: 409, body: { error: { code: "MODERATION_HOLD", message: "held" } } })), conn, REF, {});
    expect(blocked).toEqual({ kind: "BLOCKED", reason: "MODERATION_HOLD", detail: "held" });
    await expect(scholarshipHubAdapter.upsertScholarship!(ctx(vi.fn().mockResolvedValue({ status: 422, body: { error: { code: "INCOMPLETE", missing: ["closesAt"] } } })), conn, REF, {})).rejects.toBeInstanceOf(ConnectorRejectedError);
    await expect(scholarshipHubAdapter.upsertScholarship!(ctx(vi.fn().mockResolvedValue({ status: 429, body: {} })), conn, REF, {})).rejects.toBeInstanceOf(ConnectorCapExceededError);
  });
  it("withdraw 200 → OK closed; 404 → NOT_FOUND", async () => {
    const ok = await scholarshipHubAdapter.withdrawScholarship!(ctx(vi.fn().mockResolvedValue({ status: 200, body: { hubId: "h1", remoteStatus: "closed" } })), conn, REF);
    expect(ok).toMatchObject({ kind: "OK", remoteStatus: "closed" });
    const gone = await scholarshipHubAdapter.withdrawScholarship!(ctx(vi.fn().mockResolvedValue({ status: 404, body: {} })), conn, REF);
    expect(gone).toEqual({ kind: "NOT_FOUND" });
  });
});
