"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { INSTITUTION_TYPES, INSTITUTION_TYPE_LABELS, type InstitutionType } from "@/lib/constants";

const EMPTY = {
  institutionId: "",
  institutionName: "",
  institutionType: "SCHOOL" as InstitutionType,
  city: "",
  state: "",
  phone: "",
  email: "",
  adminName: "",
  adminEmail: "",
  adminPassword: "",
};

export function CreateInstitutionDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  function set<K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function create() {
    setSaving(true);
    try {
      const response = await fetch("/api/institutions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          institutionId: values.institutionId.trim() || undefined,
          adminName: values.adminName.trim() || undefined,
          adminEmail: values.adminEmail.trim() || undefined,
          adminPassword: values.adminPassword.trim() || undefined,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not create the institution.");
        return;
      }

      toast.success(
        `${payload.institution.institutionName} created as ${payload.institution.institutionId}` +
          (payload.adminCreated ? " with its first admin" : ""),
      );
      setValues(EMPTY);
      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-3.5" />
          New institution
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[86vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Create institution</DialogTitle>
          <DialogDescription>
            Leave the ID blank to allocate the next one automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="institutionId">Institution ID</Label>
              <Input
                id="institutionId"
                value={values.institutionId}
                onChange={(event) => set("institutionId", event.target.value.toUpperCase())}
                placeholder="INS0003"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="institutionType">Type</Label>
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
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="institutionName">Institution name</Label>
            <Input
              id="institutionName"
              value={values.institutionName}
              onChange={(event) => set("institutionName", event.target.value)}
              placeholder="Infinity School of Excellence"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                value={values.city}
                onChange={(event) => set("city", event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="state">State</Label>
              <Input
                id="state"
                value={values.state}
                onChange={(event) => set("state", event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                value={values.phone}
                onChange={(event) => set("phone", event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={values.email}
                onChange={(event) => set("email", event.target.value)}
              />
            </div>
          </div>

          <fieldset className="space-y-4 rounded-lg border border-border p-3">
            <legend className="px-1 text-xs text-muted-foreground">
              First institution admin (optional)
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="adminName">Name</Label>
                <Input
                  id="adminName"
                  value={values.adminName}
                  onChange={(event) => set("adminName", event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="adminEmail">Email</Label>
                <Input
                  id="adminEmail"
                  type="email"
                  value={values.adminEmail}
                  onChange={(event) => set("adminEmail", event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adminPassword">Password</Label>
              <Input
                id="adminPassword"
                type="text"
                value={values.adminPassword}
                onChange={(event) => set("adminPassword", event.target.value)}
                placeholder="At least 10 characters"
              />
            </div>
          </fieldset>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={create}
            disabled={saving || !values.institutionName.trim()}
          >
            {saving ? "Creating…" : "Create institution"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
