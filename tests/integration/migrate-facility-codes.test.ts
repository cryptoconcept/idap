import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Institution } from "@/models";
import { migrateFacilityCodes } from "../../scripts/migrate-facility-codes";

beforeAll(async () => {
  await startTestDatabase("migratefacilitycodes");
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("facility code migration", () => {
  it("stores a lowercase facility code without uppercasing it", async () => {
    await makeInstitution("INS0009", {
      facilities: [{ code: "library", label: "Library", available: true }],
    });
    const row = await Institution.findOne({ institutionId: "INS0009" }).lean();
    expect(row!.facilities![0].code).toBe("library");
  });

  it("converts the mappable codes and preserves label, available and note", async () => {
    await makeInstitution("INS0001", {
      facilities: [
        { code: "LIBRARY", label: "Library", available: true, note: "Two floors" },
        { code: "SMART_CLASSROOM", label: "Smart Classroom", available: false },
      ],
    });

    const report = await migrateFacilityCodes({ apply: true });

    expect(report.converted).toBe(1);
    expect(report.unmapped).toEqual([]);
    const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
    expect(row?.facilities).toEqual([
      { code: "library", label: "Library", available: true, note: "Two floors" },
      { code: "smart_classes", label: "Smart Classroom", available: false },
    ]);
  });

  // MUTATION-DISTINGUISHING: converting HOSTEL or SPORTS to any target is the
  // data fabrication this migration exists to avoid. They must survive untouched
  // AND be reported — a silent drop would satisfy a "no wrong code" assertion.
  it("leaves HOSTEL and SPORTS untouched and reports them", async () => {
    await makeInstitution("INS0002", {
      facilities: [
        { code: "HOSTEL", label: "Hostel", available: true },
        { code: "SPORTS", label: "Sports", available: true },
        { code: "LIBRARY", label: "Library", available: true },
      ],
    });

    const report = await migrateFacilityCodes({ apply: true });

    const row = await Institution.findOne({ institutionId: "INS0002" }).lean();
    const codes = row?.facilities?.map((f) => f.code);
    expect(codes).toEqual(["HOSTEL", "SPORTS", "library"]);
    expect(report.unmapped).toEqual([
      { institutionId: "INS0002", code: "HOSTEL", label: "Hostel" },
      { institutionId: "INS0002", code: "SPORTS", label: "Sports" },
    ]);
  });

  it("is idempotent — a second run converts nothing", async () => {
    await makeInstitution("INS0003", {
      facilities: [{ code: "LIBRARY", label: "Library", available: true }],
    });

    await migrateFacilityCodes({ apply: true });
    const second = await migrateFacilityCodes({ apply: true });

    expect(second.converted).toBe(0);
  });

  it("writes nothing in dry-run mode", async () => {
    await makeInstitution("INS0004", {
      facilities: [{ code: "LIBRARY", label: "Library", available: true }],
    });

    const report = await migrateFacilityCodes({ apply: false });

    expect(report.converted).toBe(1);
    const row = await Institution.findOne({ institutionId: "INS0004" }).lean();
    expect(row?.facilities?.[0].code).toBe("LIBRARY");
  });
});
