import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { ResultService } from "@/services/result.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };
const cycle = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  stream: null,
  academicYear: "2025-26",
  appeared: 142,
  passed: 140,
};

beforeAll(() => startTestDatabase("results-publish"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("publish lifecycle", () => {
  it("publishes a valid cycle and stamps publishedAt", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const published = await ResultService.setStatus("INS0001", created.id, "publish", actor);

    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).toBeDefined();
  });

  it("refuses to publish a cycle with nobody appearing", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, appeared: 0, passed: 0 },
      actor,
    );

    await expect(
      ResultService.setStatus("INS0001", created.id, "publish", actor),
    ).rejects.toThrow(/appeared/i);
  });

  it("refuses to publish while a topper lacks acknowledged consent", async () => {
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        toppers: [
          { name: "Priya S", percentage: 98.6, consentAcknowledged: true },
          { name: "Rahul K", percentage: 97.8, consentAcknowledged: false },
        ],
      },
      actor,
    );

    await expect(
      ResultService.setStatus("INS0001", created.id, "publish", actor),
    ).rejects.toThrow(/Rahul K/);
  });

  it("keeps publishedAt at the FIRST publication across a republish", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    const first = await ResultService.setStatus("INS0001", created.id, "publish", actor);

    await ResultService.setStatus("INS0001", created.id, "unpublish", actor);
    const again = await ResultService.setStatus("INS0001", created.id, "publish", actor);

    expect(again.publishedAt).toBe(first.publishedAt);
  });

  it("unpublishing returns the cycle to DRAFT without losing data", async () => {
    const created = await ResultService.create(
      "INS0001",
      { ...cycle, averageScore: 82.4 },
      actor,
    );
    await ResultService.setStatus("INS0001", created.id, "publish", actor);
    const drafted = await ResultService.setStatus("INS0001", created.id, "unpublish", actor);

    expect(drafted.status).toBe("DRAFT");
    expect(drafted.averageScore).toBe(82.4);
    expect(drafted.publishedAt).toBeDefined();
  });

  it("archives a published cycle", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.setStatus("INS0001", created.id, "publish", actor);
    const archived = await ResultService.setStatus("INS0001", created.id, "archive", actor);

    expect(archived.status).toBe("ARCHIVED");
  });

  it("refuses to change another institution's result", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);

    await expect(
      ResultService.setStatus("INS0002", created.id, "publish", actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
