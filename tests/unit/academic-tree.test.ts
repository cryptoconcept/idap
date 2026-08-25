import { describe, expect, it } from "vitest";
import { flattenTree, inactiveIds, type TreeUnit } from "@/lib/academic/tree";

let counter = 0;
function unit(overrides: Partial<TreeUnit> & { id?: string } = {}): TreeUnit {
  counter += 1;
  return {
    id: overrides.id ?? `id-${counter}`,
    parentId: null,
    depth: 0,
    sortOrder: 0,
    active: true,
    ...overrides,
  };
}

describe("flattenTree", () => {
  it("renders parents before their children, siblings in sortOrder", () => {
    const a = unit({ id: "a", sortOrder: 1 });
    const b = unit({ id: "b", sortOrder: 0 });
    const a1 = unit({ id: "a1", parentId: "a", depth: 1 });

    expect(flattenTree([a1, a, b]).map((u) => u.id)).toEqual(["b", "a", "a1"]);
  });

  it("keeps a unit whose parent is missing instead of dropping it", () => {
    const a = unit({ id: "a" });
    const orphan = unit({ id: "orphan", parentId: "gone", depth: 1 });

    // It exists in the database; an admin who cannot see it cannot fix it.
    expect(flattenTree([a, orphan]).map((u) => u.id)).toEqual(["a", "orphan"]);
  });

  it("terminates on a parent cycle rather than recursing forever", () => {
    const x = unit({ id: "x", parentId: "y", depth: 1 });
    const y = unit({ id: "y", parentId: "x", depth: 1 });

    // Neither is reachable from the root walk, so both surface via the orphan pass.
    expect(flattenTree([x, y]).map((u) => u.id).sort()).toEqual(["x", "y"]);
  });
});

describe("inactiveIds", () => {
  it("marks a unit whose ancestor is inactive, not just an inactive unit", () => {
    const root = unit({ id: "root", active: false });
    const child = unit({ id: "child", parentId: "root", depth: 1 });
    const live = unit({ id: "live" });

    const inactive = inactiveIds([root, child, live]);
    expect(inactive.has("root")).toBe(true);
    expect(inactive.has("child")).toBe(true);
    expect(inactive.has("live")).toBe(false);
  });
});
