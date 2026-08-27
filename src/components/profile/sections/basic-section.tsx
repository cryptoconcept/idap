"use client";

import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { updateProfileSchema } from "@/lib/validation/institution";
import { INSTITUTION_TYPES, INSTITUTION_TYPE_LABELS } from "@/lib/constants";
import type { ProfileDTO } from "@/lib/types";
import {
  FieldGroup,
  FieldRow,
  reportSectionErrors,
  SectionForm,
  SelectField,
  TextField,
  TextareaField,
  type SectionProps,
} from "@/components/profile/section-form";
import { ImageSlot } from "@/components/profile/media-upload";

type Values = z.input<typeof updateProfileSchema>;
type Parsed = z.output<typeof updateProfileSchema>;

const TYPE_OPTIONS = INSTITUTION_TYPES.map((value) => ({
  value,
  label: INSTITUTION_TYPE_LABELS[value],
}));

/** Identity and branding: the fields the public profile leads with. */
export function BasicSection({
  profile,
  onSave,
  onDirtyChange,
  onProfile,
}: SectionProps & { onProfile: (profile: ProfileDTO) => void }) {
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
      institutionName: profile.institutionName ?? "",
      legalName: profile.legalName ?? "",
      shortName: profile.shortName ?? "",
      institutionType: profile.institutionType,
      tagline: profile.tagline ?? "",
      description: profile.description ?? "",
      establishedYear: profile.establishedYear,
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
      title="Basic information"
      description="Who you are, in the words a parent searching for you would use."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup>
        <FieldRow>
          <TextField
            id="basic-institutionName"
            label="Institution name"
            error={errors.institutionName?.message}
            {...register("institutionName")}
          />
          <Controller
            control={control}
            name="institutionType"
            render={({ field }) => (
              <SelectField
                id="basic-institutionType"
                label="Institution type"
                value={field.value}
                onChange={field.onChange}
                options={TYPE_OPTIONS}
                error={errors.institutionType?.message}
              />
            )}
          />
          <TextField
            id="basic-legalName"
            label="Legal name"
            hint="As registered, if different from the name you trade under."
            error={errors.legalName?.message}
            {...register("legalName")}
          />
          <TextField
            id="basic-shortName"
            label="Short name"
            placeholder="ISE"
            error={errors.shortName?.message}
            {...register("shortName")}
          />
          <TextField
            id="basic-establishedYear"
            label="Year established"
            type="number"
            inputMode="numeric"
            placeholder="1998"
            error={errors.establishedYear?.message}
            {...register("establishedYear", {
              // An empty number input reads as "": send nothing rather than NaN.
              setValueAs: (value) =>
                value === "" || value === null || value === undefined ? undefined : Number(value),
            })}
          />
          <TextField
            id="basic-tagline"
            label="Tagline"
            placeholder="Learning that lasts"
            error={errors.tagline?.message}
            {...register("tagline")}
          />
        </FieldRow>

        <TextareaField
          id="basic-description"
          label="About the institution"
          rows={6}
          placeholder="What you teach, who you teach, and what makes the place what it is."
          hint="Shown in full on your public profile."
          error={errors.description?.message}
          {...register("description")}
        />
      </FieldGroup>

      <FieldGroup
        title="Logo and cover"
        description="Uploaded straight away — these are not part of Save section. JPG, PNG or WEBP, up to 5 MB."
      >
        <FieldRow>
          <ImageSlot
            label="Logo"
            description="Square works best. Shown beside your name."
            imageUrl={profile.logoUrl}
            alt={`${profile.institutionName} logo`}
            target="LOGO"
            onUploaded={onProfile}
          />
          <ImageSlot
            label="Cover image"
            description="A wide photograph of the campus."
            imageUrl={profile.coverImageUrl}
            alt={`${profile.institutionName} cover image`}
            target="COVER"
            fit="cover"
            onUploaded={onProfile}
          />
        </FieldRow>
      </FieldGroup>
    </SectionForm>
  );
}
