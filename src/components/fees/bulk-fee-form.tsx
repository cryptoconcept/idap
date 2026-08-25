"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
// The same cap the API enforces, imported rather than mirrored: neither
// "select all" nor a hand-picked selection may build a request the server
// would reject.
import { bulkCreateFeeSchema, BULK_MAX_IDS } from "@/lib/validation/fee-structure";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";
import type { FeeHeadDTO } from "@/services/fee-structure.service";
import { FeeLineItemsEditor } from "@/components/fees/fee-line-items-editor";

type Values = z.input<typeof bulkCreateFeeSchema>;

/** What a successful bulk submission leaves behind, for the summary below the form. */
type Result = {
  created: number;
  skipped: { academicUnitId: string; classOrCourse: string }[];
};

export function BulkFeeForm({
  units,
  feeHeads,
}: {
  /**
   * Effectively-active units, already run through `flattenTree` and filtered by
   * the page — in tree order, each carrying the `depth` this component indents by.
   */
  units: AcademicUnitDTO[];
  /** The institution's configured fee heads, offered as a line-item prefill. */
  feeHeads: FeeHeadDTO[];
}) {
  const [result, setResult] = useState<Result | null>(null);

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(bulkCreateFeeSchema),
    defaultValues: {
      academicUnitIds: [],
      academicYear: "",
      lineItems: [],
    },
  });

  const selected = watch("academicUnitIds") ?? [];

  function toggleUnit(unitId: string, checked: boolean) {
    const current = new Set(selected);
    if (checked) {
      // Blocked at the moment it happens, not after the form is filled in and
      // submitted: a request over the cap can never succeed, so the 101st
      // tick is refused rather than silently building a doomed request.
      if (!current.has(unitId) && current.size >= BULK_MAX_IDS) {
        toast.info(`You can select at most ${BULK_MAX_IDS} at a time.`);
        return;
      }
      current.add(unitId);
    } else {
      current.delete(unitId);
    }
    setValue("academicUnitIds", Array.from(current), { shouldDirty: true });
  }

  function selectAll() {
    if (units.length > BULK_MAX_IDS) {
      toast.info(
        `Only the first ${BULK_MAX_IDS} were selected — bulk assignment supports at most ${BULK_MAX_IDS} at a time.`,
      );
      setValue(
        "academicUnitIds",
        units.slice(0, BULK_MAX_IDS).map((unit) => unit.id),
        { shouldDirty: true },
      );
      return;
    }
    setValue(
      "academicUnitIds",
      units.map((unit) => unit.id),
      { shouldDirty: true },
    );
  }

  function clearAll() {
    setValue("academicUnitIds", [], { shouldDirty: true });
  }

  async function onSubmit(values: Values) {
    setResult(null);
    try {
      const response = await fetch("/api/settings/fees/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not save. Please try again.");
        return;
      }

      const { created, skipped } = payload as Result;
      setResult({ created, skipped });
      // The toast is the first and often the only feedback read, so it carries the
      // same wording rule as the panel below: "created 0, skipped 3" is a bare zero
      // dressed as a result. Nothing was created because every class already had a
      // price — say that.
      toast.success(
        created === 0 && skipped.length > 0
          ? "Every selected class or course was already priced — nothing new was created"
          : skipped.length > 0
            ? `Created ${created}, skipped ${skipped.length} already priced`
            : `Created ${created}`,
      );

      // Clear the form on success. This screen deliberately stays put — there is no
      // single created resource to navigate to — so without this the previous
      // batch's units stay ticked, and the next submit silently includes them.
      reset({ academicUnitIds: [], academicYear: "", lineItems: [] });
    } catch {
      toast.error("Could not reach the server. Please try again.");
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>Classes and courses</Label>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={selectAll}>
              Select all
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={clearAll}>
              Clear
            </Button>
          </div>
        </div>
        <div className="max-h-80 space-y-0.5 overflow-y-auto rounded-md border border-border p-2">
          {units.map((unit) => (
            <label
              key={unit.id}
              className="flex items-center gap-2.5 rounded-sm py-1.5 pr-3 text-sm hover:bg-muted/40"
              style={{ paddingLeft: `${16 + unit.depth * 20}px` }}
            >
              <Checkbox
                checked={selected.includes(unit.id)}
                onCheckedChange={(checked) => toggleUnit(unit.id, checked === true)}
              />
              {unit.name}
            </label>
          ))}
        </div>
        {errors.academicUnitIds ? (
          <p className="text-xs text-destructive">{errors.academicUnitIds.message}</p>
        ) : null}
      </div>

      <div className="space-y-1.5 sm:max-w-xs">
        <Label htmlFor="academicYear">Academic year</Label>
        <Input
          id="academicYear"
          placeholder="2026-27"
          aria-invalid={Boolean(errors.academicYear)}
          {...register("academicYear")}
        />
        {errors.academicYear ? (
          <p className="text-xs text-destructive">{errors.academicYear.message}</p>
        ) : null}
      </div>

      <FeeLineItemsEditor
        control={control}
        register={register}
        watch={watch}
        setValue={setValue}
        errors={errors}
        feeHeads={feeHeads}
      />

      <Button type="submit" size="sm" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Create fee structures"}
      </Button>

      {result ? (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm">
          {result.skipped.length === 0 ? (
            <p>Created {result.created}.</p>
          ) : result.created === 0 ? (
            <p>
              Every selected class or course was already priced for this academic year — nothing
              new was created.
            </p>
          ) : (
            <p>
              Created {result.created}, skipped {result.skipped.length} already priced for this
              academic year.
            </p>
          )}
          {result.skipped.length > 0 ? (
            <ul className="list-inside list-disc text-muted-foreground">
              {result.skipped.map((skip) => (
                <li key={skip.academicUnitId}>{skip.classOrCourse}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
