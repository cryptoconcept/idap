"use client";

import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { Plus, X } from "lucide-react";
import { updateResultSchema } from "@/lib/validation/result";
import {
  RECRUITER_CATEGORIES,
  RECRUITER_CATEGORY_LABELS,
  RESULT_MAX_RECRUITERS,
  type RecruiterCategory,
} from "@/lib/constants";
import { Button } from "@/components/ui/button";
import {
  FieldGroup,
  FieldRow,
  reportSectionErrors,
  SectionForm,
  SelectField,
  TextField,
} from "@/components/profile/section-form";
import type { ResultSectionProps } from "@/components/results/result-editor";

type Values = z.input<typeof updateResultSchema>;
type Parsed = z.output<typeof updateResultSchema>;

const asNumber = (value: unknown) =>
  value === "" || value === null || value === undefined ? undefined : Number(value);

/**
 * Recruiters replace wholesale on save, unlike toppers — nothing on a
 * recruiter is server-written (no logo in this phase, see the design spec's
 * §4.3), so there is no identity to lose by treating the array the same way
 * `bands` already is.
 */
export function PlacementSection({ result, onSave, onDirtyChange }: ResultSectionProps) {
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(updateResultSchema),
    defaultValues: {
      placement: {
        eligible: result.placement?.eligible,
        placed: result.placement?.placed,
        highestPackage: result.placement?.highestPackage,
        averagePackage: result.placement?.averagePackage,
        recruiters: (result.placement?.recruiters ?? []).map((recruiter) => ({
          name: recruiter.name,
          category: recruiter.category as RecruiterCategory | undefined,
          selected: recruiter.selected,
          averagePackage: recruiter.averagePackage,
          tieUp: recruiter.tieUp,
          roles: recruiter.roles ?? [],
        })),
      },
    },
  });

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const recruiters = useWatch({ control, name: "placement.recruiters" }) ?? [];

  async function onSubmit(values: Parsed) {
    if (await onSave(values as Record<string, unknown>)) reset(values as Values);
  }

  return (
    <SectionForm
      title="Placement"
      description="Recruitment outcomes for this cycle — engineering, medical, management or degree colleges."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup>
        <FieldRow>
          <TextField
            id="placement-eligible"
            label="Eligible"
            type="number"
            inputMode="numeric"
            hint="Optional."
            error={errors.placement?.eligible?.message}
            {...register("placement.eligible", { setValueAs: asNumber })}
          />
          <TextField
            id="placement-placed"
            label="Placed"
            type="number"
            inputMode="numeric"
            hint="Optional."
            error={errors.placement?.placed?.message}
            {...register("placement.placed", { setValueAs: asNumber })}
          />
          <TextField
            id="placement-highestPackage"
            label="Highest package (₹ LPA)"
            type="number"
            step="any"
            inputMode="decimal"
            hint="Optional."
            error={errors.placement?.highestPackage?.message}
            {...register("placement.highestPackage", { setValueAs: asNumber })}
          />
          <TextField
            id="placement-averagePackage"
            label="Average package (₹ LPA)"
            type="number"
            step="any"
            inputMode="decimal"
            hint="Optional."
            error={errors.placement?.averagePackage?.message}
            {...register("placement.averagePackage", { setValueAs: asNumber })}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup title="Recruiters" description="The companies that hired from this cohort.">
        {recruiters.length === 0 ? (
          <p className="text-xs text-muted-foreground">No recruiters listed yet.</p>
        ) : (
          <ul className="space-y-3">
            {recruiters.map((_recruiter, index) => (
              <li key={index} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="eyebrow">Recruiter {index + 1}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove recruiter ${index + 1}`}
                    onClick={() =>
                      setValue(
                        "placement.recruiters",
                        recruiters.filter((_, i) => i !== index),
                        { shouldDirty: true },
                      )
                    }
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_90px_90px]">
                  <TextField
                    id={`recruiter-${index}-name`}
                    label="Name"
                    maxLength={120}
                    error={errors.placement?.recruiters?.[index]?.name?.message}
                    {...register(`placement.recruiters.${index}.name`)}
                  />
                  <SelectField
                    id={`recruiter-${index}-category`}
                    label="Category"
                    value={watch(`placement.recruiters.${index}.category`) ?? ""}
                    onChange={(value) =>
                      setValue(
                        `placement.recruiters.${index}.category`,
                        value as RecruiterCategory | undefined,
                        { shouldDirty: true },
                      )
                    }
                    options={RECRUITER_CATEGORIES.map((code) => ({
                      value: code,
                      label: RECRUITER_CATEGORY_LABELS[code],
                    }))}
                    placeholder="Optional"
                  />
                  <TextField
                    id={`recruiter-${index}-selected`}
                    label="Selected"
                    type="number"
                    inputMode="numeric"
                    error={errors.placement?.recruiters?.[index]?.selected?.message}
                    {...register(`placement.recruiters.${index}.selected`, { setValueAs: asNumber })}
                  />
                  <TextField
                    id={`recruiter-${index}-averagePackage`}
                    label="Package (₹ LPA)"
                    type="number"
                    step="any"
                    inputMode="decimal"
                    error={errors.placement?.recruiters?.[index]?.averagePackage?.message}
                    {...register(`placement.recruiters.${index}.averagePackage`, {
                      setValueAs: asNumber,
                    })}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    {...register(`placement.recruiters.${index}.tieUp`)}
                  />
                  <span>Active MoU / guaranteed campus drive</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={recruiters.length >= RESULT_MAX_RECRUITERS}
          onClick={() =>
            setValue(
              "placement.recruiters",
              [...recruiters, { name: "", tieUp: false }],
              { shouldDirty: true },
            )
          }
        >
          <Plus className="size-3.5" />
          Add recruiter
        </Button>

        {typeof errors.placement?.recruiters?.message === "string" ? (
          <p role="alert" className="text-xs text-foreground">
            {errors.placement.recruiters.message}
          </p>
        ) : null}
      </FieldGroup>
    </SectionForm>
  );
}
