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
import { createOfferSchema, updateOfferSchema } from "@/lib/validation/offer";
import { OFFER_KINDS, OFFER_KIND_LABELS, type OfferKind } from "@/lib/constants";
import type { OfferDTO } from "@/services/offer.service";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";

type Values = z.input<typeof createOfferSchema>;

/** Never a real academic-unit id — an ObjectId is 24 hex chars, so this sentinel
 * can't collide. Represents "institution-wide" (no `academicUnitId`) in the picker. */
const ALL_UNITS = "__all__";

/**
 * One form for both create and edit, mirroring `ScholarshipForm`. Unlike a
 * fee structure's class/course — immutable there because it carries a unique
 * (unit, year) index — an offer's `academicUnitId` carries no unique key, so
 * it stays editable in both modes and there is no read-only branch.
 */
export function OfferForm({
  initialOffer,
  units,
}: {
  /** `null` while creating — the same fields, saved by a POST instead of a PATCH. */
  initialOffer: OfferDTO | null;
  /** Effectively-active units to offer in the picker, for both create and edit. */
  units: AcademicUnitDTO[];
}) {
  const router = useRouter();
  const isEditing = initialOffer !== null;

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    // Same double-cast reasoning as `ScholarshipForm`: `updateOfferSchema`
    // (`createOfferSchema.partial()`) types every field optional, which is
    // not assignable to `Resolver<Values>` where `Values` — shared with the
    // create schema so one form/one `Values` type covers both cases — has
    // `title`, `kind` and `value` required. The real validation for whichever
    // mode is active still runs at submit time; only the static field-typing
    // differs.
    resolver: zodResolver(isEditing ? updateOfferSchema : createOfferSchema) as unknown as Resolver<Values>,
    defaultValues: {
      title: initialOffer?.title ?? "",
      description: initialOffer?.description ?? "",
      kind: (initialOffer?.kind as OfferKind) ?? "PERCENTAGE",
      value: initialOffer?.value ?? 0,
      code: initialOffer?.code ?? "",
      // No sentinel fallback here — `zodResolver` validates raw form values
      // before `onSubmit` ever runs, and `academicUnitId` is `objectIdString`
      // typed, so a sentinel sitting in form state would fail validation and
      // silently block every submit with no institution-wide unit selected.
      // See the Select below for where the sentinel actually lives.
      academicUnitId: initialOffer?.academicUnitId,
      // A `type="date"` input rejects a full ISO timestamp, so the DTO's
      // string is sliced to the `YYYY-MM-DD` prefix it accepts.
      validFrom: initialOffer?.validFrom?.slice(0, 10) ?? "",
      validUntil: initialOffer?.validUntil?.slice(0, 10) ?? "",
    },
  });

  const kind = watch("kind");

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
        isEditing ? `/api/settings/offers/${initialOffer.id}` : "/api/settings/offers",
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

      toast.success(isEditing ? "Offer updated" : "Offer created");
      if (!isEditing) {
        router.push(`/offers/${payload.offer.id}`);
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
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          placeholder="e.g. Early Bird Offer"
          aria-invalid={Boolean(errors.title)}
          {...register("title")}
        />
        {errors.title ? <p className="text-xs text-destructive">{errors.title.message}</p> : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="kind">Discount type</Label>
          {/*
            A Radix Select is a button, not a native input, so it cannot be
            wired up with register(). This one IS driven by watch/setValue —
            unlike the academicUnitId picker below — because the value
            field's label depends on which kind is selected, so this field
            needs to be read reactively rather than just written to.
          */}
          <Select
            value={kind}
            onValueChange={(value) => setValue("kind", value as OfferKind, { shouldDirty: true })}
          >
            <SelectTrigger id="kind" aria-invalid={Boolean(errors.kind)}>
              <SelectValue placeholder="Pick a discount type" />
            </SelectTrigger>
            <SelectContent>
              {OFFER_KINDS.map((offerKind) => (
                <SelectItem key={offerKind} value={offerKind}>
                  {OFFER_KIND_LABELS[offerKind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.kind ? <p className="text-xs text-destructive">{errors.kind.message}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="value">{kind === "PERCENTAGE" ? "Percentage off" : "Amount off (₹)"}</Label>
          <Input
            id="value"
            type="number"
            min={0}
            aria-invalid={Boolean(errors.value)}
            {...register("value", { valueAsNumber: true })}
          />
          {errors.value ? <p className="text-xs text-destructive">{errors.value.message}</p> : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="code">Code</Label>
          <Input
            id="code"
            placeholder="e.g. EARLY10"
            aria-invalid={Boolean(errors.code)}
            {...register("code")}
          />
          {errors.code ? <p className="text-xs text-destructive">{errors.code.message}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="academicUnitId">Applies to</Label>
          {/*
            Uncontrolled, same as `ScholarshipForm`'s picker: nothing here
            ever needs to change the selection on this form's behalf (there
            is no dependent field to invalidate it), so `defaultValue` only
            seeds what the control *displays*. `ALL_UNITS` is display-only
            and must never reach form state — `onValueChange` maps it to
            `null` right here, before `setValue` ever writes it into
            react-hook-form.
          */}
          <Select
            defaultValue={initialOffer?.academicUnitId ?? ALL_UNITS}
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="validFrom">Valid from</Label>
          <Input
            id="validFrom"
            type="date"
            aria-invalid={Boolean(errors.validFrom)}
            {...register("validFrom")}
          />
          {errors.validFrom ? (
            <p className="text-xs text-destructive">{errors.validFrom.message}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="validUntil">Valid until</Label>
          <Input
            id="validUntil"
            type="date"
            aria-invalid={Boolean(errors.validUntil)}
            {...register("validUntil")}
          />
          {errors.validUntil ? (
            <p className="text-xs text-destructive">{errors.validUntil.message}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          rows={4}
          placeholder="What this offer is, and any terms"
          aria-invalid={Boolean(errors.description)}
          {...register("description")}
        />
        {errors.description ? (
          <p className="text-xs text-destructive">{errors.description.message}</p>
        ) : null}
      </div>

      <Button type="submit" size="sm" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : isEditing ? "Save changes" : "Create offer"}
      </Button>
    </form>
  );
}
