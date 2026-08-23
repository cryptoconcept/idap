"use client";

import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { updateProfileSchema } from "@/lib/validation/institution";
import { GENDER_TYPES, GENDER_TYPE_LABELS } from "@/lib/constants";
import {
  FieldGroup,
  FieldRow,
  reportSectionErrors,
  SectionForm,
  SelectField,
  TagsField,
  TextField,
  type SectionProps,
} from "@/components/profile/section-form";

type Values = z.input<typeof updateProfileSchema>;
type Parsed = z.output<typeof updateProfileSchema>;

const GENDER_OPTIONS = GENDER_TYPES.map((value) => ({
  value,
  label: GENDER_TYPE_LABELS[value],
}));

/** Board, affiliation and what is actually taught. Two of the heaviest completion checks live here. */
export function AcademicSection({ profile, onSave, onDirtyChange }: SectionProps) {
  const {
    register,
    control,
    handleSubmit,
    getValues,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: {
      academic: {
        board: profile.academic?.board ?? "",
        affiliation: profile.academic?.affiliation ?? "",
        recognition: profile.academic?.recognition ?? "",
        affiliationNumber: profile.academic?.affiliationNumber ?? "",
        udiseCode: profile.academic?.udiseCode ?? "",
        currentAcademicYear: profile.academic?.currentAcademicYear ?? "",
        genderType: profile.academic?.genderType,
        medium: profile.academic?.medium ?? [],
        classesOffered: profile.academic?.classesOffered ?? [],
        coursesOffered: profile.academic?.coursesOffered ?? [],
      },
    },
  });

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  async function onSubmit(values: Parsed) {
    if (await onSave(values as Record<string, unknown>)) reset(getValues());
  }

  return (
    <SectionForm
      title="Academic information"
      description="What you are affiliated to, and what you teach."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup title="Affiliation">
        <FieldRow>
          <TextField
            id="academic-board"
            label="Board"
            placeholder="CBSE"
            error={errors.academic?.board?.message}
            {...register("academic.board")}
          />
          <TextField
            id="academic-affiliation"
            label="Affiliated to"
            error={errors.academic?.affiliation?.message}
            {...register("academic.affiliation")}
          />
          <TextField
            id="academic-affiliationNumber"
            label="Affiliation number"
            error={errors.academic?.affiliationNumber?.message}
            {...register("academic.affiliationNumber")}
          />
          <TextField
            id="academic-recognition"
            label="Recognition"
            error={errors.academic?.recognition?.message}
            {...register("academic.recognition")}
          />
          <TextField
            id="academic-udiseCode"
            label="UDISE code"
            error={errors.academic?.udiseCode?.message}
            {...register("academic.udiseCode")}
          />
          <TextField
            id="academic-currentAcademicYear"
            label="Current academic year"
            placeholder="2026-27"
            error={errors.academic?.currentAcademicYear?.message}
            {...register("academic.currentAcademicYear")}
          />
          <Controller
            control={control}
            name="academic.genderType"
            render={({ field }) => (
              <SelectField
                id="academic-genderType"
                label="Admits"
                value={field.value}
                onChange={field.onChange}
                options={GENDER_OPTIONS}
                error={errors.academic?.genderType?.message}
              />
            )}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup
        title="What you teach"
        description="Saving replaces each list in full — that is how the API treats arrays."
      >
        <Controller
          control={control}
          name="academic.medium"
          render={({ field }) => (
            <TagsField
              id="academic-medium"
              label="Medium of instruction"
              values={field.value ?? []}
              onChange={field.onChange}
              maxLength={40}
              placeholder="English"
              max={12}
              error={errors.academic?.medium?.message}
            />
          )}
        />

        <Controller
          control={control}
          name="academic.classesOffered"
          render={({ field }) => (
            <TagsField
              id="academic-classesOffered"
              label="Classes offered"
              values={field.value ?? []}
              onChange={field.onChange}
              maxLength={40}
              placeholder="Grade 1"
              max={60}
              error={errors.academic?.classesOffered?.message}
            />
          )}
        />

        <Controller
          control={control}
          name="academic.coursesOffered"
          render={({ field }) => (
            <TagsField
              id="academic-coursesOffered"
              label="Courses offered"
              values={field.value ?? []}
              onChange={field.onChange}
              maxLength={120}
              placeholder="B.Sc Computer Science"
              max={120}
              error={errors.academic?.coursesOffered?.message}
            />
          )}
        />
      </FieldGroup>
    </SectionForm>
  );
}
