"use client";

import { Badge } from "@/components/ui/badge";
import type { AcademicSegment } from "@/lib/constants";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";

/**
 * Rows in render order, each already carrying its own `depth` for indenting. A
 * flat list is easier to key and style than a nested render, and the tree is
 * tens of nodes.
 */
export function flattenTree(units: AcademicUnitDTO[]): AcademicUnitDTO[] {
  const childrenOf = new Map<string, AcademicUnitDTO[]>();
  for (const unit of units) {
    const key = unit.parentId ?? "";
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(unit);
    else childrenOf.set(key, [unit]);
  }
  for (const bucket of childrenOf.values()) bucket.sort((a, b) => a.sortOrder - b.sortOrder);

  const ordered: AcademicUnitDTO[] = [];
  const walk = (parentId: string) => {
    for (const unit of childrenOf.get(parentId) ?? []) {
      ordered.push(unit);
      walk(unit.id);
    }
  };
  walk("");
  return ordered;
}

/** A unit reads as inactive when it or any ancestor is — the read-time rule, made visible. */
export function inactiveIds(units: AcademicUnitDTO[]): Set<string> {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const inactive = new Set<string>();

  for (const unit of units) {
    let current: AcademicUnitDTO | undefined = unit;
    for (let hops = unit.depth; current && hops >= 0; hops -= 1) {
      if (!current.active) {
        inactive.add(unit.id);
        break;
      }
      if (current.parentId === null) break;
      current = byId.get(current.parentId);
    }
  }
  return inactive;
}

export function UnitTree({
  segment,
  units,
}: {
  segment: AcademicSegment;
  units: AcademicUnitDTO[];
  /** Task 10 wires this to a refresh once the rows become editable. */
  onChanged?: () => void;
}) {
  const rows = flattenTree(units);
  const dimmed = inactiveIds(units);

  if (rows.length === 0) return null;

  return (
    <div className="rounded-lg border border-border" data-segment={segment}>
      {rows.map((unit) => (
        <div
          key={unit.id}
          className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-0"
          style={{ paddingLeft: `${16 + unit.depth * 20}px` }}
        >
          <span
            className={`text-sm ${dimmed.has(unit.id) ? "text-muted-foreground line-through" : ""}`}
          >
            {unit.name}
          </span>
          <span className="text-xs text-muted-foreground">{unit.levelLabel}</span>
          {dimmed.has(unit.id) ? (
            <Badge variant="outline" className="text-xs">
              Inactive
            </Badge>
          ) : null}
        </div>
      ))}
    </div>
  );
}
