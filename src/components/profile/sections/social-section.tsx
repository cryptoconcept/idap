"use client";

import { useEffect } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, X } from "lucide-react";
import type { z } from "zod";
import { updateProfileSchema } from "@/lib/validation/institution";
import { Button } from "@/components/ui/button";
import {
  FieldGroup,
  FieldRow,
  reportSectionErrors,
  SectionForm,
  TextField,
  type SectionProps,
} from "@/components/profile/section-form";

type Values = z.input<typeof updateProfileSchema>;
type Parsed = z.output<typeof updateProfileSchema>;

const MAX_OTHER = 6;

/** Two links of any kind earn the social part of the completion score. */
export function SocialSection({ profile, onSave, onDirtyChange }: SectionProps) {
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
      social: {
        facebook: profile.social?.facebook ?? "",
        instagram: profile.social?.instagram ?? "",
        youtube: profile.social?.youtube ?? "",
        linkedin: profile.social?.linkedin ?? "",
        x: profile.social?.x ?? "",
        other: (profile.social?.other ?? []).map((entry) => ({
          label: entry.label,
          url: entry.url ?? "",
        })),
      },
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "social.other" });

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  async function onSubmit(values: Parsed) {
    if (await onSave(values as Record<string, unknown>)) reset(getValues());
  }

  return (
    <SectionForm
      title="Social links"
      description="Every link here is published. Full URLs, starting with https://."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup>
        <FieldRow>
          <TextField
            id="social-facebook"
            label="Facebook"
            placeholder="https://facebook.com/…"
            error={errors.social?.facebook?.message}
            {...register("social.facebook")}
          />
          <TextField
            id="social-instagram"
            label="Instagram"
            placeholder="https://instagram.com/…"
            error={errors.social?.instagram?.message}
            {...register("social.instagram")}
          />
          <TextField
            id="social-youtube"
            label="YouTube"
            placeholder="https://youtube.com/…"
            error={errors.social?.youtube?.message}
            {...register("social.youtube")}
          />
          <TextField
            id="social-linkedin"
            label="LinkedIn"
            placeholder="https://linkedin.com/…"
            error={errors.social?.linkedin?.message}
            {...register("social.linkedin")}
          />
          <TextField
            id="social-x"
            label="X"
            placeholder="https://x.com/…"
            error={errors.social?.x?.message}
            {...register("social.x")}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup
        title="Anywhere else"
        description={`Up to ${MAX_OTHER} more links — an alumni page, a prospectus, a WhatsApp channel.`}
      >
        {fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">No other links yet.</p>
        ) : (
          <ul className="space-y-3">
            {fields.map((entry, index) => (
              <li key={entry.id} className="flex items-end gap-2">
                <div className="grid flex-1 gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
                  <TextField
                    id={`social-other-label-${index}`}
                    label="Label"
                    placeholder="Alumni"
                    maxLength={40}
                    error={errors.social?.other?.[index]?.label?.message}
                    {...register(`social.other.${index}.label` as const)}
                  />
                  <TextField
                    id={`social-other-url-${index}`}
                    label="Link"
                    placeholder="https://"
                    error={errors.social?.other?.[index]?.url?.message}
                    {...register(`social.other.${index}.url` as const)}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="mb-6"
                  aria-label={`Remove link ${index + 1}`}
                  onClick={() => remove(index)}
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fields.length >= MAX_OTHER}
          onClick={() => append({ label: "", url: "" })}
        >
          <Plus className="size-3.5" />
          Add a link
        </Button>
      </FieldGroup>
    </SectionForm>
  );
}
