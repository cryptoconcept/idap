"use client";

import { useRouter } from "next/navigation";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createScholarshipSchema, updateScholarshipSchema } from "@/lib/validation/scholarship";
import type { ScholarshipDTO } from "@/services/scholarship.service";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";

type Values = z.input<typeof createScholarshipSchema>;

/** Never a real academic-unit id — an ObjectId is 24 hex chars, so this sentinel
 * can't collide. Represents "institution-wide" (no `academicUnitId`) in the picker. */
const ALL_UNITS = "__all__";

/**
 * One form for both create and edit, mirroring `FeeStructureForm`. Unlike a
 * fee structure's class/course — immutable there because it carries a unique
 * (unit, year) index — a scholarship's `academicUnitId` carries no unique
 * key, so it stays editable in both modes and there is no read-only branch.
 */
export function ScholarshipForm({
  initialScholarship,
  units,
}: {
  /** `null` while creating — the same fields, saved by a POST instead of a PATCH. */
  initialScholarship: ScholarshipDTO | null;
  /** Effectively-active units to offer in the picker, for both create and edit. */
  units: AcademicUnitDTO[];
}) {
  const router = useRouter();
  const isEditing = initialScholarship !== null;

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    // Same double-cast reasoning as `FeeStructureForm`: `updateScholarshipSchema`
    // (`createScholarshipSchema.partial()`) types every field optional, which is
    // not assignable to `Resolver<Values>` where `Values` — shared with the
    // create schema so one form/one `Values` type covers both cases — has `name`
    // required. The real validation for whichever mode is active still runs at
    // submit time; only the static field-typing differs.
    resolver: zodResolver(
      isEditing ? updateScholarshipSchema : createScholarshipSchema,
    ) as unknown as Resolver<Values>,
    defaultValues: {
      name: initialScholarship?.name ?? "",
      criteria: initialScholarship?.criteria ?? "",
      amount: initialScholarship?.amount ?? "",
      academicUnitId: initialScholarship?.academicUnitId,
    },
  });

  async function onSubmit(values: Values) {
    // Belt-and-braces, not the primary defence: the Select's onValueChange
    // below already keeps the sentinel out of form state, so `values`
    // should never carry `ALL_UNITS` here. This guards against a future
    // regression re-introducing it without ever failing to strip it before
    // the request goes out. `null`, not `undefined`, is what "institution-
    // wide" means on the wire: `academicUnitId` is nullable on both create
    // and update schemas now, and only `null` survives `JSON.stringify` —
    // `undefined` keys are dropped, which the update schema treats as "leave
    // this field alone" rather than "clear it".
    const body = {
      ...values,
      academicUnitId: values.academicUnitId === ALL_UNITS ? null : values.academicUnitId,
    };

    try {
      const response = await fetch(
        isEditing
          ? `/api/settings/scholarships/${initialScholarship.id}`
          : "/api/settings/scholarships",
        {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not save. Please try again.");
        return;
      }

      toast.success(isEditing ? "Scholarship updated" : "Scholarship created");
      if (!isEditing) {
        router.push(`/scholarships/${payload.scholarship.id}`);
      } else {
        router.refresh();
      }
    } catch {
      toast.error("Could not reach the server. Please try again.");
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
      <div className="space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          placeholder="e.g. Merit Scholarship"
          aria-invalid={Boolean(errors.name)}
          {...register("name")}
        />
        {errors.name ? <p className="text-xs text-destructive">{errors.name.message}</p> : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="amount">Amount</Label>
          <Input
            id="amount"
            placeholder="e.g. 100% tuition, or Up to ₹50,000"
            aria-invalid={Boolean(errors.amount)}
            {...register("amount")}
          />
          {errors.amount ? (
            <p className="text-xs text-destructive">{errors.amount.message}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="academicUnitId">Applies to</Label>
          {/*
            A Radix Select is a button, not a native input, so it cannot be
            wired up with register(). Unlike `fee-structure-form.tsx`'s class
            picker, nothing here ever needs to change the selection on this
            form's behalf (there is no dependent field to invalidate it), so
            it stays uncontrolled — `defaultValue` only seeds what the
            control *displays*. `ALL_UNITS` is display-only and must never
            reach form state: `zodResolver` validates raw values before
            `onSubmit` ever runs, and `academicUnitId` is `objectIdString`,
            so a sentinel sitting in form state would fail validation and
            silently block every submit with no institution-wide unit
            selected. `onValueChange` maps it to `null` right here, before
            `setValue` ever writes it into react-hook-form — `null`, not
            `undefined`, because an omitted `academicUnitId` means "leave
            the existing scope alone" to the update API, while `null` is the
            one payload that actually clears it back to institution-wide.
            `JSON.stringify` would drop an `undefined` key entirely, so
            `null` is also the only one of the two that survives the fetch.
          */}
          <Select
            defaultValue={initialScholarship?.academicUnitId ?? ALL_UNITS}
            onValueChange={(value) =>
              setValue("academicUnitId", value === ALL_UNITS ? null : value, {
                shouldDirty: true,
              })
            }
          >
            <SelectTrigger id="academicUnitId" aria-invalid={Boolean(errors.academicUnitId)}>
              <SelectValue placeholder="Pick a class or course" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_UNITS}>All classes and courses</SelectItem>
              {units.map((unit) => (
                <SelectItem key={unit.id} value={unit.id}>
                  {unit.pathLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.academicUnitId ? (
            <p className="text-xs text-destructive">{errors.academicUnitId.message}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="criteria">Criteria</Label>
        <Textarea
          id="criteria"
          rows={4}
          placeholder="Who qualifies, and how to apply"
          aria-invalid={Boolean(errors.criteria)}
          {...register("criteria")}
        />
        {errors.criteria ? (
          <p className="text-xs text-destructive">{errors.criteria.message}</p>
        ) : null}
      </div>

      <Button type="submit" size="sm" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : isEditing ? "Save changes" : "Create scholarship"}
      </Button>
    </form>
  );
}
