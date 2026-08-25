"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ACADEMIC_SEGMENTS, ACADEMIC_SEGMENT_LABELS, type AcademicSegment } from "@/lib/constants";

/**
 * `Checkbox` wraps Radix's `Checkbox.Root` — a button, not a native input —
 * so it is driven by the controlled `checked`/`onCheckedChange` pair, the same
 * way `api-keys-panel.tsx` and the fee structure form drive it.
 */
export function SegmentSelector({
  selected,
  usedSegments,
  onSaved,
}: {
  selected: AcademicSegment[];
  /** Segments holding at least one unit. The server refuses to drop these. */
  usedSegments: Set<string>;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle(segment: AcademicSegment, checked: boolean) {
    const next = checked ? [...selected, segment] : selected.filter((value) => value !== segment);
    if (next.length === 0) {
      toast.error("Keep at least one segment selected.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/settings/academic-structure/segments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: next }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not save. Please try again.");
        return;
      }
      toast.success("Segments updated");
      onSaved();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-medium">What this institution runs</h2>
        <p className="text-xs text-muted-foreground">
          Pick every segment you offer. A school with a PU college attached picks both.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {ACADEMIC_SEGMENTS.map((segment) => {
          const isSelected = selected.includes(segment);
          // A segment holding units cannot be unticked — the server refuses it,
          // so the box is disabled with the reason rather than left to fail.
          const locked = isSelected && usedSegments.has(segment);
          return (
            <div key={segment} className="flex items-center gap-2">
              <Checkbox
                id={`segment-${segment}`}
                checked={isSelected}
                disabled={busy || locked}
                onCheckedChange={(checked) => toggle(segment, checked === true)}
              />
              <Label
                htmlFor={`segment-${segment}`}
                className="text-sm font-normal"
                title={locked ? "Delete its units before deselecting this segment." : undefined}
              >
                {ACADEMIC_SEGMENT_LABELS[segment]}
              </Label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
