"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { updateProfileSchema } from "@/lib/validation/institution";
import {
  FieldGroup,
  FieldRow,
  SectionForm,
  TextField,
  type SectionProps,
} from "@/components/profile/section-form";

type Values = z.input<typeof updateProfileSchema>;
type Parsed = z.output<typeof updateProfileSchema>;

/** Every number and address on this screen is published. */
export function ContactSection({ profile, onSave, onDirtyChange }: SectionProps) {
  const {
    register,
    handleSubmit,
    getValues,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: {
      contactPerson: profile.contactPerson ?? "",
      phone: profile.phone ?? "",
      email: profile.email ?? "",
      website: profile.website ?? "",
      contact: {
        secondaryPhone: profile.contact?.secondaryPhone ?? "",
        whatsapp: profile.contact?.whatsapp ?? "",
        alternateEmail: profile.contact?.alternateEmail ?? "",
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
      title="Contact"
      description="How an interested parent reaches you. All of it is published."
      onSubmit={handleSubmit(onSubmit)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup title="Primary">
        <FieldRow>
          <TextField
            id="contact-contactPerson"
            label="Contact person"
            placeholder="Admissions Desk"
            error={errors.contactPerson?.message}
            {...register("contactPerson")}
          />
          <TextField
            id="contact-phone"
            label="Phone"
            type="tel"
            placeholder="9876543210"
            error={errors.phone?.message}
            {...register("phone")}
          />
          <TextField
            id="contact-email"
            label="Email"
            type="email"
            error={errors.email?.message}
            {...register("email")}
          />
          <TextField
            id="contact-website"
            label="Website"
            placeholder="https://"
            error={errors.website?.message}
            {...register("website")}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup title="Also reachable on">
        <FieldRow>
          <TextField
            id="contact-secondaryPhone"
            label="Secondary phone"
            type="tel"
            error={errors.contact?.secondaryPhone?.message}
            {...register("contact.secondaryPhone")}
          />
          <TextField
            id="contact-whatsapp"
            label="WhatsApp"
            type="tel"
            error={errors.contact?.whatsapp?.message}
            {...register("contact.whatsapp")}
          />
          <TextField
            id="contact-alternateEmail"
            label="Alternate email"
            type="email"
            error={errors.contact?.alternateEmail?.message}
            {...register("contact.alternateEmail")}
          />
        </FieldRow>
      </FieldGroup>
    </SectionForm>
  );
}
