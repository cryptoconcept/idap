"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { createStaffSchema, type CreateStaffInput } from "@/lib/validation/staff";
import { USER_ROLE_LABELS } from "@/lib/constants";

const ASSIGNABLE_ROLES = ["COUNSELOR", "FRONT_DESK"] as const;

export function CreateStaffDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateStaffInput>({
    resolver: zodResolver(createStaffSchema),
    defaultValues: { role: "COUNSELOR" },
  });

  async function onSubmit(values: CreateStaffInput) {
    try {
      const response = await fetch("/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not create the account. Please try again.");
        return;
      }

      toast.success(`${values.name} added as ${USER_ROLE_LABELS[values.role]}`);
      reset({ role: "COUNSELOR" });
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          Add staff account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <DialogHeader>
            <DialogTitle>Add a staff account</DialogTitle>
            <DialogDescription>
              They&apos;ll sign in with this email and password — share the password with them directly.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" aria-invalid={Boolean(errors.name)} {...register("name")} />
              {errors.name ? <p className="text-xs text-muted-foreground">{errors.name.message}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" aria-invalid={Boolean(errors.email)} {...register("email")} />
              {errors.email ? <p className="text-xs text-muted-foreground">{errors.email.message}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" aria-invalid={Boolean(errors.password)} {...register("password")} />
              {errors.password ? <p className="text-xs text-muted-foreground">{errors.password.message}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role">Role</Label>
              <Select value={watch("role")} onValueChange={(value) => setValue("role", value as CreateStaffInput["role"])}>
                <SelectTrigger id="role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>{USER_ROLE_LABELS[role]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
