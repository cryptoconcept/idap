import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { FeeStructure } from "@/models";
import { FeeStructureService } from "@/services/fee-structure.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

const input = {
  classOrCourse: "Grade 10",
  academicYear: "2026-27",
  lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" as const }],
};

beforeAll(async () => {
  await startTestDatabase("fee-structure-crud");
  await FeeStructure.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

describe("FeeStructureService CRUD", () => {
  it("creates a fee structure and reads it back", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);

    expect(created.id).toBeDefined();
    expect(created.status).toBe("DRAFT");
    expect(created.publishedAt).toBeUndefined();

    const read = await FeeStructureService.get("INS0001", created.id);
    expect(read.academicYear).toBe("2026-27");
    expect(read.lineItems).toHaveLength(1);
  });

  it("refuses a duplicate (classOrCourse, academicYear) via the unique index, not a pre-read", async () => {
    await FeeStructureService.create("INS0001", input, actor);

    await expect(FeeStructureService.create("INS0001", input, actor)).rejects.toMatchObject({
      code: 11000,
    });
  });

  it("lets two institutions hold the same class/course and year independently", async () => {
    await FeeStructureService.create("INS0001", input, actor);
    await expect(FeeStructureService.create("INS0002", input, actor)).resolves.toBeDefined();
  });

  it("merges a partial patch without erasing untouched fields", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);

    const updated = await FeeStructureService.update(
      "INS0001",
      created.id,
      { academicYear: "2027-28" },
      actor,
    );

    expect(updated.academicYear).toBe("2027-28");
    expect(updated.lineItems).toHaveLength(1);
    expect(updated.lineItems?.[0]?.label).toBe("Tuition");
  });

  it("replaces lineItems wholesale rather than merging element by element", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);

    const updated = await FeeStructureService.update(
      "INS0001",
      created.id,
      { lineItems: [{ label: "Only", amount: 1000, frequency: "ONE_TIME" }] },
      actor,
    );

    expect(updated.lineItems).toHaveLength(1);
    expect(updated.lineItems?.[0]?.label).toBe("Only");
  });

  it("validates invariants against the merged record when lineItems are patched", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      {
        classOrCourse: "Grade 10",
        academicYear: "2026-27",
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      },
      actor,
    );

    await expect(
      FeeStructureService.update(
        "INS0001",
        created.id,
        {
          lineItems: [
            { label: "Tuition", amount: 60000, frequency: "ANNUAL" },
            { label: "Tuition", amount: 1000, frequency: "ONE_TIME" },
          ],
        },
        actor,
      ),
    ).rejects.toThrow(/appears more than once/i);
  });

  it("rejects emptying a PUBLISHED fee structure's line items — the publish gate still applies on every edit", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      {
        classOrCourse: "Grade 10",
        academicYear: "2026-27",
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      },
      actor,
    );
    await FeeStructureService.setStatus("INS0001", created.id, "publish", actor);

    await expect(
      FeeStructureService.update("INS0001", created.id, { lineItems: [] }, actor),
    ).rejects.toThrow(/at least one line item/i);
  });

  it("still allows a DRAFT fee structure to be patched to an empty lineItems array — the weaker gate applies to drafts", async () => {
    const created = await FeeStructureService.create(
      "INS0001",
      {
        classOrCourse: "Grade 10",
        academicYear: "2026-27",
        lineItems: [{ label: "Tuition", amount: 60000, frequency: "ANNUAL" }],
      },
      actor,
    );

    const updated = await FeeStructureService.update(
      "INS0001",
      created.id,
      { lineItems: [] },
      actor,
    );
    expect(updated.lineItems).toBeUndefined();
  });

  it("returns NOT_FOUND, never FORBIDDEN, for another institution's fee structure", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);

    await expect(FeeStructureService.get("INS0002", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      FeeStructureService.update("INS0002", created.id, { academicYear: "2027-28" }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(FeeStructureService.remove("INS0002", created.id, actor)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lists only the calling institution's fee structures, newest academic year first", async () => {
    await FeeStructureService.create("INS0001", { ...input, academicYear: "2025-26" }, actor);
    await FeeStructureService.create("INS0001", { ...input, academicYear: "2026-27" }, actor);
    await FeeStructureService.create("INS0002", input, actor);

    const list = await FeeStructureService.list("INS0001");

    expect(list).toHaveLength(2);
    expect(list[0]?.academicYear).toBe("2026-27");
  });

  it("deletes a fee structure", async () => {
    const created = await FeeStructureService.create("INS0001", input, actor);
    await FeeStructureService.remove("INS0001", created.id, actor);

    await expect(FeeStructureService.get("INS0001", created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects a malformed feeStructureId as NOT_FOUND rather than throwing a cast error", async () => {
    await expect(FeeStructureService.get("INS0001", "not-an-object-id")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
