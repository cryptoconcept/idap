"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Layers, Plus, Tags, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { FeeStructureStatusBadge } from "@/components/fees/fee-structure-status-badge";
import type { FeeStructureDTO } from "@/services/fee-structure.service";
import type { FeeStructureStatus } from "@/lib/constants";

/**
 * Mirrors `BULK_MAX_IDS` in `src/lib/validation/fee-structure.ts`. That
 * constant isn't exported, so this is a second source of truth for the same
 * number — a fixed schema limit that's safe to duplicate — used only to keep
 * "select all" from selecting more than the API will ever accept.
 */
const BULK_DELETE_MAX = 100;

/** Quick-glance total: every ANNUAL line item summed. Not a stored field. */
function annualTotal(feeStructure: FeeStructureDTO): number {
  return (feeStructure.lineItems ?? [])
    .filter((item) => item.frequency === "ANNUAL")
    .reduce((sum, item) => sum + item.amount, 0);
}

export function FeeStructuresListView({ feeStructures }: { feeStructures: FeeStructureDTO[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const selectedIds = Array.from(selected);
  const selectedCount = selectedIds.length;
  const allSelected = feeStructures.length > 0 && selectedCount === feeStructures.length;
  const someSelected = selectedCount > 0 && !allSelected;
  const selectedPublishedCount = feeStructures.filter(
    (feeStructure) => selected.has(feeStructure.id) && feeStructure.status === "PUBLISHED",
  ).length;

  function toggleRow(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    if (!checked) {
      setSelected(new Set());
      return;
    }

    if (feeStructures.length > BULK_DELETE_MAX) {
      toast.info(
        `Only the first ${BULK_DELETE_MAX} were selected — bulk delete supports at most ${BULK_DELETE_MAX} at a time.`,
      );
      setSelected(new Set(feeStructures.slice(0, BULK_DELETE_MAX).map((feeStructure) => feeStructure.id)));
      return;
    }

    setSelected(new Set(feeStructures.map((feeStructure) => feeStructure.id)));
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      const response = await fetch("/api/settings/fees/bulk/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feeStructureIds: selectedIds }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not delete. Please try again.");
        setBusy(false);
        return;
      }

      toast.success(
        payload.deleted === 1 ? "1 fee structure deleted" : `${payload.deleted} fee structures deleted`,
      );
      // Clear the selection before refreshing: ids left in the Set after a
      // refresh point at rows that may no longer exist (or belong to a
      // different row now that the list has shifted), so a second click
      // would delete something the admin never chose — and since a foreign
      // id fails the whole batch, it would also just 404 and delete nothing.
      setSelected(new Set());
      setConfirmOpen(false);
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Fees"
        description="Class and course fee structures your website and partner sites read from the public API."
        actions={
          <div className="flex items-center gap-2">
            {selectedCount > 0 ? (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 className="size-3.5" />
                Delete selected ({selectedCount})
              </Button>
            ) : null}
            {/*
              Secondary to "Add a fee structure": configuring heads is preparation,
              creating a structure is the page's actual job. `variant="outline"`
              matches how `academic-structure-view.tsx` marks a secondary header action.
            */}
            <Button asChild size="sm" variant="outline">
              <Link href="/fees/heads">
                <Tags className="size-3.5" />
                Fee heads
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/fees/bulk">
                <Layers className="size-3.5" />
                Bulk add
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/fees/new">
                <Plus className="size-4" />
                Add a fee structure
              </Link>
            </Button>
          </div>
        }
      />

      {feeStructures.length === 0 ? (
        <EmptyState
          title="No fee structures yet"
          description="Publish a class or course's fees and any website reading your public API picks it up."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left">
              <tr>
                <th className="w-10 px-4 py-2">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                    aria-label="Select all fee structures"
                  />
                </th>
                <th className="px-4 py-2 font-medium">Class / course</th>
                <th className="px-4 py-2 font-medium">Academic year</th>
                <th className="px-4 py-2 font-medium">Annual total</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {feeStructures.map((feeStructure) => (
                <tr key={feeStructure.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Checkbox
                      checked={selected.has(feeStructure.id)}
                      onCheckedChange={(checked) => toggleRow(feeStructure.id, checked === true)}
                      aria-label={`Select ${feeStructure.classOrCourse}`}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <Link href={`/fees/${feeStructure.id}`} className="font-medium hover:underline">
                      {feeStructure.classOrCourse}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{feeStructure.academicYear}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    ₹{annualTotal(feeStructure).toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-2.5">
                    <FeeStructureStatusBadge status={feeStructure.status as FeeStructureStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={(open) => !open && setConfirmOpen(false)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>
              Delete {selectedCount === 1 ? "1 fee structure" : `${selectedCount} fee structures`}?
            </DialogTitle>
            <DialogDescription>
              This permanently removes {selectedCount === 1 ? "it" : "them"} and every line item.
              This cannot be undone.
              {selectedPublishedCount > 0
                ? ` ${selectedPublishedCount === selectedCount ? "All of these are" : `${selectedPublishedCount} of these are`} published and will disappear from the public API immediately.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmDelete} disabled={busy}>
              {busy ? "Deleting…" : "Delete permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
