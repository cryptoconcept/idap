"use client";

import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { updateResultSchema } from "@/lib/validation/result";
import { BandEditor, DEFAULT_BANDS } from "@/components/results/band-editor";
import {
  FieldGroup,
  FieldRow,
  reportSectionErrors,
  SectionForm,
  TextField,
} from "@/components/profile/section-form";
import type { ResultSectionProps } from "@/components/results/result-editor";

type Values = z.input<typeof updateResultSchema>;
type Parsed = z.output<typeof updateResultSchema>;

/** An empty number input must stay absent — the schema takes a number, not NaN. */
const asNumber = (value: unknown) =>
  value === "" || value === null || value === undefined ? undefined : Number(value);

/** The cohort's numbers: how many sat, how many passed, and how they spread out. */
export function OutcomeSection({ result, onSave, onDirtyChange }: ResultSectionProps) {
  const {
    register,
    control,
    handleSubmit,
    getValues,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(updateResultSchema),
    defaultValues: {
      appeared: result.appeared,
      passed: result.passed,
      averageScore: result.averageScore,
      highestScore: result.highestScore,
      // Seeded only when the cycle has none of its own; an existing set stands.
      bands: result.bands ?? DEFAULT_BANDS,
    },
  });

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  // `useWatch` rather than `watch`: it is the subscription form, and the one
  // the compiler can memoize.
  const appeared = Number(useWatch({ control, name: "appeared" })) || 0;
  const passed = Number(useWatch({ control, name: "passed" })) || 0;

  async function onSubmit(values: Parsed) {
    if (await onSave(values as Record<string, unknown>)) reset(getValues());
  }

  return (
    <SectionForm
      title="Outcome"
      description="The numbers the public API publishes for this cycle. The pass rate is derived, never typed."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup>
        <FieldRow>
          <TextField
            id="outcome-appeared"
            label="Students appeared"
            type="number"
            inputMode="numeric"
            placeholder="142"
            error={errors.appeared?.message}
            {...register("appeared", { setValueAs: asNumber })}
          />
          <TextField
            id="outcome-passed"
            label="Students passed"
            type="number"
            inputMode="numeric"
            placeholder="140"
            error={errors.passed?.message}
            {...register("passed", { setValueAs: asNumber })}
          />
          <TextField
            id="outcome-averageScore"
            label="Average score %"
            type="number"
            step="any"
            inputMode="decimal"
            hint="Optional."
            error={errors.averageScore?.message}
            {...register("averageScore", { setValueAs: asNumber })}
          />
          <TextField
            id="outcome-highestScore"
            label="Highest score %"
            type="number"
            step="any"
            inputMode="decimal"
            hint="Optional."
            error={errors.highestScore?.message}
            {...register("highestScore", { setValueAs: asNumber })}
          />
        </FieldRow>
      </FieldGroup>

      <BandEditor control={control} register={register} errors={errors} appeared={appeared} />

      <p className="text-xs text-muted-foreground">
        {appeared > 0
          ? `Pass rate: ${Math.round((passed / appeared) * 1000) / 10}%`
          : "Enter how many appeared to see the pass rate."}
      </p>
    </SectionForm>
  );
}
