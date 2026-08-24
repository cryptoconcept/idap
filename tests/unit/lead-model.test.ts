import { describe, expect, it } from "vitest";
import { Lead } from "@/models/Lead";

describe("Lead model — assignment and follow-up fields", () => {
  it("defaults a new lead to unassigned with no follow-up", () => {
    const doc = new Lead({
      leadNumber: "INS0001-LD000001",
      institutionId: "INS0001",
      studentName: "Test Student",
      phone: "9876543210",
      status: "NEW",
      source: "API",
    });

    expect(doc.assignedTo).toBeUndefined();
    expect(doc.assignedAt).toBeUndefined();
    expect(doc.followUpAt).toBeUndefined();
    expect(doc.followUpNotifiedAt).toBeUndefined();
  });

  it("accepts an assignedTo id and a followUpAt date", () => {
    const doc = new Lead({
      leadNumber: "INS0001-LD000002",
      institutionId: "INS0001",
      studentName: "Test Student",
      phone: "9876543210",
      status: "NEW",
      source: "API",
      assignedTo: "6a887abd755db527bea51204",
      assignedAt: new Date(),
      followUpAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.assignedTo).toBe("6a887abd755db527bea51204");
  });

  it("declares the assignment-queue and follow-up-cron indexes", () => {
    const indexes = Lead.schema.indexes();

    expect(
      indexes.some(
        ([fields]) =>
          fields.institutionId === 1 && fields.assignedTo === 1 && fields.createdAt === -1,
      ),
    ).toBe(true);

    expect(
      indexes.some(([fields]) => fields.followUpAt === 1 && fields.followUpNotifiedAt === 1),
    ).toBe(true);
  });
});
