import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { Offer } from "@/models";

beforeAll(async () => {
  await startTestDatabase("offer-model");
  await Offer.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

const base = { institutionId: "INS0001", title: "Early bird", kind: "PERCENTAGE", value: 15 };

describe("Offer model", () => {
  it("defaults a new offer to DRAFT with no publishedAt", async () => {
    const created = await Offer.create(base);

    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();
  });

  it("requires a title, a kind and a value", async () => {
    await expect(Offer.create({ institutionId: "INS0001" })).rejects.toThrow();
    await expect(Offer.create({ ...base, title: undefined })).rejects.toThrow();
    await expect(Offer.create({ ...base, kind: undefined })).rejects.toThrow();
    await expect(Offer.create({ ...base, value: undefined })).rejects.toThrow();
  });

  it("rejects a kind outside the enum", async () => {
    await expect(Offer.create({ ...base, kind: "BOGOF" })).rejects.toThrow();
  });

  it("rejects a negative value", async () => {
    await expect(Offer.create({ ...base, value: -1 })).rejects.toThrow();
  });

  it("leaves validFrom and validUntil unset when absent", async () => {
    const created = await Offer.create(base);

    expect(created.validFrom).toBeUndefined();
    expect(created.validUntil).toBeUndefined();
  });
});
