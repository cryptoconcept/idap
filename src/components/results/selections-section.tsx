"use client";

import { useEffect, useRef } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { Plus, X } from "lucide-react";
import { updateResultSchema } from "@/lib/validation/result";
import {
  EXAM_CODES,
  EXAM_CODE_LABELS,
  RESULT_MAX_SELECTIONS,
  RESULT_MAX_TOPPERS,
  type ExamCode,
} from "@/lib/constants";
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
type Selection = NonNullable<ResultDTO["selections"]>[number];

/** An empty number input must stay absent — the schema takes a number, not NaN. */
const asNumber = (value: unknown) =>
  value === "" || value === null || value === undefined ? undefined : Number(value);

/**
 * A saved selection as this form holds it. No `id` handle — a selection is
 * matched back to its row by `examCode` (see `selectionSchema`'s own
 * comment), unlike a combination's `id`. Its toppers are seeded the same way
 * `toppers-section.tsx` seeds the top level — following the same
 * `mergeToppers` identity discipline one level down.
 */
const toFormRow = (selection: Selection) => ({
  examCode: selection.examCode as ExamCode,
  appeared: selection.appeared,
  qualified: selection.qualified,
  bestRank: selection.bestRank,
  toppers: (selection.toppers ?? []).map((topper) => ({
    id: topper.id,
    name: topper.name,
    percentage: topper.percentage,
    rank: topper.rank,
    note: topper.note ?? "",
    consentAcknowledged: topper.consentAcknowledged,
  })),
});

/**
 * Competitive-exam outcomes — NEET, JEE, KCET, COMEDK. A selection is matched
 * on save by its `examCode`, so already-chosen exams are excluded from the
 * picker rather than accepted and rejected afterward by the uniqueness rule.
 */
