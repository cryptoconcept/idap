"use client";

import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { updateResultSchema } from "@/lib/validation/result";
import {
  BOARD_NAME_REQUIRED,
  RESULT_BOARDS,
  RESULT_BOARD_LABELS,
  RESULT_LEVELS,
  RESULT_LEVEL_LABELS,
  RESULT_STREAMS,
  RESULT_STREAM_LABELS,
  type ResultBoard,
  type ResultLevel,
  type ResultStream,
} from "@/lib/constants";
import type { ResultDTO } from "@/services/result.service";
import {
  FieldGroup,
  FieldRow,
  reportSectionErrors,
  SectionForm,
  SelectField,
  TextField,
} from "@/components/profile/section-form";
import type { SaveSection } from "@/components/results/result-editor";

type Values = z.input<typeof updateResultSchema>;
type Parsed = z.output<typeof updateResultSchema>;

const BOARD_OPTIONS = RESULT_BOARDS.map((value) => ({
  value,
  label: RESULT_BOARD_LABELS[value],
}));

const LEVEL_OPTIONS = RESULT_LEVELS.map((value) => ({
  value,
  label: RESULT_LEVEL_LABELS[value],
}));

/**
 * Radix has no empty option value, and "no stream" is a real answer rather than
 * an unanswered question — so it travels as a sentinel here and as `null` in
 * the patch, which is what the unique cycle index stores.
 */
const NO_STREAM = "NONE";

const STREAM_OPTIONS = [
  { value: NO_STREAM, label: "Not applicable" },
  ...RESULT_STREAMS.map((value) => ({ value, label: RESULT_STREAM_LABELS[value] })),
];

/**
 * Which exam cycle this is. On a new result these fields are all there is:
 * the outcome numbers and the toppers open once the cycle exists, because a
 * topper's photo needs a saved result to attach itself to.
 */
export function CycleSection({
  result,
  onSave,
  onDirtyChange,
}: {
  /** `null` while creating — the same fields, saved by a POST instead of a PATCH. */
  result: ResultDTO | null;
  onSave: SaveSection;
  onDirtyChange: (dirty: boolean) => void;
}) {
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
      board: (result?.board as ResultBoard | undefined) ?? "CBSE",
      boardName: result?.boardName ?? "",
      level: (result?.level as ResultLevel | undefined) ?? "CLASS_10",
      stream: (result?.stream as ResultStream | null | undefined) ?? null,
      academicYear: result?.academicYear ?? "",
      examLabel: result?.examLabel ?? "",
    },
  });

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const board = useWatch({ control, name: "board" });
  const needsBoardName = BOARD_NAME_REQUIRED.has(board as ResultBoard);

  async function onSubmit(values: Parsed) {
    if (await onSave(values as Record<string, unknown>)) reset(getValues());
  }

  return (
    <SectionForm
      title="Exam cycle"
      description="Which board, which level, which year. Together these identify the cycle, so no two results can claim the same one."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup>
        <FieldRow>
          <Controller
            control={control}
            name="board"
            render={({ field }) => (
              <SelectField
                id="cycle-board"
                label="Board"
                value={field.value}
                onChange={field.onChange}
                options={BOARD_OPTIONS}
                error={errors.board?.message}
              />
            )}
          />

          {needsBoardName ? (
            <TextField
              id="cycle-boardName"
              label="Board name"
              placeholder="Karnataka State Board"
              maxLength={120}
              hint="Required — this board's name is not in the list above, so it is published from here."
              error={errors.boardName?.message}
              {...register("boardName")}
            />
          ) : null}

          <Controller
            control={control}
            name="level"
            render={({ field }) => (
              <SelectField
                id="cycle-level"
                label="Level"
                value={field.value}
                onChange={field.onChange}
                options={LEVEL_OPTIONS}
                error={errors.level?.message}
              />
            )}
          />

          <Controller
            control={control}
            name="stream"
            render={({ field }) => (
              <SelectField
                id="cycle-stream"
                label="Stream"
                value={field.value ?? NO_STREAM}
                onChange={(value) => field.onChange(value === NO_STREAM ? null : value)}
                options={STREAM_OPTIONS}
                hint="Only cycles that split by stream have one."
                error={errors.stream?.message}
              />
            )}
          />

          <TextField
            id="cycle-academicYear"
            label="Academic year"
            placeholder="2025-26"
            maxLength={20}
            error={errors.academicYear?.message}
            {...register("academicYear")}
          />

          <TextField
            id="cycle-examLabel"
            label="Exam label"
            placeholder="AISSE 2026"
            maxLength={120}
            hint="Overrides the label shown in this dashboard, e.g. AISSE 2026."
            error={errors.examLabel?.message}
            {...register("examLabel")}
          />
        </FieldRow>
      </FieldGroup>
    </SectionForm>
  );
}
