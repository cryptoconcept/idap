"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { SegmentSelector } from "@/components/academic/segment-selector";
import { UnitTree } from "@/components/academic/unit-tree";
import { ACADEMIC_BLUEPRINTS } from "@/lib/academic/blueprints";
import { ACADEMIC_SEGMENT_LABELS, type AcademicSegment } from "@/lib/constants";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";

export function AcademicStructureView({
  segments,
  units,
  canSeed,
}: {
  segments: AcademicSegment[];
  units: AcademicUnitDTO[];
  /** True only while the tree is empty and the profile still holds typed offerings. */
  canSeed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const refresh = () => router.refresh();

  async function seed() {
    setBusy(true);
    try {
      const response = await fetch("/api/settings/academic-structure/seed", { method: "POST" });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not import. Please try again.");
        return;
      }
      toast.success(
        payload.skipped > 0
          ? `Imported ${payload.created}, skipped ${payload.skipped}`
          : `Imported ${payload.created}`,
      );
      refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const usedSegments = new Set(units.map((unit) => unit.segment));

  return (
    <>
      <PageHeader
        title="Academic Structure"
        description="What you teach, in the shape your kind of institution actually has. Your public profile reads from this."
        actions={
          canSeed ? (
            <Button size="sm" variant="outline" onClick={seed} disabled={busy}>
              <Download className="size-3.5" />
              {busy ? "Importing…" : "Import from profile"}
            </Button>
          ) : null
        }
      />

      <div className="space-y-6">
        <SegmentSelector selected={segments} usedSegments={usedSegments} onSaved={refresh} />

        {segments.map((segment) => (
          <section key={segment} className="space-y-2">
            <div>
              <h2 className="text-sm font-medium">{ACADEMIC_SEGMENT_LABELS[segment]}</h2>
              {/* The tier names come from the blueprint, never from a conditional on institution type. */}
              <p className="text-xs text-muted-foreground">
                {ACADEMIC_BLUEPRINTS[segment].levels.map((level) => level.label).join(" → ")}
              </p>
            </div>
            <UnitTree
              segment={segment}
              units={units.filter((unit) => unit.segment === segment)}
              onChanged={refresh}
            />
          </section>
        ))}
      </div>
    </>
  );
}
