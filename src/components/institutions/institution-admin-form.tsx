"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { INSTITUTION_TYPES, INSTITUTION_TYPE_LABELS, type InstitutionType } from "@/lib/constants";
import type { InstitutionDTO } from "@/lib/types";

// Only fields platformInstitutionPatchSchema accepts: profile content
// (contact details, branding, address, etc.) belongs to the institute admin
// alone and is edited from their own profile page, not here.
const TEXT_FIELDS: { name: keyof InstitutionDTO; label: string; placeholder?: string }[] = [
  { name: "institutionName", label: "Institution name" },
  { name: "regionCode", label: "Region code", placeholder: "e.g. KA-MYS" },
];

/** Super-admin editor: provisioning fields (name, type, region) and the activate/deactivate switch. */
export function InstitutionAdminForm({ institution }: { institution: InstitutionDTO }) {
  const router = useRouter();
  const [values, setValues] = useState(institution);
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  function set<K extends keyof InstitutionDTO>(key: K, value: InstitutionDTO[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function patch(body: Record<string, unknown>, successMessage: string) {
    setSaving(true);
    try {
      const response = await fetch(`/api/institutions/${institution.institutionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not save. Please try again.");
        return false;
      }

      toast.success(successMessage);
      startTransition(() => router.refresh());
      return true;
    } catch {
      toast.error("Could not reach the server. Please try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    await patch(
      {
        institutionName: values.institutionName,
        institutionType: values.institutionType,
        regionCode: values.regionCode ?? "",
      },
      "Institution saved",
    );
  }

  async function toggleActive(next: boolean) {
    const previous = values.active;
    set("active", next);
    const ok = await patch(
      { active: next },
      next ? "Institution activated" : "Institution deactivated",
    );
    if (!ok) set("active", previous);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-mist px-4 py-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            {values.active ? "Institution is active" : "Institution is deactivated"}
          </p>
          <p className="text-xs text-muted-foreground">
            {values.active
              ? "Admins can sign in and the API accepts submissions."
              : "Sign-in is blocked and the API rejects new submissions."}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Label htmlFor="active" className="text-xs text-muted-foreground">
            Active
          </Label>
          <Switch
            id="active"
            checked={values.active}
            onCheckedChange={toggleActive}
            disabled={saving}
          />
        </div>
      </div>

      <form onSubmit={save} className="space-y-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="institutionType">Institution type</Label>
            <Select
              value={values.institutionType}
              onValueChange={(value) => set("institutionType", value as InstitutionType)}
            >
              <SelectTrigger id="institutionType" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INSTITUTION_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {INSTITUTION_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {TEXT_FIELDS.map((field) => (
            <div key={field.name} className="space-y-1.5">
              <Label htmlFor={String(field.name)}>{field.label}</Label>
              <Input
                id={String(field.name)}
                value={(values[field.name] as string | undefined) ?? ""}
                placeholder={field.placeholder}
                onChange={(event) =>
                  set(field.name, event.target.value as InstitutionDTO[typeof field.name])
                }
              />
            </div>
          ))}
        </div>

        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </div>
  );
}
