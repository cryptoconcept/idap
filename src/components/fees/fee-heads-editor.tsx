"use client";

import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
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
import { FEE_FREQUENCIES, FEE_FREQUENCY_LABELS } from "@/lib/constants";
import type { FeeHeadDTO } from "@/services/fee-structure.service";
import {
  NO_FREQUENCY,
  feeHeadsFormSchema,
  toFormValues,
  type FeeHeadsFormValues,
  type FrequencyChoice,
} from "@/lib/fee-structure/fee-head-form";
import type { FeeHeadsInput } from "@/lib/validation/fee-structure";
import type { Resolver } from "react-hook-form";

export function FeeHeadsEditor({ initialFeeHeads }: { initialFeeHeads: FeeHeadDTO[] }) {
  const router = useRouter();

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
    // Three generics, not one: the form HOLDS `FeeHeadsFormValues` (sentinel and
    // all) but `handleSubmit` receives the resolver's PARSED output, which is
    // already `FeeHeadsInput`. Typing only the first generic would make
    // `onSubmit`'s parameter a lie and leave the second normalisation below
    // looking load-bearing when it is really a no-op.
  } = useForm<FeeHeadsFormValues, unknown, FeeHeadsInput>({
    resolver: zodResolver(feeHeadsFormSchema) as unknown as Resolver<
      FeeHeadsFormValues,
      unknown,
      FeeHeadsInput
    >,
    defaultValues: toFormValues(initialFeeHeads),
  });

  const { fields, append, remove } = useFieldArray({ control, name: "feeHeads" });

  // Already normalised by the resolver — the sentinel resolved, blank amounts
  // dropped, labels trimmed. Normalising again here would be a second, silent
  // transform that no test covers.
  async function onSubmit(payload: FeeHeadsInput) {
    try {
      const response = await fetch("/api/settings/fees/heads", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        toast.error(data?.error?.message ?? "Could not save. Please try again.");
        return;
      }

      toast.success("Fee heads saved");
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Fee heads</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => append({ label: "", amount: undefined, frequency: NO_FREQUENCY })}
          >
            <Plus className="size-3.5" />
            Add fee head
          </Button>
        </div>

        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">No fee heads yet.</p>
        ) : (
          <div className="space-y-3">
            {fields.map((field, index) => (
              <div
                key={field.id}
                className="grid items-end gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_140px_140px_auto]"
              >
                <div className="space-y-1">
                  <Label htmlFor={`feeHeads.${index}.label`} className="text-xs">
                    Label
                  </Label>
                  <Input
                    id={`feeHeads.${index}.label`}
                    placeholder="Tuition"
                    aria-invalid={Boolean(errors.feeHeads?.[index]?.label)}
                    {...register(`feeHeads.${index}.label` as const)}
                  />
                  {errors.feeHeads?.[index]?.label ? (
                    <p className="text-xs text-destructive">
                      {errors.feeHeads[index]?.label?.message}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`feeHeads.${index}.amount`} className="text-xs">
                    Amount (₹)
                  </Label>
                  <Input
                    id={`feeHeads.${index}.amount`}
                    type="number"
                    min={0}
                    aria-invalid={Boolean(errors.feeHeads?.[index]?.amount)}
                    {...register(`feeHeads.${index}.amount` as const, { valueAsNumber: true })}
                  />
                  {errors.feeHeads?.[index]?.amount ? (
                    <p className="text-xs text-destructive">
                      {errors.feeHeads[index]?.amount?.message}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`feeHeads.${index}.frequency`} className="text-xs">
                    Frequency
                  </Label>
                  <Select
                    value={watch(`feeHeads.${index}.frequency` as const)}
                    onValueChange={(value) =>
                      setValue(`feeHeads.${index}.frequency` as const, value as FrequencyChoice, {
                        shouldDirty: true,
                      })
                    }
                  >
                    <SelectTrigger id={`feeHeads.${index}.frequency`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_FREQUENCY}>No default</SelectItem>
                      {FEE_FREQUENCIES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {FEE_FREQUENCY_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => remove(index)}
                  aria-label="Remove fee head"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {typeof errors.feeHeads?.message === "string" ? (
          <p className="text-xs text-destructive">{errors.feeHeads.message}</p>
        ) : null}
      </div>

      <Button type="submit" size="sm" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
