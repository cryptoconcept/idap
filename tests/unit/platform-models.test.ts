import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { PlatformConnection, PlatformCredential, SyncRun } from "@/models";

beforeAll(async () => {
  await startTestDatabase("platform-models");
  await PlatformCredential.syncIndexes();
  await PlatformConnection.syncIndexes();
  await SyncRun.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("PlatformCredential model", () => {
  it("defaults active to true", async () => {
    const created = await PlatformCredential.create({
      platform: "PASSPERCENT",
      keyEncrypted: "iv.cipher.tag",
      baseUrl: "https://api.passpercent.in",
    });

    expect(created.active).toBe(true);
  });

  it("rejects a second credential for the same platform", async () => {
    await PlatformCredential.create({
      platform: "PASSPERCENT",
      keyEncrypted: "iv.cipher.tag",
      baseUrl: "https://api.passpercent.in",
    });

    await expect(
      PlatformCredential.create({
        platform: "PASSPERCENT",
        keyEncrypted: "iv.cipher.tag2",
        baseUrl: "https://api.passpercent.in",
      }),
    ).rejects.toThrow();
  });

  it("keeps keyEncrypted out of a plain findOne but returns it when explicitly selected", async () => {
    await PlatformCredential.create({
      platform: "PASSPERCENT",
      keyEncrypted: "iv.cipher.tag",
      baseUrl: "https://api.passpercent.in",
    });

    const plain = await PlatformCredential.findOne({ platform: "PASSPERCENT" });
    expect(plain?.keyEncrypted).toBeUndefined();

    const withKey = await PlatformCredential.findOne({ platform: "PASSPERCENT" }).select(
      "+keyEncrypted",
    );
    expect(withKey?.keyEncrypted).toBe("iv.cipher.tag");
  });
});

describe("PlatformConnection model", () => {
  it("defaults status to PENDING", async () => {
    const created = await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      externalRef: "INS0001",
    });

    expect(created.status).toBe("PENDING");
  });

  it("rejects a second connection for the same institution and platform", async () => {
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      externalRef: "INS0001",
    });

    await expect(
      PlatformConnection.create({
        institutionId: "INS0001",
        platform: "PASSPERCENT",
        externalRef: "INS0001",
      }),
    ).rejects.toThrow();
  });

  it("keeps grantTokenEncrypted out of a plain findOne but returns it when explicitly selected", async () => {
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "PASSPERCENT",
      externalRef: "INS0001",
      grantTokenEncrypted: "iv.cipher.tag",
    });

    const plain = await PlatformConnection.findOne({ institutionId: "INS0001" });
    expect(plain?.grantTokenEncrypted).toBeUndefined();

    const withGrant = await PlatformConnection.findOne({ institutionId: "INS0001" }).select(
      "+grantTokenEncrypted",
    );
    expect(withGrant?.grantTokenEncrypted).toBe("iv.cipher.tag");
  });
});

describe("SyncRun model", () => {
  it("requires status", async () => {
    await expect(
      SyncRun.create({
        institutionId: "INS0001",
        platform: "PASSPERCENT",
        startedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("requires startedAt", async () => {
    await expect(
      SyncRun.create({
        institutionId: "INS0001",
        platform: "PASSPERCENT",
        status: "SUCCESS",
      }),
    ).rejects.toThrow();
  });

  it("rejects a status outside the enum", async () => {
    await expect(
      SyncRun.create({
        institutionId: "INS0001",
        platform: "PASSPERCENT",
        startedAt: new Date(),
        status: "RUNNING",
      }),
    ).rejects.toThrow();
  });
});
