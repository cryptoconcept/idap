"use client";

import { useRouter } from "next/navigation";
import { useFieldArray, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createFeeStructureSchema, updateFeeStructureSchema } from "@/lib/validation/fee-structure";
import { FEE_FREQUENCIES, FEE_FREQUENCY_LABELS, type FeeFrequency } from "@/lib/constants";
import type { FeeStructureDTO } from "@/services/fee-structure.service";

type Values = z.input<typeof createFeeStructureSchema>;

/**
 * One form for both create and edit — unlike Results' three-section tabbed
 * editor (which exists because toppers need photo uploads requiring an
 * already-saved record), a fee structure's identity and line items have no
 * such dependency, so a single form covers both cases.
 */
export function FeeStructureForm({
  initialFeeStructure,
}: {
  /** `null` while creating — the same fields, saved by a POST instead of a PATCH. */
  initialFeeStructure: FeeStructureDTO | null;
}) {
  const router = useRouter();
  const isEditing = initialFeeStructure !== null;

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    // `updateFeeStructureSchema` types every identity field optional (a PATCH
    // may omit either), which is not assignable to `Resolver<Values>` where
    // `Values` — shared with the create schema so one form/one `Values` type
    // covers both cases — has them required. The cast is safe: whichever
    // schema is picked still runs the real validation for that mode at
    // submit time; only the static field-typing differs, and this form
    // always seeds both fields from `initialFeeStructure` when editing.
    resolver: zodResolver(
      isEditing ? updateFeeStructureSchema : createFeeStructureSchema,
    ) as Resolver<Values>,
    defaultValues: {
      classOrCourse: initialFeeStructure?.classOrCourse ?? "",
      academicYear: initialFeeStructure?.academicYear ?? "",
      lineItems: initialFeeStructure?.lineItems?.map((item) => ({
        label: item.label,
        amount: item.amount,
        frequency: item.frequency as FeeFrequency,
        optional: item.optional,
      })) ?? [],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "lineItems" });

  async function onSubmit(values: Values) {
    try {
      const response = await fetch(
        isEditing ? `/api/settings/fees/${initialFeeStructure.id}` : "/api/settings/fees",
        {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        },
      );
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not save. Please try again.");
        return;
      }

      toast.success(isEditing ? "Fee structure updated" : "Fee structure created");
      if (!isEditing) {
        router.push(`/fees/${payload.feeStructure.id}`);
      } else {
        router.refresh();
      }
    } catch {
      toast.error("Could not reach the server. Please try again.");
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="classOrCourse">Class or course</Label>
          <Input
            id="classOrCourse"
            placeholder="Grade 10"
            aria-invalid={Boolean(errors.classOrCourse)}
            {...register("classOrCourse")}
          />
          {errors.classOrCourse ? (
            <p className="text-xs text-destructive">{errors.classOrCourse.message}</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
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
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Line items</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => append({ label: "", amount: 0, frequency: "ANNUAL", optional: false })}
          >
            <Plus className="size-3.5" />
            Add line item
          </Button>
        </div>

        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">No line items yet.</p>
        ) : (
          <div className="space-y-3">
            {fields.map((field, index) => (
              <div
                key={field.id}
                className="grid items-end gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_140px_140px_auto_auto]"
              >
                <div className="space-y-1">
                  <Label htmlFor={`lineItems.${index}.label`} className="text-xs">
                    Label
                  </Label>
                  <Input
                    id={`lineItems.${index}.label`}
                    placeholder="Tuition"
                    {...register(`lineItems.${index}.label` as const)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`lineItems.${index}.amount`} className="text-xs">
                    Amount (₹)
                  </Label>
                  <Input
                    id={`lineItems.${index}.amount`}
                    type="number"
                    min={0}
                    {...register(`lineItems.${index}.amount` as const, { valueAsNumber: true })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`lineItems.${index}.frequency`} className="text-xs">
                    Frequency
                  </Label>
                  {/*
                   * A plain `onValueChange` calling `setValue` directly, not
                   * routing through `register()` — matching how
                   * `create-staff-dialog.tsx` wires its `role` Select into
                   * this same form library, the established convention here
                   * for a Radix `Select` (which is not a native input and has
                   * no `onChange` DOM event for `register()`'s handler to
                   * attach to).
                   */}
                  <Select
                    value={watch(`lineItems.${index}.frequency` as const)}
                    onValueChange={(value) =>
                      setValue(`lineItems.${index}.frequency` as const, value as FeeFrequency, {
                        shouldDirty: true,
                      })
                    }
                  >
                    <SelectTrigger id={`lineItems.${index}.frequency`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FEE_FREQUENCIES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {FEE_FREQUENCY_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-1.5 pb-2">
                  {/*
                   * `Checkbox` (src/components/ui/checkbox.tsx) wraps Radix's
                   * `Checkbox.Root` — a `button`, not a native checkbox input.
                   * It only exposes `checked`/`onCheckedChange`, the same
                   * controlled pair `api-keys-panel.tsx` drives it with
                   * elsewhere in this codebase; spreading `register()` here
                   * would attach an `onChange` the component never calls, so
                   * it is wired the same controlled way as the `Select`
                   * above instead.
                   */}
                  <Checkbox
                    id={`lineItems.${index}.optional`}
                    checked={Boolean(watch(`lineItems.${index}.optional` as const))}
                    onCheckedChange={(checked) =>
                      setValue(`lineItems.${index}.optional` as const, checked === true, {
                        shouldDirty: true,
                      })
                    }
                  />
                  <Label htmlFor={`lineItems.${index}.optional`} className="text-xs font-normal">
                    Optional
                  </Label>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => remove(index)}
                  aria-label="Remove line item"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {errors.lineItems ? (
          <p className="text-xs text-destructive">{errors.lineItems.message as string}</p>
        ) : null}
      </div>

      <Button type="submit" size="sm" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : isEditing ? "Save changes" : "Create fee structure"}
      </Button>
    </form>
  );
}
