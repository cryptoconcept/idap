"use client";

import { useEffect, useRef } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { Plus, X } from "lucide-react";
import { updateResultSchema } from "@/lib/validation/result";
import { GRADE_BUCKETS, RESULT_MAX_COMBINATIONS, RESULT_MAX_TOPPERS } from "@/lib/constants";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";
import type { ResultDTO } from "@/services/result.service";
import { Button } from "@/components/ui/button";
import {
  FieldGroup,
  reportSectionErrors,
  SectionForm,
  SelectField,
  TextField,
} from "@/components/profile/section-form";
import { TopperPhoto } from "@/components/results/topper-photo";
import type { ResultSectionProps } from "@/components/results/result-editor";

type Values = z.input<typeof updateResultSchema>;
type Parsed = z.output<typeof updateResultSchema>;
type Combination = NonNullable<ResultDTO["combinations"]>[number];

/** An empty number input must stay absent — the schema takes a number, not NaN. */
const asNumber = (value: unknown) =>
  value === "" || value === null || value === undefined ? undefined : Number(value);

/**
 * A saved combination as this form holds it. The `id` is what lets an edit be
 * matched back to its row, and its toppers are seeded the same way
 * `toppers-section.tsx` seeds the top level — following the same
 * `mergeToppers` identity discipline one level down.
 */
const toFormRow = (combination: Combination) => ({
  id: combination.id,
  academicUnitId: combination.academicUnitId,
  label: combination.label,
  appeared: combination.appeared,
  passed: combination.passed,
  distinction: combination.distinction,
  firstClass: combination.firstClass,
  highestScore: combination.highestScore,
  averageScore: combination.averageScore,
  grades: combination.grades ?? {},
  boys: combination.boys ?? {},
  girls: combination.girls ?? {},
  toppers: (combination.toppers ?? []).map((topper) => ({
    id: topper.id,
    name: topper.name,
    percentage: topper.percentage,
    rank: topper.rank,
    note: topper.note ?? "",
    consentAcknowledged: topper.consentAcknowledged,
  })),
});

/**
 * Branch or combination breakdown — PUC Science versus Commerce, engineering
 * CSE versus ECE. Each row can optionally link to the academic tree, which
 * only fills the label in; the label itself stays free text so a later
 * rename of the unit never silently retitles a past result (see the design
 * spec's Decision 3).
 */
