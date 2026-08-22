"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import type { z } from "zod";
import { createLeadSchema } from "@/lib/validation/lead";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FieldRow, FormSection, TextField } from "@/components/public/form-section";

type EnquiryValues = z.input<typeof createLeadSchema>;

export function EnquiryForm({ institutionId }: { institutionId: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EnquiryValues>({
    resolver: zodResolver(createLeadSchema),
    defaultValues: {
      studentName: "",
      parentName: "",
      phone: "",
      email: "",
      classInterested: "",
      message: "",
    },
  });

  async function onSubmit(values: EnquiryValues) {
    setFormError(null);
    try {
      const response = await fetch(`/api/public/${institutionId}/leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, sourceUrl: window.location.href }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        setFormError(payload?.error?.message ?? "Something went wrong. Please try again.");
        return;
      }

      router.push(
        `/apply/${institutionId}/submitted?type=enquiry&reference=${encodeURIComponent(payload.leadNumber)}`,
      );
    } catch {
      setFormError("Could not reach the server. Check your connection and try again.");
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
      <FormSection title="Who is the enquiry for?">
        <FieldRow>
          <TextField
            id="studentName"
            label="Student name"
            required
            error={errors.studentName?.message}
            {...register("studentName")}
          />
          <TextField
            id="classInterested"
            label="Class or course interested in"
            placeholder="Grade 5"
            error={errors.classInterested?.message}
            {...register("classInterested")}
          />
        </FieldRow>
      </FormSection>

      <FormSection title="How can we reach you?">
        <FieldRow>
          <TextField
            id="parentName"
            label="Parent or guardian name"
            error={errors.parentName?.message}
            {...register("parentName")}
          />
          <TextField
            id="phone"
            label="Mobile number"
            type="tel"
            required
            placeholder="9876543210"
            error={errors.phone?.message}
            {...register("phone")}
          />
          <TextField
            id="email"
            label="Email"
            type="email"
            error={errors.email?.message}
            {...register("email")}
          />
        </FieldRow>
      </FormSection>

      <FormSection title="Anything you would like to add?">
        <div className="space-y-1.5">
          <Label htmlFor="message">Message</Label>
          <Textarea
            id="message"
            rows={4}
            placeholder="Questions about fees, transport, campus visits…"
            className="text-[15px] sm:text-sm"
            {...register("message")}
          />
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

      <div className="flex items-center gap-3 border-t border-border pt-5">
        <Button type="submit" size="lg" className="h-10 px-5" disabled={isSubmitting}>
          {isSubmitting ? "Submitting…" : "Submit enquiry"}
        </Button>
        <p className="text-xs text-muted-foreground">
          The admissions office will get back to you on the number you provide.
        </p>
      </div>
    </form>
  );
}
