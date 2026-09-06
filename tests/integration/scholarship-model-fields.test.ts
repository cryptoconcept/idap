import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { Scholarship } from "@/models/Scholarship";

beforeAll(() => startTestDatabase("scholarship-model-fields"));
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("enriched Scholarship model", () => {
  it("stores the structured fields and a listing sub-doc", async () => {
    const doc = await Scholarship.create({
      institutionId: "INS0001", name: "Infinity Merit", status: "DRAFT",
      summary: "Merit award", description: "x".repeat(220),
      categories: ["merit"], benefits: { amountMin: 10000, tuitionWaiver: true },
      eligibility: { stateCodes: ["KA"], genders: ["female"], communityCategories: ["obc"], otherCriteria: ["Top 10%"] },
      applicationMode: "platform",
      requiredDocuments: [{ key: "marksheet", label: "Marksheet", required: true }],
      dates: { closesAt: new Date(Date.now() + 30 * 864e5) },
      listing: { hubId: "h1", externalRef: "IDAP:INS0001:x", slug: "infinity-merit", remoteStatus: "published", lastPushedAt: new Date() },
    });
    const stored = await Scholarship.findById(doc._id).lean();
    expect(stored?.benefits?.amountMin).toBe(10000);
    expect(stored?.eligibility?.stateCodes).toEqual(["KA"]);
    expect(stored?.applicationMode).toBe("platform");
    expect(stored?.listing?.remoteStatus).toBe("published");
  });

  it("defaults applicationMode to platform and leaves listing undefined", async () => {
    const doc = await Scholarship.create({ institutionId: "INS0001", name: "Bare" });
    const stored = await Scholarship.findById(doc._id).lean();
    expect(stored?.applicationMode).toBe("platform");
    expect(stored?.listing).toBeUndefined();
  });
});