export function CombinationsSection({
  result,
  onSave,
  onDirtyChange,
  units,
}: ResultSectionProps & { units: AcademicUnitDTO[] }) {
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
    defaultValues: { combinations: (result.combinations ?? []).map(toFormRow) },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "combinations",
    keyName: "_key",
  });

  /**
   * A combination's toppers are a hand-managed array (via `watch`/`setValue`
   * below), not a nested `useFieldArray` — calling `useFieldArray` again
   * inside `fields.map()` below would be a conditional hook call, varying
   * with `fields.length`, which the Rules of Hooks forbid. That leaves this
   * array's rows with no identity of their own to key React's reconciliation
   * on, unlike the outer `combinations` array (which gets one for free via
   * `useFieldArray`'s own `_key`).
   *
   * Without a stable key, React reuses a row's DOM/state by POSITION: remove
   * combination-topper #1 while #2's `TopperPhoto` upload is in flight, and
   * the in-flight state silently reattaches to whatever now sits at index 1
   * — the wrong topper. This map holds one generated key per topper row,
   * scoped per combination by that combination's own stable `_key`, spliced
   * in lockstep with every add/remove this section performs. It is read only
   * for React's `key` prop — never sent to the server, never part of
   * react-hook-form's own state.
   */
  const topperKeysByCombination = useRef<Map<string, string[]>>(new Map());
  const nextTopperKeySeq = useRef(0);

  /** Lazily seeds (or re-seeds, e.g. after a post-save `reset`) a combination's key list to match its current topper count. */
  function ensureTopperKeys(combinationKey: string, count: number): string[] {
    const existing = topperKeysByCombination.current.get(combinationKey);
    if (existing && existing.length === count) return existing;
    const seeded = Array.from({ length: count }, () => `t${nextTopperKeySeq.current++}`);
    topperKeysByCombination.current.set(combinationKey, seeded);
    return seeded;
  }

  function addTopperKey(combinationKey: string) {
    const keys = topperKeysByCombination.current.get(combinationKey) ?? [];
    topperKeysByCombination.current.set(combinationKey, [
      ...keys,
      `t${nextTopperKeySeq.current++}`,
    ]);
  }

  function removeTopperKey(combinationKey: string, topperIndex: number) {
    const keys = topperKeysByCombination.current.get(combinationKey) ?? [];
    topperKeysByCombination.current.set(
      combinationKey,
      keys.filter((_, i) => i !== topperIndex),
    );
  }

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  async function onSubmit(values: Parsed) {
    const next = await onSave(values as Record<string, unknown>);
    if (next) reset({ combinations: (next.combinations ?? []).map(toFormRow) });
  }

  return (
    <SectionForm
      title="Combinations"
      description="Branch or combination results inside this cycle — PUC Science and Commerce, or engineering CSE and ECE."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup>
        {fields.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No combinations recorded. A cycle can be published without any — this is a
            breakdown of the totals in Outcome, not a replacement for them.
          </p>
        ) : (
          <ul className="space-y-3">
            {fields.map((entry, index) => {
              const saved: Combination | undefined = isDirty ? undefined : result.combinations?.[index];

              return (
                <li key={entry._key} className="space-y-3 rounded-lg border border-border p-3">
                  <input type="hidden" {...register(`combinations.${index}.id`)} />

                  <div className="flex items-start justify-between gap-2">
                    <p className="eyebrow">Combination {index + 1}</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove combination ${index + 1}`}
                      onClick={() => {
                        topperKeysByCombination.current.delete(entry._key);
                        remove(index);
                      }}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>

                  {units.length > 0 ? (
                    <SelectField
                      id={`combinations-unit-${index}`}
                      label="Fill from academic unit"
                      value={watch(`combinations.${index}.academicUnitId`) ?? ""}
                      onChange={(value) => {
                        const unit = units.find((u) => u.id === value);
                        setValue(`combinations.${index}.academicUnitId`, value, { shouldDirty: true });
                        if (unit) {
                          setValue(`combinations.${index}.label`, unit.name, { shouldDirty: true });
                        }
                      }}
                      options={units.map((unit) => ({ value: unit.id, label: unit.pathLabel }))}
                      placeholder="Optional — picks a label from your academic structure"
                    />
                  ) : null}

                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_100px_100px]">
                    <TextField
                      id={`combinations-label-${index}`}
                      label="Label"
                      placeholder="PCMB"
                      maxLength={60}
                      error={errors.combinations?.[index]?.label?.message}
                      {...register(`combinations.${index}.label`)}
                    />
                    <TextField
                      id={`combinations-appeared-${index}`}
                      label="Appeared"
                      type="number"
                      inputMode="numeric"
                      error={errors.combinations?.[index]?.appeared?.message}
                      {...register(`combinations.${index}.appeared`, { setValueAs: asNumber })}
                    />
                    <TextField
                      id={`combinations-passed-${index}`}
                      label="Passed"
                      type="number"
                      inputMode="numeric"
                      error={errors.combinations?.[index]?.passed?.message}
                      {...register(`combinations.${index}.passed`, { setValueAs: asNumber })}
                    />
                  </div>

                  {/* Collapsed by default — most combinations need only label/appeared/passed,
                      and a row that opens with fourteen inputs reads as work (design spec §6). */}
                  <details className="rounded-md border border-border/70 p-2.5">
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                      More details — distinction, grades, gender split
                    </summary>
                    <div className="mt-3 space-y-3">
                      <div className="grid gap-3 sm:grid-cols-4">
                        <TextField
                          id={`combinations-distinction-${index}`}
                          label="Distinction"
                          type="number"
                          inputMode="numeric"
                          hint="Optional."
                          error={errors.combinations?.[index]?.distinction?.message}
                          {...register(`combinations.${index}.distinction`, { setValueAs: asNumber })}
                        />
                        <TextField
                          id={`combinations-firstClass-${index}`}
                          label="First class"
                          type="number"
                          inputMode="numeric"
                          hint="Optional."
                          error={errors.combinations?.[index]?.firstClass?.message}
                          {...register(`combinations.${index}.firstClass`, { setValueAs: asNumber })}
                        />
                        <TextField
                          id={`combinations-highestScore-${index}`}
                          label="Highest score %"
                          type="number"
                          step="any"
                          inputMode="decimal"
                          hint="Optional."
                          error={errors.combinations?.[index]?.highestScore?.message}
                          {...register(`combinations.${index}.highestScore`, { setValueAs: asNumber })}
                        />
                        <TextField
                          id={`combinations-averageScore-${index}`}
                          label="Average score %"
                          type="number"
                          step="any"
                          inputMode="decimal"
                          hint="Optional."
                          error={errors.combinations?.[index]?.averageScore?.message}
                          {...register(`combinations.${index}.averageScore`, { setValueAs: asNumber })}
                        />
                      </div>

                      <div>
                        <p className="mb-1.5 text-xs text-muted-foreground">Grade spread</p>
                        <div className="grid gap-2 sm:grid-cols-6">
                          {GRADE_BUCKETS.map((bucket) => (
                            <TextField
                              key={bucket}
                              id={`combinations-${index}-grade-${bucket}`}
                              label={bucket}
                              type="number"
                              inputMode="numeric"
                              {...register(`combinations.${index}.grades.${bucket}` as const, {
                                setValueAs: asNumber,
                              })}
                            />
                          ))}
                        </div>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid grid-cols-2 gap-2">
                          <TextField
                            id={`combinations-boys-appeared-${index}`}
                            label="Boys appeared"
                            type="number"
                            inputMode="numeric"
                            hint="Optional."
                            {...register(`combinations.${index}.boys.appeared`, { setValueAs: asNumber })}
                          />
                          <TextField
                            id={`combinations-boys-passed-${index}`}
                            label="Boys passed"
                            type="number"
                            inputMode="numeric"
                            hint="Optional."
                            {...register(`combinations.${index}.boys.passed`, { setValueAs: asNumber })}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <TextField
                            id={`combinations-girls-appeared-${index}`}
                            label="Girls appeared"
                            type="number"
                            inputMode="numeric"
                            hint="Optional."
                            {...register(`combinations.${index}.girls.appeared`, { setValueAs: asNumber })}
                          />
                          <TextField
                            id={`combinations-girls-passed-${index}`}
                            label="Girls passed"
                            type="number"
                            inputMode="numeric"
                            hint="Optional."
                            {...register(`combinations.${index}.girls.passed`, { setValueAs: asNumber })}
                          />
                        </div>
                      </div>
                    </div>
                  </details>

                  <div className="space-y-3 border-t border-border pt-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Toppers within {watch(`combinations.${index}.label`) || "this combination"}
                    </p>
                    {(() => {
                      const toppersField = watch(`combinations.${index}.toppers`) ?? [];
                      const rowKeys = ensureTopperKeys(entry._key, toppersField.length);
                      return toppersField.map((_topperRow, topperIndex) => {
                        const savedTopper = saved?.toppers?.[topperIndex];
                        return (
                          <div
                            key={rowKeys[topperIndex] ?? `${entry._key}-${topperIndex}`}
                            className="space-y-2 rounded-md border border-border/70 p-2.5"
                          >
                            <input
                              type="hidden"
                              {...register(`combinations.${index}.toppers.${topperIndex}.id`)}
                            />
                            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_90px_70px_auto]">
                              <TextField
                                id={`combinations-${index}-topper-${topperIndex}-name`}
                                label="Name"
                                maxLength={120}
                                error={
                                  errors.combinations?.[index]?.toppers?.[topperIndex]?.name
                                    ?.message
                                }
                                {...register(`combinations.${index}.toppers.${topperIndex}.name`)}
                              />
                              <TextField
                                id={`combinations-${index}-topper-${topperIndex}-percentage`}
                                label="Score %"
                                type="number"
                                step="any"
                                inputMode="decimal"
                                error={
                                  errors.combinations?.[index]?.toppers?.[topperIndex]?.percentage
                                    ?.message
                                }
                                {...register(
                                  `combinations.${index}.toppers.${topperIndex}.percentage`,
                                  { setValueAs: asNumber },
                                )}
                              />
                              <TextField
                                id={`combinations-${index}-topper-${topperIndex}-rank`}
                                label="Rank"
                                type="number"
                                inputMode="numeric"
                                error={
                                  errors.combinations?.[index]?.toppers?.[topperIndex]?.rank
                                    ?.message
                                }
                                {...register(`combinations.${index}.toppers.${topperIndex}.rank`, {
                                  setValueAs: asNumber,
                                })}
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="mt-5"
                                aria-label="Remove this topper"
                                onClick={() => {
                                  const current = watch(`combinations.${index}.toppers`) ?? [];
                                  setValue(
                                    `combinations.${index}.toppers`,
                                    current.filter((_, i) => i !== topperIndex),
                                    { shouldDirty: true },
                                  );
                                  removeTopperKey(entry._key, topperIndex);
                                }}
                              >
                                <X className="size-3.5" />
                              </Button>
                            </div>
                            <TextField
                              id={`combinations-${index}-topper-${topperIndex}-note`}
                              label="Note"
                              placeholder="School topper, district rank 3"
                              maxLength={200}
                              error={
                                errors.combinations?.[index]?.toppers?.[topperIndex]?.note
                                  ?.message
                              }
                              {...register(`combinations.${index}.toppers.${topperIndex}.note`)}
                            />
                            <label className="flex items-start gap-2 text-xs">
                              <input
                                type="checkbox"
                                className="mt-0.5"
                                {...register(
                                  `combinations.${index}.toppers.${topperIndex}.consentAcknowledged`,
                                )}
                              />
                              <span>
                                We hold consent to publish this student&apos;s photograph.
                              </span>
                            </label>
                            {savedTopper ? (
                              <TopperPhoto
                                resultId={result.id}
                                topper={savedTopper}
                                onResult={() => {}}
                                position={topperIndex + 1}
                              />
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                Save this section to add a photo.
                              </p>
                            )}
                          </div>
                        );
                      });
                    })()}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={(watch(`combinations.${index}.toppers`) ?? []).length >= RESULT_MAX_TOPPERS}
                      onClick={() => {
                        const current = watch(`combinations.${index}.toppers`) ?? [];
                        setValue(
                          `combinations.${index}.toppers`,
                          [
                            ...current,
                            {
                              name: "",
                              percentage: undefined as unknown as number,
                              rank: undefined,
                              note: "",
                              consentAcknowledged: false,
                            },
                          ],
                          { shouldDirty: true },
                        );
                        addTopperKey(entry._key);
                      }}
                    >
                      <Plus className="size-3.5" />
                      Add topper
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fields.length >= RESULT_MAX_COMBINATIONS}
          onClick={() => append({ label: "", toppers: [] })}
        >
          <Plus className="size-3.5" />
          Add combination
        </Button>

        {typeof errors.combinations?.message === "string" ? (
          <p role="alert" className="text-xs text-foreground">
            {errors.combinations.message}
          </p>
        ) : null}
      </FieldGroup>
    </SectionForm>
  );
}
