"use client";

import { useEffect } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, X } from "lucide-react";
import type { z } from "zod";
import { updateResultSchema } from "@/lib/validation/result";
import { RESULT_MAX_TOPPERS } from "@/lib/constants";
import type { ResultDTO } from "@/services/result.service";
import { Button } from "@/components/ui/button";
import {
  FieldGroup,
  reportSectionErrors,
  SectionForm,
  TextField,
} from "@/components/profile/section-form";
import { TopperPhoto } from "@/components/results/topper-photo";
import type { ResultSectionProps } from "@/components/results/result-editor";

type Values = z.input<typeof updateResultSchema>;
type Parsed = z.output<typeof updateResultSchema>;
type Topper = NonNullable<ResultDTO["toppers"]>[number];

/** An empty number input must stay absent — the schema takes a number, not NaN. */
const asNumber = (value: unknown) =>
  value === "" || value === null || value === undefined ? undefined : Number(value);

/**
 * One saved topper as this form holds it — used both for the initial values and
 * for the baseline after a save, so the two cannot drift. The `id` is the part
 * that matters: a row whose id is missing reads as a new topper on the next
 * patch, and the server would mint it a fresh one and drop its photograph.
 */
const toFormRow = (topper: Topper) => ({
  id: topper.id,
  name: topper.name,
  percentage: topper.percentage,
  rank: topper.rank,
  note: topper.note ?? "",
  consentAcknowledged: topper.consentAcknowledged,
});

/**
 * The students named on the public API — and the only place consent is
 * recorded. A topper whose consent is not ticked blocks publication, and
 * unticking it after publication takes that topper off the API on the next
 * read without the cycle itself coming down.
 */
export function ToppersSection({
  result,
  onSave,
  onDirtyChange,
  onResult,
}: ResultSectionProps) {
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(updateResultSchema),
    defaultValues: { toppers: (result.toppers ?? []).map(toFormRow) },
  });

  // `keyName` moved off its `id` default: the rendered rows are built as
  // `{ ...row, [keyName]: generatedKey }`, which would overwrite the server id
  // this section has to send back with React's throwaway key.
  const { fields, append, remove } = useFieldArray({
    control,
    name: "toppers",
    keyName: "_key",
  });

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  async function onSubmit(values: Parsed) {
    const next = await onSave(values as Record<string, unknown>);
    // Re-baselined from the SERVER's toppers, not from what was just submitted
    // — unlike the other sections, which have no server-minted identity to
    // learn. A row added in this session had no id to send; the server has just
    // minted one, and a form still holding "" would read as a new topper on the
    // very next save, taking the photograph uploaded to it in between.
    if (next) reset({ toppers: (next.toppers ?? []).map(toFormRow) });
  }

  return (
    <SectionForm
      title="Toppers"
      description="Names, scores and photographs. Nothing here is published without the consent tick beside it."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup>
        {fields.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No toppers listed yet. A cycle can be published without any.
          </p>
        ) : (
          <ul className="space-y-3">
            {fields.map((entry, index) => {
              // Only trustworthy while the form matches the server: an unsaved
              // add or remove shifts the rows out of step with the stored ids.
              const saved: Topper | undefined = isDirty ? undefined : result.toppers?.[index];

              return (
                <li key={entry._key} className="space-y-3 rounded-lg border border-border p-3">
                  {/* The server's handle for this row, carried back untouched so
                      the patch can be matched to the topper it edits. */}
                  <input type="hidden" {...register(`toppers.${index}.id`)} />

                  <div className="flex items-start justify-between gap-2">
                    <p className="eyebrow">Topper {index + 1}</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove topper ${index + 1}`}
                      onClick={() => remove(index)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_100px_80px]">
                    <TextField
                      id={`toppers-name-${index}`}
                      label="Name"
                      placeholder="Priya S"
                      maxLength={120}
                      error={errors.toppers?.[index]?.name?.message}
                      {...register(`toppers.${index}.name`)}
                    />
                    <TextField
                      id={`toppers-percentage-${index}`}
                      label="Score %"
                      type="number"
                      step="any"
                      inputMode="decimal"
                      error={errors.toppers?.[index]?.percentage?.message}
                      {...register(`toppers.${index}.percentage`, { setValueAs: asNumber })}
                    />
                    <TextField
                      id={`toppers-rank-${index}`}
                      label="Rank"
                      type="number"
                      inputMode="numeric"
                      error={errors.toppers?.[index]?.rank?.message}
                      {...register(`toppers.${index}.rank`, { setValueAs: asNumber })}
                    />
                  </div>

                  <TextField
                    id={`toppers-note-${index}`}
                    label="Note"
                    placeholder="School topper, district rank 3"
                    maxLength={200}
                    error={errors.toppers?.[index]?.note?.message}
                    {...register(`toppers.${index}.note`)}
                  />

                  {saved ? (
                    <TopperPhoto
                      resultId={result.id}
                      topper={saved}
                      onResult={onResult}
                      position={index + 1}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Save this section to add a photo.
                    </p>
                  )}

                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      {...register(`toppers.${index}.consentAcknowledged`)}
                    />
                    <span>
                      We hold this student&apos;s consent (or their guardian&apos;s) to publish
                      their name, score and photograph.
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={fields.length >= RESULT_MAX_TOPPERS}
            onClick={() =>
              append({
                name: "",
                // Blank rather than a prefilled 0 — an untouched 0 would publish
                // as a real score. The resolver refuses it until it is typed.
                percentage: undefined as unknown as number,
                note: "",
                consentAcknowledged: false,
              })
            }
          >
            <Plus className="size-3.5" />
            Add topper
          </Button>
          <p className="text-xs text-muted-foreground">
            {fields.length} of {RESULT_MAX_TOPPERS} used.
          </p>
        </div>

        {errors.toppers?.message ? (
          <p role="alert" className="text-xs text-foreground">
            {errors.toppers.message}
          </p>
        ) : null}
      </FieldGroup>
    </SectionForm>
  );
}

