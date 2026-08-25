"use client";

import { useRouter } from "next/navigation";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createFeeStructureSchema, updateFeeStructureSchema } from "@/lib/validation/fee-structure";
import type { FeeFrequency } from "@/lib/constants";
import type { FeeStructureDTO, FeeHeadDTO } from "@/services/fee-structure.service";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";
import { FeeLineItemsEditor } from "@/components/fees/fee-line-items-editor";

type Values = z.input<typeof createFeeStructureSchema>;

/**
 * One form for both create and edit — unlike Results' three-section tabbed
 * editor (which exists because toppers need photo uploads requiring an
 * already-saved record), a fee structure's identity and line items have no
 * such dependency, so a single form covers both cases.
 */
export function FeeStructureForm({
  initialFeeStructure,
  units,
  feeHeads,
}: {
  /** `null` while creating — the same fields, saved by a POST instead of a PATCH. */
  initialFeeStructure: FeeStructureDTO | null;
  /**
   * Effectively-active units to offer while creating. Empty and unused while
   * editing — the unit is shown as read-only text there instead.
   */
  units: AcademicUnitDTO[];
  /** The institution's configured fee heads, offered as a line-item prefill. */
  feeHeads: FeeHeadDTO[];
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
    // `updateFeeStructureSchema` types `academicYear` optional and omits
    // `academicUnitId` altogether (a PATCH cannot move a fee structure between
    // units), neither of which is assignable to `Resolver<Values>` where
    // `Values` — shared with the create schema so one form/one `Values` type
    // covers both cases — has both required. The double cast is safe:
    // whichever schema is picked still runs the real validation for that mode
    // at submit time; only the static field-typing differs, and this form
    // always seeds both fields from `initialFeeStructure` when editing.
    resolver: zodResolver(
      isEditing ? updateFeeStructureSchema : createFeeStructureSchema,
    ) as unknown as Resolver<Values>,
    defaultValues: {
      academicUnitId: initialFeeStructure?.academicUnitId ?? "",
      academicYear: initialFeeStructure?.academicYear ?? "",
      lineItems: initialFeeStructure?.lineItems?.map((item) => ({
        label: item.label,
        amount: item.amount,
        frequency: item.frequency as FeeFrequency,
        optional: item.optional,
      })) ?? [],
    },
  });

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
          <Label htmlFor="academicUnitId">Class or course</Label>
          {isEditing ? (
            <>
              <p className="pt-1.5 text-sm">{initialFeeStructure.classOrCourse}</p>
              {/*
                Not editable: moving a fee structure to another unit would carry its
                unique key with it, so the API strips the field. Delete and recreate
                instead — an input that looks editable but is not would be worse.
              */}
              <p className="text-xs text-muted-foreground">
                To price a different class or course, create a new fee structure.
              </p>
            </>
          ) : (
            <>
              {/*
                A Radix Select is a button, not a native input, so it is driven by
                watch/setValue rather than register() — the same way
                `create-staff-dialog.tsx` and `fee-line-items-editor.tsx`'s
                frequency Select do.
              */}
              <Select
                value={watch("academicUnitId")}
                onValueChange={(value) =>
                  setValue("academicUnitId", value, { shouldDirty: true })
                }
              >
                <SelectTrigger id="academicUnitId" aria-invalid={Boolean(errors.academicUnitId)}>
                  <SelectValue placeholder="Pick a class or course" />
                </SelectTrigger>
                <SelectContent>
                  {units.map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.pathLabel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.academicUnitId ? (
                <p className="text-xs text-destructive">{errors.academicUnitId.message}</p>
              ) : null}
            </>
          )}
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

      <FeeLineItemsEditor
        control={control}
        register={register}
        watch={watch}
        setValue={setValue}
        errors={errors}
        feeHeads={feeHeads}
      />

      <Button type="submit" size="sm" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : isEditing ? "Save changes" : "Create fee structure"}
      </Button>
    </form>
  );
}
