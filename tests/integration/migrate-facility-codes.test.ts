import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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

  // MUTATION-DISTINGUISHING: `LEGACY_FACILITY_CODE_MAP` is a plain object
  // literal, so an unguarded `MAP[code]` lookup walks the prototype chain.
  // A facility literally coded "constructor" must be treated exactly like
  // any other custom code this migration has never heard of — left in place,
  // byte-identical, and never pushed to `unmapped` — while the real LIBRARY
  // alongside it still converts normally.
  it("treats a facility coded like an inherited object property as an ordinary untouched custom code", async () => {
    await makeInstitution("INS0010", {
      facilities: [
        { code: "constructor", label: "Odd Code", available: true },
        { code: "LIBRARY", label: "Library", available: true },
      ],
    });

    const report = await migrateFacilityCodes({ apply: true });

    expect(report.unmapped).toEqual([]);
    const row = await Institution.findOne({ institutionId: "INS0010" }).lean();
    expect(row?.facilities).toEqual([
      { code: "constructor", label: "Odd Code", available: true },
      { code: "library", label: "Library", available: true },
    ]);
  });

  // MUTATION-DISTINGUISHING: forces the exact race the concurrency
  // precondition exists to defend against — a write lands on the collection
  // between the migration's cursor read and its own `updateOne`. If the
  // precondition were removed (or always matched), the concurrent writer's
  // facilities would be silently overwritten by the migration's stale copy.
  // The property that matters is the surviving row, not just the counters.
  it("does not clobber a concurrent write, and reports the race under skipped", async () => {
    await makeInstitution("INS0011", {
      facilities: [{ code: "LIBRARY", label: "Library", available: true }],
    });

    const originalUpdateOne = Institution.collection.updateOne.bind(Institution.collection);
    const spy = vi
      .spyOn(Institution.collection, "updateOne")
      .mockImplementation(async (filter, update, options) => {
        // The concurrent admin edit: lands directly on the collection,
        // between the migration's cursor read (which saw the original
        // facilities array) and the migration's own write below.
        await originalUpdateOne(
          { institutionId: "INS0011" },
          {
            $set: {
              facilities: [
                { code: "LIBRARY", label: "Library", available: true, note: "Edited mid-run" },
              ],
            },
          },
        );
        return originalUpdateOne(filter, update, options);
      });

    let report;
    try {
      report = await migrateFacilityCodes({ apply: true });
    } finally {
      spy.mockRestore();
    }

    expect(report.converted).toBe(0);
    expect(report.skipped).toEqual([
      { institutionId: "INS0011", reason: "facilities changed concurrently — re-run" },
    ]);

    const row = await Institution.findOne({ institutionId: "INS0011" }).lean();
    expect(row?.facilities).toEqual([
      { code: "LIBRARY", label: "Library", available: true, note: "Edited mid-run" },
    ]);
  });

  // MUTATION-DISTINGUISHING: replacing the `$in` selector with `{}` leaves
  // `scanned` counting every institution in the database instead of only
  // those holding a recognised legacy code — this is the only assertion in
  // the suite that would catch it. Also covers per-institution isolation
  // (converting one institution must not touch another's facilities) and
  // the unmappable-only branch (an institution holding nothing but HOSTEL
  // never increments `converted`, since nothing about it "changed").
  it("scans only institutions holding a recognised legacy code, and leaves every other institution untouched", async () => {
    await makeInstitution("INS0020", {
      facilities: [{ code: "LIBRARY", label: "Library", available: true }],
    });
    await makeInstitution("INS0021", {
      facilities: [{ code: "ROBOTICS_LAB", label: "Robotics Lab", available: true }],
    });
    await makeInstitution("INS0022", {
      facilities: [{ code: "library", label: "Library", available: true }],
    });
    await makeInstitution("INS0023", {
      facilities: [{ code: "HOSTEL", label: "Hostel", available: true }],
    });

    const report = await migrateFacilityCodes({ apply: true });

    expect(report.scanned).toBe(2); // INS0020 (mappable) + INS0023 (unmappable-only)
    expect(report.converted).toBe(1); // only INS0020
    expect(report.unmapped).toEqual([{ institutionId: "INS0023", code: "HOSTEL", label: "Hostel" }]);
    expect(report.skipped).toEqual([]);

    const converted = await Institution.findOne({ institutionId: "INS0020" }).lean();
    expect(converted?.facilities).toEqual([{ code: "library", label: "Library", available: true }]);

    const custom = await Institution.findOne({ institutionId: "INS0021" }).lean();
    expect(custom?.facilities).toEqual([{ code: "ROBOTICS_LAB", label: "Robotics Lab", available: true }]);

    const alreadyConverted = await Institution.findOne({ institutionId: "INS0022" }).lean();
    expect(alreadyConverted?.facilities).toEqual([{ code: "library", label: "Library", available: true }]);

    const unmappableOnly = await Institution.findOne({ institutionId: "INS0023" }).lean();
    expect(unmappableOnly?.facilities).toEqual([{ code: "HOSTEL", label: "Hostel", available: true }]);
  });
});
