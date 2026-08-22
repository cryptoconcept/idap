"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { updateInstitutionProfileSchema } from "@/lib/validation/institution";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TenantInstitution } from "@/lib/tenant";

type ProfileValues = z.input<typeof updateInstitutionProfileSchema>;

const FIELDS: { name: keyof ProfileValues; label: string; placeholder?: string; type?: string }[] = [
  { name: "institutionName", label: "Institution name" },
  { name: "contactPerson", label: "Contact person" },
  { name: "phone", label: "Phone", type: "tel" },
  { name: "email", label: "Email", type: "email" },
  { name: "website", label: "Website", placeholder: "https://" },
  { name: "logoUrl", label: "Logo URL", placeholder: "https://" },
  { name: "address", label: "Address" },
  { name: "city", label: "City" },
  { name: "state", label: "State" },
  { name: "pincode", label: "Pincode" },
];

/**
 * Branding entered here is what appears on printed applications, PDFs and the
 * hosted application pages.
 */
export function InstitutionProfileForm({ institution }: { institution: TenantInstitution }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
    reset,
  } = useForm<ProfileValues>({
    resolver: zodResolver(updateInstitutionProfileSchema),
    defaultValues: {
      institutionName: institution.institutionName,
      contactPerson: institution.contactPerson ?? "",
      phone: institution.phone ?? "",
      email: institution.email ?? "",
      website: institution.website ?? "",
      logoUrl: institution.logoUrl ?? "",
      address: institution.address ?? "",
      city: institution.city ?? "",
      state: institution.state ?? "",
      pincode: institution.pincode ?? "",
    },
  });

  async function onSubmit(values: ProfileValues) {
    try {
      const response = await fetch("/api/settings/institution", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not save. Please try again.");
        return;
      }

      toast.success("Institution profile saved");
      reset(values);
      startTransition(() => router.refresh());
    } catch {
      toast.error("Could not reach the server. Please try again.");
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <div key={field.name} className="space-y-1.5">
            <Label htmlFor={field.name}>{field.label}</Label>
            <Input
              id={field.name}
              type={field.type ?? "text"}
              placeholder={field.placeholder}
              aria-invalid={Boolean(errors[field.name])}
              {...register(field.name)}
            />
            {errors[field.name] ? (
              <p className="text-xs text-muted-foreground">
                {String(errors[field.name]?.message ?? "")}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={isSubmitting || !isDirty}>
          {isSubmitting ? "Saving…" : "Save changes"}
        </Button>
        <p className="text-xs text-muted-foreground">
          These details appear on printed applications and PDFs.
        </p>
      </div>
    </form>
  );
}
