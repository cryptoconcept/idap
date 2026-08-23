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
  TextareaField,
  type SectionProps,
} from "@/components/profile/section-form";

type Values = z.input<typeof updateProfileSchema>;
type Parsed = z.output<typeof updateProfileSchema>;

/** An empty coordinate must stay absent — the schema takes a number, not NaN. */
const asNumber = (value: unknown) =>
  value === "" || value === null || value === undefined ? undefined : Number(value);

export function AddressSection({ profile, onSave, onDirtyChange }: SectionProps) {
  const {
    register,
    handleSubmit,
    getValues,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: {
      address: profile.address ?? "",
      addressLine2: profile.addressLine2 ?? "",
      locality: profile.locality ?? "",
      area: profile.area ?? "",
      city: profile.city ?? "",
      taluk: profile.taluk ?? "",
      district: profile.district ?? "",
      state: profile.state ?? "",
      country: profile.country ?? "",
      pincode: profile.pincode ?? "",
      geo: {
        latitude: profile.geo?.latitude,
        longitude: profile.geo?.longitude,
        mapUrl: profile.geo?.mapUrl ?? "",
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
      title="Address"
      description="Where you are. District is one of the details the completion score looks for."
      onSubmit={handleSubmit(onSubmit)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <FieldGroup>
        <TextareaField
          id="address-address"
          label="Street address"
          rows={2}
          error={errors.address?.message}
          {...register("address")}
        />

        <FieldRow>
          <TextField
            id="address-addressLine2"
            label="Address line 2"
            error={errors.addressLine2?.message}
            {...register("addressLine2")}
          />
          <TextField
            id="address-locality"
            label="Locality"
            error={errors.locality?.message}
            {...register("locality")}
          />
          <TextField
            id="address-area"
            label="Area"
            error={errors.area?.message}
            {...register("area")}
          />
          <TextField
            id="address-city"
            label="City"
            error={errors.city?.message}
            {...register("city")}
          />
          <TextField
            id="address-taluk"
            label="Taluk"
            error={errors.taluk?.message}
            {...register("taluk")}
          />
          <TextField
            id="address-district"
            label="District"
            error={errors.district?.message}
            {...register("district")}
          />
          <TextField
            id="address-state"
            label="State"
            error={errors.state?.message}
            {...register("state")}
          />
          <TextField
            id="address-country"
            label="Country"
            placeholder="India"
            error={errors.country?.message}
            {...register("country")}
          />
          <TextField
            id="address-pincode"
            label="Pincode"
            inputMode="numeric"
            error={errors.pincode?.message}
            {...register("pincode")}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup
        title="Map location"
        description="Optional. Published so a website can drop a pin without geocoding your address."
      >
        <FieldRow columns={3}>
          <TextField
            id="address-latitude"
            label="Latitude"
            type="number"
            step="any"
            inputMode="decimal"
            placeholder="12.2958"
            error={errors.geo?.latitude?.message}
            {...register("geo.latitude", { setValueAs: asNumber })}
          />
          <TextField
            id="address-longitude"
            label="Longitude"
            type="number"
            step="any"
            inputMode="decimal"
            placeholder="76.6394"
            error={errors.geo?.longitude?.message}
            {...register("geo.longitude", { setValueAs: asNumber })}
          />
          <TextField
            id="address-mapUrl"
            label="Map link"
            placeholder="https://"
            error={errors.geo?.mapUrl?.message}
            {...register("geo.mapUrl")}
          />
        </FieldRow>
      </FieldGroup>
    </SectionForm>
  );
}
