"use client";

import {
  useFieldArray,
  type ArrayPath,
  type Control,
  type FieldArray,
  type FieldErrors,
  type FieldValues,
  type Path,
  type UseFormRegister,
  type UseFormSetValue,
  type UseFormWatch,
} from "react-hook-form";
import { Plus, Tags, Trash2 } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FEE_FREQUENCIES, FEE_FREQUENCY_LABELS } from "@/lib/constants";
import type { FeeHeadDTO } from "@/services/fee-structure.service";

/** Shape common to a line item's errors, regardless of which concrete form holds it. */
type LineItemErrors = {
  label?: { message?: string };
  amount?: { message?: string };
};

/**
 * `FieldErrors<T>` cannot know `T` has a `lineItems` array — this component only
 * knows `T extends FieldValues` — so reading a row's errors needs one narrowing
 * step. Confined to this helper and narrowed to a real shape rather than `any`,
 * so the JSX below never repeats the cast.
 */
function rowErrors<T extends FieldValues>(
  errors: FieldErrors<T>,
  index: number,
): LineItemErrors | undefined {
  const list = (errors as { lineItems?: LineItemErrors[] }).lineItems;
  return list?.[index];
}

/** A blank row, for both the plain "Add line item" button and each fee head. */
function rowFrom(head?: FeeHeadDTO) {
  return {
    label: head?.label ?? "",
    // A head with no default leaves the amount at 0 for the admin to fill;
    // picking one is a shortcut, never a mode.
    amount: head?.amount ?? 0,
    frequency: head?.frequency ?? "ANNUAL",
    optional: false,
  };
}

/**
 * The line-items block shared by the single fee-structure form and Task 8's
 * bulk-assign form. Generic over `T` because the two forms' value shapes
 * differ outside `lineItems` — `academicUnitId: string` here vs.
 * `academicUnitIds: string[]` there — but agree on `lineItems` at the same
 * path, which is all this component touches.
 */
export function FeeLineItemsEditor<T extends FieldValues>({
  control,
  register,
  watch,
  setValue,
  errors,
  feeHeads,
}: {
  control: Control<T>;
  register: UseFormRegister<T>;
  watch: UseFormWatch<T>;
  setValue: UseFormSetValue<T>;
  errors: FieldErrors<T>;
  /** Empty means the institution has configured none; the prefill control is then absent. */
  feeHeads: FeeHeadDTO[];
}) {
  const { fields, append, remove } = useFieldArray<T>({
    control,
    name: "lineItems" as ArrayPath<T>,
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Line items</Label>
        <div className="flex items-center gap-2">
          {feeHeads.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" variant="outline">
                  <Tags className="size-3.5" />
                  Add from fee head
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {feeHeads.map((head) => (
                  <DropdownMenuItem
                    key={head.label}
                    onSelect={() => append(rowFrom(head) as FieldArray<T, ArrayPath<T>>)}
                  >
                    {head.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => append(rowFrom() as FieldArray<T, ArrayPath<T>>)}
          >
            <Plus className="size-3.5" />
            Add line item
          </Button>
        </div>
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
                  aria-invalid={Boolean(rowErrors(errors, index)?.label)}
                  {...register(`lineItems.${index}.label` as Path<T>)}
                />
                {rowErrors(errors, index)?.label ? (
                  <p className="text-xs text-destructive">
                    {rowErrors(errors, index)?.label?.message}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor={`lineItems.${index}.amount`} className="text-xs">
                  Amount (₹)
                </Label>
                <Input
                  id={`lineItems.${index}.amount`}
                  type="number"
                  min={0}
                  aria-invalid={Boolean(rowErrors(errors, index)?.amount)}
                  {...register(`lineItems.${index}.amount` as Path<T>, { valueAsNumber: true })}
                />
                {rowErrors(errors, index)?.amount ? (
                  <p className="text-xs text-destructive">
                    {rowErrors(errors, index)?.amount?.message}
                  </p>
                ) : null}
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
                  value={String(watch(`lineItems.${index}.frequency` as Path<T>) ?? "")}
                  onValueChange={(value) =>
                    setValue(`lineItems.${index}.frequency` as Path<T>, value as never, {
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
                  checked={Boolean(watch(`lineItems.${index}.optional` as Path<T>))}
                  onCheckedChange={(checked) =>
                    setValue(`lineItems.${index}.optional` as Path<T>, (checked === true) as never, {
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
      {typeof errors.lineItems?.message === "string" ? (
        <p className="text-xs text-destructive">{errors.lineItems.message}</p>
      ) : null}
    </div>
  );
}
