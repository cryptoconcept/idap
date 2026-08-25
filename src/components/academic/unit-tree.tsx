"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ACADEMIC_BLUEPRINTS, PATH_SEPARATOR, levelFor } from "@/lib/academic/blueprints";
import { flattenTree, inactiveIds } from "@/lib/academic/tree";
import type { AcademicSegment } from "@/lib/constants";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";

const BASE = "/api/settings/academic-structure";

/** Siblings under one parent, in their stored order. */
function siblingsOf(units: AcademicUnitDTO[], parentId: string | null): AcademicUnitDTO[] {
  return units.filter((unit) => unit.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder);
}

export function UnitTree({
  segment,
  units,
  onChanged,
}: {
  segment: AcademicSegment;
  units: AcademicUnitDTO[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  /** `""` means "adding a root"; a unit id means "adding under that unit". */
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AcademicUnitDTO | null>(null);

  const rows = flattenTree(units);
  const dimmed = inactiveIds(units);
  const blueprint = ACADEMIC_BLUEPRINTS[segment];
  const rootLevel = blueprint.levels[0];

  /** One place for the fetch/toast/refresh cycle every action shares. */
  async function send(
    url: string,
    init: RequestInit,
    successMessage: string,
    failureMessage: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      const response = await fetch(url, {
        ...init,
        headers: init.body ? { "Content-Type": "application/json" } : undefined,
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? failureMessage);
        return false;
      }
      toast.success(successMessage);
      onChanged();
      return true;
    } catch {
      toast.error("Could not reach the server. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addUnit() {
    const name = draftName.trim();
    if (name.length === 0) return;

    const ok = await send(
      `${BASE}/units`,
      {
        method: "POST",
        body: JSON.stringify({ segment, parentId: addingUnder === "" ? null : addingUnder, name }),
      },
      "Added",
      "Could not add. Please try again.",
    );
    if (ok) {
      setDraftName("");
      setAddingUnder(null);
    }
  }

  async function rename(unit: AcademicUnitDTO) {
    const name = renameValue.trim();
    if (name.length === 0 || name === unit.name) {
      setRenamingId(null);
      return;
    }

    const ok = await send(
      `${BASE}/units/${unit.id}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
      "Renamed",
      "Could not rename. Please try again.",
    );
    if (ok) setRenamingId(null);
  }

  async function toggleActive(unit: AcademicUnitDTO) {
    await send(
      `${BASE}/units/${unit.id}`,
      { method: "PATCH", body: JSON.stringify({ active: !unit.active }) },
      unit.active ? "Hidden" : "Shown",
      "Could not update. Please try again.",
    );
  }

  /**
   * Sends the whole resulting sibling order, never a delta — the endpoint takes
   * a complete sibling set and refuses anything partial.
   */
  async function move(unit: AcademicUnitDTO, direction: -1 | 1) {
    const siblings = siblingsOf(units, unit.parentId);
    const index = siblings.findIndex((sibling) => sibling.id === unit.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= siblings.length) return;

    const ordered = [...siblings];
    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved);

    await send(
      `${BASE}/reorder`,
      {
        method: "POST",
        body: JSON.stringify({
          segment,
          parentId: unit.parentId,
          orderedIds: ordered.map((sibling) => sibling.id),
        }),
      },
      "Reordered",
      "Could not reorder. Please try again.",
    );
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const ok = await send(
      `${BASE}/units/${pendingDelete.id}`,
      { method: "DELETE" },
      "Deleted",
      "Could not delete. Please try again.",
    );
    if (ok) setPendingDelete(null);
  }

  // Prefixed with the separator, not a bare space: "B.E. Civil" is a sibling of
  // "B.E.", not a descendant, and a bare-space prefix match would count it.
  const descendantCount = pendingDelete
    ? units.filter((unit) =>
        unit.pathLabel.startsWith(`${pendingDelete.pathLabel}${PATH_SEPARATOR}`),
      ).length
    : 0;

  /** `addingUnder` already holds the target parent, so this only needs the level. */
  function addRow(level: { label: string; example: string }) {
    return (
      <div className="flex items-center gap-2 px-4 py-2">
        <Input
          autoFocus
          value={draftName}
          placeholder={level.example}
          disabled={busy}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void addUnit();
            if (event.key === "Escape") setAddingUnder(null);
          }}
          className="h-8 max-w-xs"
          aria-label={`New ${level.label}`}
        />
        <Button size="sm" onClick={addUnit} disabled={busy || draftName.trim().length === 0}>
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAddingUnder(null)} disabled={busy}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border" data-segment={segment}>
      {rows.length === 0 && addingUnder === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No {rootLevel.plural.toLowerCase()} yet.
        </p>
      ) : null}

      {rows.map((unit) => {
        const childLevel = levelFor(segment, unit.depth + 1);
        const siblings = siblingsOf(units, unit.parentId);
        const index = siblings.findIndex((sibling) => sibling.id === unit.id);
        const isDimmed = dimmed.has(unit.id);

        return (
          <div key={unit.id} className="border-b border-border last:border-0">
            <div
              className="flex items-center gap-2 py-2 pr-3"
              style={{ paddingLeft: `${16 + unit.depth * 20}px` }}
            >
              {renamingId === unit.id ? (
                <>
                  <Input
                    autoFocus
                    value={renameValue}
                    disabled={busy}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void rename(unit);
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                    className="h-8 max-w-xs"
                    aria-label={`Rename ${unit.name}`}
                  />
                  <Button
                    size="sm"
                    onClick={() => rename(unit)}
                    disabled={busy || renameValue.trim().length === 0}
                  >
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRenamingId(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <span
                    className={`text-sm ${isDimmed ? "text-muted-foreground line-through" : ""}`}
                  >
                    {unit.name}
                  </span>
                  <span className="text-xs text-muted-foreground">{unit.levelLabel}</span>
                  {isDimmed ? (
                    <Badge variant="outline" className="text-xs">
                      Inactive
                    </Badge>
                  ) : null}

                  <div className="ml-auto flex items-center gap-0.5">
                    {childLevel ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setDraftName("");
                          setAddingUnder(unit.id);
                        }}
                      >
                        <Plus className="size-3.5" />
                        {childLevel.label}
                      </Button>
                    ) : null}
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Move ${unit.name} up`}
                      disabled={busy || index <= 0}
                      onClick={() => move(unit, -1)}
                    >
                      <ChevronUp className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Move ${unit.name} down`}
                      disabled={busy || index < 0 || index >= siblings.length - 1}
                      onClick={() => move(unit, 1)}
                    >
                      <ChevronDown className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Rename ${unit.name}`}
                      disabled={busy}
                      onClick={() => {
                        setRenameValue(unit.name);
                        setRenamingId(unit.id);
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={unit.active ? `Hide ${unit.name}` : `Show ${unit.name}`}
                      disabled={busy}
                      onClick={() => toggleActive(unit)}
                    >
                      {unit.active ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      aria-label={`Delete ${unit.name}`}
                      disabled={busy}
                      onClick={() => setPendingDelete(unit)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </>
              )}
            </div>

            {addingUnder === unit.id && childLevel ? addRow(childLevel) : null}
          </div>
        );
      })}

      {addingUnder === "" ? (
        addRow(rootLevel)
      ) : (
        <div className="px-4 py-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setDraftName("");
              setAddingUnder("");
            }}
          >
            <Plus className="size-3.5" />
            Add {rootLevel.label.toLowerCase()}
          </Button>
        </div>
      )}

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>
              {descendantCount > 0
                ? `Delete ${pendingDelete?.name} and the ${descendantCount} unit${descendantCount === 1 ? "" : "s"} beneath it?`
                : `Delete ${pendingDelete?.name}?`}
            </DialogTitle>
            <DialogDescription>
              This cannot be undone. Anything published from it disappears from your public profile.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmDelete} disabled={busy}>
              {busy ? "Deleting…" : "Delete permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
