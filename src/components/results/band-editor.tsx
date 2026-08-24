"use client";

import {
  useFieldArray,
  useWatch,
  type Control,
  type FieldErrors,
  type UseFormRegister,
} from "react-hook-form";
import { Plus, X } from "lucide-react";
import type { z } from "zod";
import { updateResultSchema } from "@/lib/validation/result";
import { RESULT_MAX_BANDS } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { FieldGroup, TextField } from "@/components/profile/section-form";

type Values = z.input<typeof updateResultSchema>;
type Parsed = z.output<typeof updateResultSchema>;

/** An empty number input must stay absent — the schema takes a number, not NaN. */
const asNumber = (value: unknown) =>
  value === "" || value === null || value === undefined ? undefined : Number(value);

/**
 * The bands a school would draw itself, seeded so the common case needs no
 * typing. Only used when a cycle has none — an existing set is never replaced.
 */
export const DEFAULT_BANDS = [
  { label: "90% and above", minPercentage: 90, maxPercentage: 100, count: 0 },
  { label: "75% to 89%", minPercentage: 75, maxPercentage: 89, count: 0 },
  { label: "60% to 74%", minPercentage: 60, maxPercentage: 74, count: 0 },
];

/**
 * The score bands, edited inside the outcome section's own form — it is one
 * field of that section, not a section of its own, so it borrows the parent's
 * `control` rather than opening a second form instance.
 */
export function BandEditor({
  control,
  register,
  errors,
  appeared,
}: {
  control: Control<Values, unknown, Parsed>;
  register: UseFormRegister<Values>;
  errors: FieldErrors<Values>;
  appeared: number;
}) {
  const { fields, append, remove } = useFieldArray({ control, name: "bands" });

  // Read live rather than from `fields`, whose values are frozen at render.
  const bands = useWatch({ control, name: "bands" });
  const counted = (bands ?? []).reduce((total, band) => total + (Number(band?.count) || 0), 0);

  return (
    <FieldGroup
      title="Score bands"
      description="How the cohort spread out. Bands may not overlap, and together they cannot hold more students than appeared."
    >
      {fields.length === 0 ? (
        <p className="text-xs text-muted-foreground">No bands yet.</p>
      ) : (
        <ul className="space-y-3">
          {fields.map((entry, index) => (
            <li key={entry.id} className="flex items-end gap-2">
              <div className="grid flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_90px_90px_90px]">
                <TextField
                  id={`bands-label-${index}`}
                  label="Band"
                  placeholder="90% and above"
                  maxLength={40}
                  error={errors.bands?.[index]?.label?.message}
                  {...register(`bands.${index}.label`)}
                />
                <TextField
                  id={`bands-min-${index}`}
                  label="From %"
                  type="number"
                  step="any"
                  inputMode="decimal"
                  error={errors.bands?.[index]?.minPercentage?.message}
                  {...register(`bands.${index}.minPercentage`, { setValueAs: asNumber })}
                />
                <TextField
                  id={`bands-max-${index}`}
                  label="To %"
                  type="number"
                  step="any"
                  inputMode="decimal"
                  error={errors.bands?.[index]?.maxPercentage?.message}
                  {...register(`bands.${index}.maxPercentage`, { setValueAs: asNumber })}
                />
                <TextField
                  id={`bands-count-${index}`}
                  label="Students"
                  type="number"
                  inputMode="numeric"
                  error={errors.bands?.[index]?.count?.message}
                  {...register(`bands.${index}.count`, { setValueAs: asNumber })}
                />
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="mb-1.5"
                aria-label={`Remove band ${index + 1}`}
                onClick={() => remove(index)}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fields.length >= RESULT_MAX_BANDS}
          onClick={() => append({ label: "", minPercentage: 0, maxPercentage: 100, count: 0 })}
        >
          <Plus className="size-3.5" />
          Add band
        </Button>
        <p className="text-xs text-muted-foreground">
          {counted > appeared
            ? `These bands account for ${counted} students, more than the ${appeared} who appeared.`
            : `${counted} of ${appeared} students placed in a band.`}
        </p>
      </div>
    </FieldGroup>
  );
}
