import { describe, it, expect } from "vitest";
import { Vacancy } from "@/models";
import { VACANCY_STATUSES } from "@/lib/constants";

const base = {
  institutionId: "INS0001",
  title: "Maths Teacher",
  subject: "Mathematics",
  description: "Teach CBSE Grade 8-10.",
};

describe("Vacancy model", () => {
  it("defaults status to DRAFT, and the default is a legal status", () => {
    const doc = new Vacancy(base);
    expect(doc.status).toBe("DRAFT");
    expect(VACANCY_STATUSES).toContain(doc.status);
  });

  it("requires institutionId", () => {
    const err = new Vacancy({ ...base, institutionId: undefined }).validateSync();
    expect(err?.errors.institutionId).toBeDefined();
  });

  it("requires title", () => {
    const err = new Vacancy({ ...base, title: undefined }).validateSync();
    expect(err?.errors.title).toBeDefined();
  });

  it("requires description", () => {
    const err = new Vacancy({ ...base, description: undefined }).validateSync();
    expect(err?.errors.description).toBeDefined();
  });

  it("rejects an unknown subject", () => {
    const err = new Vacancy({ ...base, subject: "Astrology" }).validateSync();
    expect(err?.errors.subject).toBeDefined();
  });

  it("declares both compound indexes", () => {
    const fields = Vacancy.schema.indexes().map(([f]) => f);
    const byCreatedAt = fields.find((f) => f.institutionId === 1 && f.createdAt === -1 && !("status" in f));
    const byStatus = fields.find((f) => f.institutionId === 1 && f.status === 1);
    expect(byCreatedAt).toBeDefined();
    expect(byStatus).toBeDefined();
  });
});
