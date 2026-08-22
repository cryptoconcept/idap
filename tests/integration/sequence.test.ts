import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import {
  generateApplicationNumber,
  generateInstitutionId,
  generateLeadNumber,
  reserveInstitutionId,
} from "@/services/sequence.service";

describe("identifier generation", () => {
  beforeAll(async () => {
    await startTestDatabase("sequences");
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("issues the documented formats", async () => {
    expect(await generateLeadNumber("INS0001")).toBe("INS0001-LD000001");
    expect(await generateApplicationNumber("INS0001")).toBe("INS0001-APP-000001");
    expect(await generateInstitutionId()).toBe("INS0001");
  });

  it("counts up within one institution", async () => {
    const numbers = [];
    for (let index = 0; index < 3; index += 1) {
      numbers.push(await generateApplicationNumber("INS0001"));
    }
    expect(numbers).toEqual([
      "INS0001-APP-000001",
      "INS0001-APP-000002",
      "INS0001-APP-000003",
    ]);
  });

  it("counts independently per institution and per record type", async () => {
    await generateApplicationNumber("INS0001");
    await generateApplicationNumber("INS0001");

    // A different tenant starts at 1, and leads have their own counter.
    expect(await generateApplicationNumber("INS0002")).toBe("INS0002-APP-000001");
    expect(await generateLeadNumber("INS0001")).toBe("INS0001-LD000001");
  });

  it("never issues the same number twice under concurrency", async () => {
    // The property that matters: application numbers are the applicant's
    // reference, and a collision would merge two families' records.
    const results = await Promise.all(
      Array.from({ length: 100 }, () => generateApplicationNumber("INS0001")),
    );

    expect(new Set(results).size).toBe(100);
    expect(results).toContain("INS0001-APP-000001");
    expect(results).toContain("INS0001-APP-000100");
  });

  it("keeps separate tenants from colliding under concurrency", async () => {
    const results = await Promise.all([
      ...Array.from({ length: 40 }, () => generateLeadNumber("INS0001")),
      ...Array.from({ length: 40 }, () => generateLeadNumber("INS0002")),
    ]);
    expect(new Set(results).size).toBe(80);
    expect(results.filter((n) => n.startsWith("INS0001")).length).toBe(40);
  });

  it("pads to a stable width", async () => {
    for (let index = 0; index < 11; index += 1) await generateLeadNumber("INS0001");
    expect(await generateLeadNumber("INS0001")).toBe("INS0001-LD000012");
  });

  it("does not reuse a manually assigned institution id", async () => {
    await reserveInstitutionId("INS0007");
    expect(await generateInstitutionId()).toBe("INS0008");
  });

  it("leaves the counter alone when reserving a lower id", async () => {
    await reserveInstitutionId("INS0009");
    await reserveInstitutionId("INS0002");
    expect(await generateInstitutionId()).toBe("INS0010");
  });
});
