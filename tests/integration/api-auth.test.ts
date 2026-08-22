import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import {
  makeApiClient,
  makeInstitution,
  requestWithBearer,
  requestWithKeyHeaders,
} from "../helpers/factories";
import { authenticateApiClient } from "@/lib/api/api-auth";
import { ApiClientService } from "@/services/api-client.service";
import { ApiClient } from "@/models";

describe("API client authentication", () => {
  beforeAll(async () => {
    await startTestDatabase("apiauth");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001");
  });

  it("derives the institution from the credential, not the request", async () => {
    const { bearer } = await makeApiClient("INS0001");
    const auth = await authenticateApiClient(requestWithBearer(bearer), "CREATE_LEAD");
    expect(auth.institutionId).toBe("INS0001");
  });

  it("accepts the header-pair form too", async () => {
    const { keyId, secret } = await makeApiClient("INS0001");
    const auth = await authenticateApiClient(
      requestWithKeyHeaders(keyId, secret),
      "CREATE_LEAD",
    );
    expect(auth.institutionId).toBe("INS0001");
  });

  it("rejects a missing credential", async () => {
    const request = { headers: new Headers() } as unknown as Parameters<
      typeof authenticateApiClient
    >[0];
    await expect(authenticateApiClient(request, "CREATE_LEAD")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects the wrong secret for a real key", async () => {
    const { keyId } = await makeApiClient("INS0001");
    await expect(
      authenticateApiClient(requestWithBearer(`${keyId}.sk_wrong`), "CREATE_LEAD"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an unknown key id without revealing that it is unknown", async () => {
    await expect(
      authenticateApiClient(requestWithBearer("ak_doesnotexist.sk_whatever"), "CREATE_LEAD"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "Invalid API credentials" });
  });

  it("rejects a bearer token with no separator", async () => {
    const { keyId } = await makeApiClient("INS0001");
    await expect(
      authenticateApiClient(requestWithBearer(keyId), "CREATE_LEAD"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("enforces permissions per endpoint", async () => {
    const { bearer } = await makeApiClient("INS0001", ["CREATE_LEAD"]);
    await expect(
      authenticateApiClient(requestWithBearer(bearer), "CREATE_LEAD"),
    ).resolves.toBeTruthy();
    await expect(
      authenticateApiClient(requestWithBearer(bearer), "CREATE_APPLICATION"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      authenticateApiClient(requestWithBearer(bearer), "READ_APPLICATION"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a revoked credential", async () => {
    const { bearer, client } = await makeApiClient("INS0001");
    await ApiClientService.revoke({
      tenantClause: { institutionId: "INS0001" },
      id: String(client._id),
      actor: { id: "6a8880f3446c577c470cd06c", name: "Admin" },
    });

    await expect(
      authenticateApiClient(requestWithBearer(bearer), "CREATE_LEAD"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a credential belonging to a deactivated institution", async () => {
    await makeInstitution("INS0003", { active: false });
    const { bearer } = await makeApiClient("INS0003");

    await expect(
      authenticateApiClient(requestWithBearer(bearer), "CREATE_LEAD"),
    ).rejects.toMatchObject({ code: "INACTIVE_INSTITUTION" });
  });

  it("records usage without failing the request it measures", async () => {
    const { bearer, client } = await makeApiClient("INS0001");
    await authenticateApiClient(requestWithBearer(bearer), "CREATE_LEAD");

    // Usage tracking is fire-and-forget, so give it a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const updated = await ApiClient.findById(client._id).lean();
    expect(updated?.requestCount).toBe(1);
    expect(updated?.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe("API credential lifecycle", () => {
  beforeAll(async () => {
    await startTestDatabase("apilifecycle");
  });
  afterAll(stopTestDatabase);

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001");
  });

  it("returns the secret once and stores only a hash", async () => {
    const result = await ApiClientService.create({
      institutionId: "INS0001",
      name: "Website",
      permissions: ["CREATE_LEAD"],
      actor: { id: "6a8880f3446c577c470cd06c", name: "Admin" },
    });

    expect(result.secret).toMatch(/^sk_/);
    expect(result.bearerToken).toBe(`${result.keyId}.${result.secret}`);

    const stored = await ApiClient.findById(result.client.id).select("+secretHash").lean();
    expect(stored?.secretHash).toBeTruthy();
    expect(stored?.secretHash).not.toBe(result.secret);
    expect(JSON.stringify(result.client)).not.toContain(result.secret);
  });

  it("never exposes the hash through the listing API", async () => {
    await makeApiClient("INS0001");
    const listed = await ApiClientService.list({ institutionId: "INS0001" });
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toMatch(/secretHash/);
  });

  it("keeps a revoked credential for the audit trail", async () => {
    const { client } = await makeApiClient("INS0001");
    const revoked = await ApiClientService.revoke({
      tenantClause: { institutionId: "INS0001" },
      id: String(client._id),
      actor: { id: "6a8880f3446c577c470cd06c", name: "Admin" },
    });

    expect(revoked.active).toBe(false);
    expect(revoked.revokedAt).toBeTruthy();
    expect(await ApiClient.countDocuments({})).toBe(1);
  });

  it("will not revoke another institution's credential", async () => {
    const { client } = await makeApiClient("INS0001");
    await expect(
      ApiClientService.revoke({
        tenantClause: { institutionId: "INS0002" },
        id: String(client._id),
        actor: { id: "6a8880f3446c577c470cd06c", name: "Other" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
