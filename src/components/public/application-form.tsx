"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRef, useState } from "react";
import type { z } from "zod";
import { createApplicationSchema } from "@/lib/validation/application";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FieldRow, FormSection, PUBLIC_CONTROL, TextField } from "@/components/public/form-section";
import { GENDERS } from "@/lib/constants";

type ApplicationValues = z.input<typeof createApplicationSchema>;

/** Academic years offered in the dropdown, starting from the current one. */
function academicYearOptions(): string[] {
  const now = new Date();
  // Indian academic years start mid-year, so June onwards offers the next one first.
  const startYear = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;
  return [0, 1].map((offset) => {
    const from = startYear + offset;
    return `${from}-${String((from + 1) % 100).padStart(2, "0")}`;
  });
}

export function ApplicationForm({ institutionId }: { institutionId: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  // One idempotency key per form instance, minted lazily on the first submit
  // (client-only, so no SSR/hydration mismatch). A retry after a dropped
  // response replays the SAME key, so the server collapses it onto the first
  // write instead of creating a duplicate (audit M4).
  const idempotencyKey = useRef<string | null>(null);
  const years = academicYearOptions();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ApplicationValues>({
    resolver: zodResolver(createApplicationSchema),
    defaultValues: {
      academicYear: years[0],
      student: { firstName: "", middleName: "", lastName: "", gender: "", bloodGroup: "" },
      parent: { fatherName: "", motherName: "", guardianName: "", phone: "", alternatePhone: "", email: "" },
      address: { addressLine1: "", addressLine2: "", city: "", state: "", pincode: "" },
      academic: { previousInstitution: "", previousClass: "" },
      admission: { applyingFor: "", admissionType: "" },
      message: "",
    },
  });

  async function onSubmit(values: ApplicationValues) {
    setFormError(null);
    try {
      const response = await fetch(`/api/public/${institutionId}/applications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          sourceUrl: window.location.href,
          idempotencyKey: (idempotencyKey.current ??= crypto.randomUUID()),
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        setFormError(payload?.error?.message ?? "Something went wrong. Please try again.");
        return;
      }

      router.push(
        `/apply/${institutionId}/submitted?type=application&reference=${encodeURIComponent(payload.applicationNumber)}`,
      );
    } catch {
      setFormError("Could not reach the server. Check your connection and try again.");
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-7" noValidate>
      <FormSection title="Admission details">
        <FieldRow>
          <div className="space-y-1.5">
            <Label htmlFor="academicYear">
              Academic year<span className="text-muted-foreground"> *</span>
            </Label>
            <select
              id="academicYear"
              className={`w-full border border-input bg-background px-2.5 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ${PUBLIC_CONTROL}`}
              {...register("academicYear")}
            >
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
            {errors.academicYear ? (
              <p className="text-xs text-foreground">{errors.academicYear.message}</p>
            ) : null}
          </div>
          <TextField
            id="applyingFor"
            label="Applying for"
            required
            placeholder="Grade 5"
            error={errors.admission?.applyingFor?.message}
            {...register("admission.applyingFor")}
          />
        </FieldRow>
      </FormSection>

      <FormSection title="Student information">
        <FieldRow columns={3}>
          <TextField
            id="firstName"
            label="First name"
            required
            error={errors.student?.firstName?.message}
            {...register("student.firstName")}
          />
          <TextField
            id="middleName"
            label="Middle name"
            error={errors.student?.middleName?.message}
            {...register("student.middleName")}
          />
          <TextField
            id="lastName"
            label="Last name"
            error={errors.student?.lastName?.message}
            {...register("student.lastName")}
          />
        </FieldRow>
        <FieldRow columns={3}>
          <TextField
            id="dateOfBirth"
            label="Date of birth"
            type="date"
            error={errors.student?.dateOfBirth?.message}
            {...register("student.dateOfBirth")}
          />
          <div className="space-y-1.5">
            <Label htmlFor="gender">Gender</Label>
            <select
              id="gender"
              className={`w-full border border-input bg-background px-2.5 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ${PUBLIC_CONTROL}`}
              {...register("student.gender")}
            >
              <option value="">Select</option>
              {GENDERS.map((gender) => (
                <option key={gender} value={gender}>
                  {gender}
                </option>
              ))}
            </select>
          </div>
          <TextField
            id="bloodGroup"
            label="Blood group"
            placeholder="O+"
            error={errors.student?.bloodGroup?.message}
            {...register("student.bloodGroup")}
          />
        </FieldRow>
      </FormSection>

      <FormSection title="Parent / guardian information">
        <FieldRow columns={3}>
          <TextField
            id="fatherName"
            label="Father's name"
            error={errors.parent?.fatherName?.message}
            {...register("parent.fatherName")}
          />
          <TextField
            id="motherName"
            label="Mother's name"
            error={errors.parent?.motherName?.message}
            {...register("parent.motherName")}
          />
          <TextField
            id="guardianName"
            label="Guardian's name"
            error={errors.parent?.guardianName?.message}
            {...register("parent.guardianName")}
          />
        </FieldRow>
        <FieldRow columns={3}>
          <TextField
            id="parentPhone"
            label="Mobile number"
            type="tel"
            required
            placeholder="9876543210"
            error={errors.parent?.phone?.message}
            {...register("parent.phone")}
          />
          <TextField
            id="alternatePhone"
            label="Alternate phone"
            type="tel"
            error={errors.parent?.alternatePhone?.message}
            {...register("parent.alternatePhone")}
          />
          <TextField
            id="parentEmail"
            label="Email"
            type="email"
            error={errors.parent?.email?.message}
            {...register("parent.email")}
          />
        </FieldRow>
      </FormSection>

      <FormSection title="Address">
        <FieldRow columns={1}>
          <TextField
            id="addressLine1"
            label="Address line 1"
            error={errors.address?.addressLine1?.message}
            {...register("address.addressLine1")}
          />
          <TextField
            id="addressLine2"
            label="Address line 2"
            error={errors.address?.addressLine2?.message}
            {...register("address.addressLine2")}
          />
        </FieldRow>
        <FieldRow columns={3}>
          <TextField
            id="city"
            label="City"
            error={errors.address?.city?.message}
            {...register("address.city")}
          />
          <TextField
            id="state"
            label="State"
            error={errors.address?.state?.message}
            {...register("address.state")}
          />
          <TextField
            id="pincode"
            label="Pincode"
            inputMode="numeric"
            error={errors.address?.pincode?.message}
            {...register("address.pincode")}
          />
        </FieldRow>
      </FormSection>

      <FormSection
        title="Previous academic details"
        description="Where the student is studying now, if applicable."
      >
        <FieldRow columns={3}>
          <TextField
            id="previousInstitution"
            label="Previous institution"
            error={errors.academic?.previousInstitution?.message}
            {...register("academic.previousInstitution")}
          />
          <TextField
            id="previousClass"
            label="Previous class"
            error={errors.academic?.previousClass?.message}
            {...register("academic.previousClass")}
          />
          <TextField
            id="previousPercentage"
            label="Previous percentage"
            inputMode="decimal"
            placeholder="82"
            error={errors.academic?.previousPercentage?.message}
            {...register("academic.previousPercentage")}
          />
        </FieldRow>
      </FormSection>

      <FormSection title="Anything else we should know?">
        <div className="space-y-1.5">
          <Label htmlFor="message">Message</Label>
          <Textarea id="message" rows={4} className="text-[15px] sm:text-sm" {...register("message")} />
        </div>
      </FormSection>

      {formError ? (
        <p
          role="alert"
          className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
        >
          {formError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
        <Button type="submit" size="lg" className="h-10 px-5" disabled={isSubmitting}>
          {isSubmitting ? "Submitting…" : "Submit application"}
        </Button>
        <p className="text-xs text-muted-foreground">
          You will receive an application number on the next screen. Keep it for future reference.
        </p>
      </div>
    </form>
  );
}
