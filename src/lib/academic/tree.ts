/**
 * Shape-only inputs, mirroring `OfferingUnit` in `./offerings`. Kept structural so
 * these stay testable in a node environment: the richer `AcademicUnitDTO` lives on
 * a `server-only` service that a client component may import only as a type.
 */
export type TreeUnit = {
  id: string;
  parentId: string | null;
  depth: number;
  sortOrder: number;
  active: boolean;
};

/**
 * Rows in render order, each carrying its own `depth` for indenting. A flat list is
 * easier to key and style than a nested render, and the tree is tens of nodes.
 *
 * Generic so a caller gets its own richer type back rather than `TreeUnit`.
 */
export function flattenTree<T extends TreeUnit>(units: T[]): T[] {
  const childrenOf = new Map<string, T[]>();
  for (const unit of units) {
    const key = unit.parentId ?? "";
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(unit);
    else childrenOf.set(key, [unit]);
  }
  for (const bucket of childrenOf.values()) bucket.sort((a, b) => a.sortOrder - b.sortOrder);

  const ordered: T[] = [];
  const seen = new Set<string>();

  const walk = (parentId: string) => {
    for (const unit of childrenOf.get(parentId) ?? []) {
      // Also the cycle guard: a corrupt parent link cannot re-enter a visited node.
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      ordered.push(unit);
      walk(unit.id);
    }
  };
  walk("");

  // A unit whose parent is missing is unreachable from the root walk, but it still
  // exists in the database. Append it rather than dropping it — an admin who cannot
  // see a unit cannot fix it. Stable order, so the editor stays predictable.
  for (const unit of units) {
    if (!seen.has(unit.id)) ordered.push(unit);
  }

  return ordered;
}

/**
 * A unit reads as inactive when it or any ancestor is — the read-time deactivation
 * rule, so hiding a subtree is one reversible write rather than a cascade.
 *
 * The walk is bounded by the starting depth, mirroring `effectivelyActive` in
 * `./offerings`: a well-formed chain reaches a root in exactly `depth` hops, so a
 * corrupt parent link cannot loop forever.
 */
export function inactiveIds(units: TreeUnit[]): Set<string> {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const inactive = new Set<string>();

  for (const unit of units) {
    let current: TreeUnit | undefined = unit;
    let reachedRoot = false;
    for (let hops = unit.depth; current && hops >= 0; hops -= 1) {
      if (!current.active) break;
      if (current.parentId === null) {
        reachedRoot = true;
        break;
      }
      current = byId.get(current.parentId);
    }
    // Falling out without reaching a root means an orphan — a parent id that resolves
    // to nothing. `effectivelyActive` in ./offerings excludes it from publishing, so
    // the editor must dim it rather than showing it as live.
    if (!reachedRoot) inactive.add(unit.id);
  }
  return inactive;
}
