import { describe, expect, it } from "vitest";
import { deriveOfferings, type OfferingUnit } from "@/lib/academic/offerings";

let counter = 0;
function unit(overrides: Partial<OfferingUnit> & { name: string }): OfferingUnit {
  counter += 1;
  return {
    id: `id-${counter}`,
    segment: "SCHOOL",
    parentId: null,
    depth: 0,
    sortOrder: 0,
    active: true,
    ...overrides,
  };
}

describe("deriveOfferings", () => {
  it("reads a school tree into classesOffered and leaves coursesOffered empty", () => {
    const units = [
      unit({ name: "Grade 1", sortOrder: 0 }),
      unit({ name: "Grade 2", sortOrder: 1 }),
    ];

    expect(deriveOfferings(units, ["SCHOOL"])).toEqual({
      classesOffered: ["Grade 1", "Grade 2"],
      coursesOffered: [],
    });
  });

  it("reads a PU tree at the combination tier, not the year tier", () => {
    const year = unit({ name: "PUC 1st Year", segment: "PRE_UNIVERSITY" });
    const units = [
      year,
      unit({ name: "PCMB", segment: "PRE_UNIVERSITY", parentId: year.id, depth: 1, sortOrder: 0 }),
      unit({ name: "CEBA", segment: "PRE_UNIVERSITY", parentId: year.id, depth: 1, sortOrder: 1 }),
    ];

    expect(deriveOfferings(units, ["PRE_UNIVERSITY"])).toEqual({
      classesOffered: [],
      coursesOffered: ["PCMB", "CEBA"],
    });
  });

  it("reads an engineering tree at the branch tier, not the programme or year tier", () => {
    const programme = unit({ name: "B.E.", segment: "ENGINEERING" });
    const branch = unit({
      name: "Computer Science",
      segment: "ENGINEERING",
      parentId: programme.id,
      depth: 1,
    });
    const units = [
      programme,
      branch,
      unit({ name: "Year 1", segment: "ENGINEERING", parentId: branch.id, depth: 2 }),
    ];

    expect(deriveOfferings(units, ["ENGINEERING"]).coursesOffered).toEqual(["Computer Science"]);
  });

  it("excludes an active unit whose ancestor is inactive", () => {
    const year = unit({ name: "PUC 1st Year", segment: "PRE_UNIVERSITY", active: false });
    const live = unit({ name: "PUC 2nd Year", segment: "PRE_UNIVERSITY", sortOrder: 1 });
    const units = [
      year,
      live,
      unit({ name: "PCMB", segment: "PRE_UNIVERSITY", parentId: year.id, depth: 1 }),
      unit({ name: "CEBA", segment: "PRE_UNIVERSITY", parentId: live.id, depth: 1 }),
    ];

    expect(deriveOfferings(units, ["PRE_UNIVERSITY"]).coursesOffered).toEqual(["CEBA"]);
  });

  it("fills both arrays for a composite school and PU institution", () => {
    const year = unit({ name: "PUC 1st Year", segment: "PRE_UNIVERSITY" });
    const units = [
      unit({ name: "Grade 10" }),
      year,
      unit({ name: "PCMB", segment: "PRE_UNIVERSITY", parentId: year.id, depth: 1 }),
    ];

    expect(deriveOfferings(units, ["PRE_UNIVERSITY", "SCHOOL"])).toEqual({
      classesOffered: ["Grade 10"],
      coursesOffered: ["PCMB"],
    });
  });

  it("publishes a name shared by two parents only once", () => {
    const first = unit({ name: "PUC 1st Year", segment: "PRE_UNIVERSITY", sortOrder: 0 });
    const second = unit({ name: "PUC 2nd Year", segment: "PRE_UNIVERSITY", sortOrder: 1 });
    const units = [
      first,
      second,
      unit({ name: "PCMB", segment: "PRE_UNIVERSITY", parentId: first.id, depth: 1 }),
      unit({ name: "PCMB", segment: "PRE_UNIVERSITY", parentId: second.id, depth: 1 }),
    ];

    expect(deriveOfferings(units, ["PRE_UNIVERSITY"]).coursesOffered).toEqual(["PCMB"]);
  });

  it("orders by the whole ancestor chain, not by raw sortOrder", () => {
    // Both parents hold a child at sortOrder 0. Sorting on sortOrder alone
    // would interleave them; the second parent's children must all follow the
    // first parent's.
    const first = unit({ name: "PUC 1st Year", segment: "PRE_UNIVERSITY", sortOrder: 0 });
    const second = unit({ name: "PUC 2nd Year", segment: "PRE_UNIVERSITY", sortOrder: 1 });
    const units = [
      second,
      unit({ name: "B-second", segment: "PRE_UNIVERSITY", parentId: second.id, depth: 1, sortOrder: 0 }),
      unit({ name: "B-first", segment: "PRE_UNIVERSITY", parentId: first.id, depth: 1, sortOrder: 1 }),
      first,
      unit({ name: "A-first", segment: "PRE_UNIVERSITY", parentId: first.id, depth: 1, sortOrder: 0 }),
      // Two-digit sortOrder, reachable as soon as a parent has 11+ children.
      // Without the zero-padding in `sortKey`, "0.10" sorts before "0.2" and
      // this pair comes back reversed.
      unit({ name: "D-first", segment: "PRE_UNIVERSITY", parentId: first.id, depth: 1, sortOrder: 10 }),
      unit({ name: "C-first", segment: "PRE_UNIVERSITY", parentId: first.id, depth: 1, sortOrder: 2 }),
    ];

    expect(deriveOfferings(units, ["PRE_UNIVERSITY"]).coursesOffered).toEqual([
      "A-first",
      "B-first",
      "C-first",
      "D-first",
      "B-second",
    ]);
  });
});
