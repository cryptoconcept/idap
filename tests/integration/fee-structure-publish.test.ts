import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { AcademicUnit, FeeStructure } from "@/models";
import { AcademicStructureService, type AcademicUnitDTO } from "@/services/academic-structure.service";
import { FeeStructureService } from "@/services/fee-structure.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

let unitA: AcademicUnitDTO;

beforeAll(async () => {
  await startTestDatabase("fee-structure-publish");
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");

  await AcademicUnit.syncIndexes();
  unitA = await AcademicStructureService.create(
    "INS0001",
    { segment: "SCHOOL", name: "Grade 10" },
    actor,
  );
});

describe("FeeStructureService.setStatus", () => {
  it("refuses to publish with zero line items", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      { academicUnitId: unitA.id, academicYear: "2026-27" },
      actor,
    );

    await expect(
      FeeStructureService.setStatus("INS0001", created.id, "publish", actor),
    ).rejects.toThrow(/at least one line item/i);
  });

  it("publishes and stamps publishedAt", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      {
        academicUnitId: unitA.id,
        academicYear: "2026-27",
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      },
      actor,
    );

    const published = await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).toBeDefined();
  });

  it("does not move publishedAt on a later publish", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      {
        academicUnitId: unitA.id,
        academicYear: "2026-27",
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      },
      actor,
    );

    const first = await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);
    await FeeStructureService.setStatus("INS0001", created.id, "unpublish", actor);
    const second = await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    expect(second.publishedAt).toBe(first.publishedAt);
  });

  it("unpublish preserves the line items", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      {
        academicUnitId: unitA.id,
        academicYear: "2026-27",
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    const unpublished = await FeeStructureService.setStatus(
      "INS0001",
      created.id,
      "unpublish",
      actor,
    );

    expect(unpublished.status).toBe("DRAFT");
    expect(unpublished.lineItems).toHaveLength(1);
  });

  it("archives a published structure", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      {
        academicUnitId: unitA.id,
        academicYear: "2026-27",
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    const archived = await FeeStructureService.setStatus("INS0001", created.id, "archive", actor);

    expect(archived.status).toBe("ARCHIVED");
  });
});