export function SelectionsSection({ result, onSave, onDirtyChange, onResult }: ResultSectionProps) {
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
    defaultValues: { selections: (result.selections ?? []).map(toFormRow) },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "selections",
    keyName: "_key",
  });

  /**
   * A selection's toppers are a hand-managed array (via `watch`/`setValue`
   * below), not a nested `useFieldArray` — calling `useFieldArray` again
   * inside `fields.map()` below would be a conditional hook call, varying
   * with `fields.length`, which the Rules of Hooks forbid. That leaves this
   * array's rows with no identity of their own to key React's reconciliation
   * on, unlike the outer `selections` array (which gets one for free via
   * `useFieldArray`'s own `_key`).
   *
   * Without a stable key, React reuses a row's DOM/state by POSITION: remove
   * selection-topper #1 while #2's `TopperPhoto` upload is in flight, and the
   * in-flight state silently reattaches to whatever now sits at index 1 — the
   * wrong topper. This map holds one generated key per topper row, scoped per
   * selection by that selection's own stable `_key`, spliced in lockstep with
   * every add/remove this section performs. It is read only for React's `key`
   * prop — never sent to the server, never part of react-hook-form's own
   * state.
   */
  const topperKeysBySelection = useRef<Map<string, string[]>>(new Map());
  const nextTopperKeySeq = useRef(0);

  /** Lazily seeds (or re-seeds, e.g. after a post-save `reset`) a selection's key list to match its current topper count. */
  function ensureTopperKeys(selectionKey: string, count: number): string[] {
    const existing = topperKeysBySelection.current.get(selectionKey);
    if (existing && existing.length === count) return existing;
    const seeded = Array.from({ length: count }, () => `t${nextTopperKeySeq.current++}`);
    topperKeysBySelection.current.set(selectionKey, seeded);
    return seeded;
  }

  function addTopperKey(selectionKey: string) {
    const keys = topperKeysBySelection.current.get(selectionKey) ?? [];
    topperKeysBySelection.current.set(selectionKey, [
      ...keys,
      `t${nextTopperKeySeq.current++}`,
    ]);
  }

  function removeTopperKey(selectionKey: string, topperIndex: number) {
    const keys = topperKeysBySelection.current.get(selectionKey) ?? [];
    topperKeysBySelection.current.set(
      selectionKey,
      keys.filter((_, i) => i !== topperIndex),
    );
  }

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const watchedSelections = useWatch({ control, name: "selections" }) ?? [];
  const chosenCodes = new Set(watchedSelections.map((s) => s?.examCode).filter(Boolean));
  const availableCodes = EXAM_CODES.filter((code) => !chosenCodes.has(code));

  async function onSubmit(values: Parsed) {
    const next = await onSave(values as Record<string, unknown>);
    if (next) reset({ selections: (next.selections ?? []).map(toFormRow) });
  }

  return (
    <SectionForm
      title="Entrance exams"
      description="Competitive-exam outcomes for this cycle — mainly a PU stream's own selling point."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup>
        {fields.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No entrance-exam outcomes recorded yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {fields.map((entry, index) => {
              const saved: Selection | undefined = isDirty ? undefined : result.selections?.[index];
              const currentCode = watch(`selections.${index}.examCode`);

              return (
                <li key={entry._key} className="space-y-3 rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="eyebrow">Exam {index + 1}</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove exam ${index + 1}`}
                      onClick={() => {
                        topperKeysBySelection.current.delete(entry._key);
                        remove(index);
                      }}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>

                  <SelectField
                    id={`selections-${index}-examCode`}
                    label="Exam"
                    value={currentCode ?? ""}
                    onChange={(value) =>
                      setValue(`selections.${index}.examCode`, value as ExamCode, { shouldDirty: true })
                    }
                    options={EXAM_CODES.filter(
                      (code) => code === currentCode || availableCodes.includes(code),
                    ).map((code) => ({ value: code, label: EXAM_CODE_LABELS[code] }))}
                  />

                  <div className="grid gap-3 sm:grid-cols-3">
                    <TextField
                      id={`selections-${index}-appeared`}
                      label="Appeared"
                      type="number"
                      inputMode="numeric"
                      hint="Optional."
                      error={errors.selections?.[index]?.appeared?.message}
                      {...register(`selections.${index}.appeared`, { setValueAs: asNumber })}
                    />
                    <TextField
                      id={`selections-${index}-qualified`}
                      label="Qualified"
                      type="number"
                      inputMode="numeric"
                      hint="Optional."
                      error={errors.selections?.[index]?.qualified?.message}
                      {...register(`selections.${index}.qualified`, { setValueAs: asNumber })}
                    />
                    <TextField
                      id={`selections-${index}-bestRank`}
                      label="Best rank"
                      type="number"
                      inputMode="numeric"
                      hint="Optional."
                      error={errors.selections?.[index]?.bestRank?.message}
                      {...register(`selections.${index}.bestRank`, { setValueAs: asNumber })}
                    />
                  </div>

                  <div className="space-y-3 border-t border-border pt-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Toppers for {EXAM_CODE_LABELS[currentCode as keyof typeof EXAM_CODE_LABELS] ?? "this exam"}
                    </p>
                    {(() => {
                      const toppersField = watch(`selections.${index}.toppers`) ?? [];
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
                              {...register(`selections.${index}.toppers.${topperIndex}.id`)}
                            />
                            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_90px_70px_auto]">
                              <TextField
                                id={`selections-${index}-topper-${topperIndex}-name`}
                                label="Name"
                                maxLength={120}
                                error={errors.selections?.[index]?.toppers?.[topperIndex]?.name?.message}
                                {...register(`selections.${index}.toppers.${topperIndex}.name`)}
                              />
                              <TextField
                                id={`selections-${index}-topper-${topperIndex}-percentage`}
                                label="Score"
                                type="number"
                                step="any"
                                inputMode="decimal"
                                error={
                                  errors.selections?.[index]?.toppers?.[topperIndex]?.percentage?.message
                                }
                                {...register(
                                  `selections.${index}.toppers.${topperIndex}.percentage`,
                                  { setValueAs: asNumber },
                                )}
                              />
                              <TextField
                                id={`selections-${index}-topper-${topperIndex}-rank`}
                                label="Rank"
                                type="number"
                                inputMode="numeric"
                                error={
                                  errors.selections?.[index]?.toppers?.[topperIndex]?.rank?.message
                                }
                                {...register(`selections.${index}.toppers.${topperIndex}.rank`, {
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
                                  const current = watch(`selections.${index}.toppers`) ?? [];
                                  setValue(
                                    `selections.${index}.toppers`,
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
                              id={`selections-${index}-topper-${topperIndex}-note`}
                              label="Note"
                              placeholder="State rank 12, college topper"
                              maxLength={200}
                              error={
                                errors.selections?.[index]?.toppers?.[topperIndex]?.note?.message
                              }
                              {...register(`selections.${index}.toppers.${topperIndex}.note`)}
                            />
                            <label className="flex items-start gap-2 text-xs">
                              <input
                                type="checkbox"
                                className="mt-0.5"
                                {...register(
                                  `selections.${index}.toppers.${topperIndex}.consentAcknowledged`,
                                )}
                              />
                              <span>We hold consent to publish this student&apos;s photograph.</span>
                            </label>
                            {savedTopper ? (
                              <TopperPhoto
                                resultId={result.id}
                                topper={savedTopper}
                                onResult={onResult}
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
                      disabled={(watch(`selections.${index}.toppers`) ?? []).length >= RESULT_MAX_TOPPERS}
                      onClick={() => {
                        const current = watch(`selections.${index}.toppers`) ?? [];
                        setValue(
                          `selections.${index}.toppers`,
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
          disabled={fields.length >= RESULT_MAX_SELECTIONS || availableCodes.length === 0}
          onClick={() => append({ examCode: availableCodes[0], toppers: [] })}
        >
          <Plus className="size-3.5" />
          Add exam
        </Button>

        {typeof errors.selections?.message === "string" ? (
          <p role="alert" className="text-xs text-foreground">
            {errors.selections.message}
          </p>
        ) : null}
      </FieldGroup>
    </SectionForm>
  );
}
