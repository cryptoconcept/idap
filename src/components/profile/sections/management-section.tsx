"use client";

import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { updateProfileSchema } from "@/lib/validation/institution";
import { MANAGEMENT_TYPES } from "@/lib/constants";
import {
  FieldGroup,
  FieldRow,
  SectionForm,
  SelectField,
  TextField,
  type SectionProps,
} from "@/components/profile/section-form";

type Values = z.input<typeof updateProfileSchema>;
type Parsed = z.output<typeof updateProfileSchema>;

/** No `_LABELS` record exists for management types; title-case the constant. */
const MANAGEMENT_OPTIONS = MANAGEMENT_TYPES.map((value) => ({
  value,
  label: value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" "),
}));

export function ManagementSection({ profile, onSave, onDirtyChange }: SectionProps) {
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
      management: {
        managementType: profile.management?.managementType,
        trustName: profile.management?.trustName ?? "",
        societyName: profile.management?.societyName ?? "",
        managementName: profile.management?.managementName ?? "",
        principalName: profile.management?.principalName ?? "",
        headDesignation: profile.management?.headDesignation ?? "",
        headEmail: profile.management?.headEmail ?? "",
        headPhone: profile.management?.headPhone ?? "",
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
      title="Management"
      description="Who runs the institution, and who heads it."
      onSubmit={handleSubmit(onSubmit)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup title="Ownership">
        <FieldRow>
          <Controller
            control={control}
            name="management.managementType"
            render={({ field }) => (
              <SelectField
                id="management-managementType"
                label="Management type"
                value={field.value}
                onChange={field.onChange}
                options={MANAGEMENT_OPTIONS}
                error={errors.management?.managementType?.message}
              />
            )}
          />
          <TextField
            id="management-managementName"
            label="Management name"
            error={errors.management?.managementName?.message}
            {...register("management.managementName")}
          />
          <TextField
            id="management-trustName"
            label="Trust"
            error={errors.management?.trustName?.message}
            {...register("management.trustName")}
          />
          <TextField
            id="management-societyName"
            label="Society"
            error={errors.management?.societyName?.message}
            {...register("management.societyName")}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup
        title="Head of institution"
        description="The name and designation are published. The direct email and phone are not — they stay inside I-DAP."
      >
        <FieldRow>
          <TextField
            id="management-principalName"
            label="Principal or head"
            error={errors.management?.principalName?.message}
            {...register("management.principalName")}
          />
          <TextField
            id="management-headDesignation"
            label="Designation"
            placeholder="Principal"
            error={errors.management?.headDesignation?.message}
            {...register("management.headDesignation")}
          />
          <TextField
            id="management-headEmail"
            label="Head's email"
            type="email"
            hint="Never published."
            error={errors.management?.headEmail?.message}
            {...register("management.headEmail")}
          />
          <TextField
            id="management-headPhone"
            label="Head's phone"
            type="tel"
            hint="Never published."
            error={errors.management?.headPhone?.message}
            {...register("management.headPhone")}
          />
        </FieldRow>
      </FieldGroup>
    </SectionForm>
  );
}
