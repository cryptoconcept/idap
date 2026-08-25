"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { updateProfileSchema } from "@/lib/validation/institution";
import { GENDER_TYPES, GENDER_TYPE_LABELS } from "@/lib/constants";
import type { DerivedOfferings } from "@/lib/academic/offerings";
import { Button } from "@/components/ui/button";
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
export function AcademicSection({
  profile,
  onSave,
  onDirtyChange,
  offerings,
}: SectionProps & {
  /** Derived from the academic structure tree; `null` when no tree exists yet. */
  offerings: DerivedOfferings | null;
}) {
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
      },
    },
  });

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  // Per array, not per institution — mirrors the public projection's fallback
  // (item 1) so this card never claims something the profile does not actually
  // publish.
  const classesOffered = offerings?.classesOffered.length
    ? offerings.classesOffered
    : (profile.academic?.classesOffered ?? []);
  const coursesOffered = offerings?.coursesOffered.length
    ? offerings.coursesOffered
    : (profile.academic?.coursesOffered ?? []);

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
        description="Saving replaces the medium list in full — that is how the API treats arrays."
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

        {/*
          Classes and courses used to be typed here. They are now derived from
          the academic structure — one source of truth, and the shape follows
          the kind of institution rather than being two free-text lists.
        */}
        <div className="rounded-md border border-border p-3">
          <p className="text-sm font-medium">Classes and courses</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            These are published from your academic structure, so they stay in step with what you
            actually offer.
          </p>
          <dl className="mt-3 space-y-2 text-xs">
            <div>
              <dt className="font-medium text-foreground">Classes offered</dt>
              <dd className="mt-0.5 text-muted-foreground">
                {classesOffered.length > 0 ? classesOffered.join(", ") : "Nothing published yet"}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">Courses offered</dt>
              <dd className="mt-0.5 text-muted-foreground">
                {coursesOffered.length > 0 ? coursesOffered.join(", ") : "Nothing published yet"}
              </dd>
            </div>
          </dl>
          <Button asChild size="sm" variant="outline" className="mt-3">
            <Link href="/academic-structure">Edit academic structure</Link>
          </Button>
        </div>
      </FieldGroup>
    </SectionForm>
  );
}
