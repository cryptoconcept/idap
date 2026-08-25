import type { AcademicSegment } from "@/lib/constants";
import { ACADEMIC_BLUEPRINTS, orderSegments } from "./blueprints";

/** The minimum a unit must carry to be derived from. `AcademicUnitDTO` is a superset. */
export type OfferingUnit = {
  id: string;
  segment: string;
  parentId: string | null;
  depth: number;
  name: string;
  sortOrder: number;
  active: boolean;
};

export type DerivedOfferings = {
  classesOffered: string[];
  coursesOffered: string[];
};

/**
 * A unit counts only if it is active *and* every ancestor is active — the
 * read-time deactivation rule, so that hiding a subtree is one reversible write
 * rather than a cascade.
 *
 * The walk is bounded by the starting depth: a well-formed chain reaches a root
 * in exactly `depth` hops, so a corrupt parent link cannot loop forever. An
 * orphan — a parent id that resolves to nothing — reads as inactive, which is
 * the safe direction for something about to be published.
 */
function effectivelyActive(unit: OfferingUnit, byId: Map<string, OfferingUnit>): boolean {
  let current: OfferingUnit | undefined = unit;
  for (let hops = unit.depth; current && hops >= 0; hops -= 1) {
    if (!current.active) return false;
    if (current.parentId === null) return true;
    current = byId.get(current.parentId);
  }
  return false;
}

/**
 * A sort key covering the whole ancestor chain. `sortOrder` is only unique among
 * siblings, so sorting on it alone would interleave two parents' children.
 */
function sortKey(unit: OfferingUnit, byId: Map<string, OfferingUnit>): string {
  const parts: string[] = [];
  let current: OfferingUnit | undefined = unit;
  for (let hops = unit.depth; current && hops >= 0; hops -= 1) {
    parts.unshift(String(current.sortOrder).padStart(6, "0"));
    if (current.parentId === null) break;
    current = byId.get(current.parentId);
  }
  return parts.join(".");
}

/**
 * The names worth publishing on a profile, read from each selected segment's
 * `offeringDepth`. School names become `classesOffered`; every other segment's
 * become `coursesOffered`.
 */
export function deriveOfferings(
  units: OfferingUnit[],
  segments: readonly string[],
): DerivedOfferings {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const classesOffered: string[] = [];
  const coursesOffered: string[] = [];

  for (const segment of orderSegments(segments)) {
    const blueprint = ACADEMIC_BLUEPRINTS[segment as AcademicSegment];
    const target = segment === "SCHOOL" ? classesOffered : coursesOffered;

    const names = units
      .filter(
        (unit) =>
          unit.segment === segment &&
          unit.depth === blueprint.offeringDepth &&
          effectivelyActive(unit, byId),
      )
      .sort((a, b) => sortKey(a, byId).localeCompare(sortKey(b, byId)))
      .map((unit) => unit.name);

    // De-duplicated: a name offered under two parents is one public offering.
    for (const name of names) {
      if (!target.includes(name)) target.push(name);
    }
  }

  return { classesOffered, coursesOffered };
}
