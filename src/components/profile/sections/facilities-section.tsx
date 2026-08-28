"use client";

import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, TriangleAlert, X } from "lucide-react";
import type { z } from "zod";
import { updateProfileSchema } from "@/lib/validation/institution";
import {
  FACILITY_GROUPS,
  isFacilitySelected,
  UNMAPPABLE_LEGACY_CODES,
  withoutFacility,
} from "@/lib/profile/facilities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  FieldGroup,
  reportSectionErrors,
  SectionForm,
  toFacilityCode,
  type SectionProps,
} from "@/components/profile/section-form";

type Values = z.input<typeof updateProfileSchema>;
type Parsed = z.output<typeof updateProfileSchema>;
type Facility = NonNullable<Values["facilities"]>[number];

const MAX_FACILITIES = 40;

/**
 * Explains, per legacy code, why `UNMAPPABLE_LEGACY_CODES`
 * (`lib/profile/facilities.ts`) couldn't be auto-converted — reasons an
 * admin needs to actually act on the notice, not just a code. Deliberately
 * NOT auto-converted here either: doing so from the UI would be the same
 * guess `LEGACY_FACILITY_CODE_MAP` already refuses to make, by another route.
 */
const UNMAPPABLE_FACILITY_NOTES: Record<string, string> = {
  HOSTEL:
    "Imported from your old listing as \"HOSTEL\", which didn't record which genders are accommodated. Remove this entry and add Boys Hostel and/or Girls Hostel instead — whichever actually apply.",
  SPORTS:
    "Imported from your old listing as \"SPORTS\", a general category rather than a specific facility. Remove this entry and add the specific sports facilities you offer instead — e.g. Playground, Swimming Pool, Basketball Court.",
};

/**
 * Facilities are one array, replaced wholesale on save. The suggestions are a
 * convenience: any code the admin invents is equally valid to the schema.
 */
export function FacilitiesSection({ profile, onSave, onDirtyChange }: SectionProps) {
  const [draft, setDraft] = useState("");

  const {
    control,
    handleSubmit,
    getValues,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: {
      facilities: (profile.facilities ?? []).map((facility) => ({
        code: facility.code,
        label: facility.label,
        available: facility.available !== false,
        note: facility.note ?? "",
      })),
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
      title="Facilities"
      description="Three or more counts towards your completion score. Every one you list is published."
      onSubmit={handleSubmit(onSubmit, reportSectionErrors)}
      isSubmitting={isSubmitting}
      isDirty={isDirty}
    >
      <Controller
        control={control}
        name="facilities"
        render={({ field }) => {
          const selected: Facility[] = field.value ?? [];
          const selectedCodes = selected.map((entry) => entry.code);
          // A stored legacy code (e.g. `LIBRARY`) reads as equivalent to the
          // new code it maps to (`library`) for both the chip's pressed state
          // and this duplicate guard — see `isFacilitySelected`'s doc comment
          // for why plain equality alone is wrong here.
          const has = (code: string) => isFacilitySelected(selectedCodes, code);

          function addFacility(code: string, label: string) {
            if (!code || !label) return;
            if (has(code) || selected.length >= MAX_FACILITIES) return;
            field.onChange([...selected, { code, label, available: true, note: "" }]);
          }

          function add(label: string) {
            const trimmed = label.trim();
            addFacility(toFacilityCode(trimmed), trimmed);
          }

          function update(index: number, patch: Partial<Facility>) {
            field.onChange(
              selected.map((entry, position) =>
                position === index ? { ...entry, ...patch } : entry,
              ),
            );
          }

          return (
            <>
              <FieldGroup
                title="Suggested"
                description="Tap to add or remove. These are only shortcuts — nothing is limited to this list."
              >
                <div className="space-y-3">
                  {FACILITY_GROUPS.map((group) => (
                    <div key={group.group} className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">{group.group}</p>
                      <ul className="flex flex-wrap gap-1.5">
                        {group.items.map((suggestion) => {
                          const on = has(suggestion.code);
                          return (
                            <li key={suggestion.code}>
                              <button
                                type="button"
                                aria-pressed={on}
                                disabled={!on && selected.length >= MAX_FACILITIES}
                                onClick={() =>
                                  on
                                    ? // Legacy-aware, exactly as `has()` above
                                      // is: a chip pressed against a stored
                                      // `LIBRARY` row must drop that row, which
                                      // a plain `!==` on `library` never does.
                                      field.onChange(withoutFacility(selected, suggestion.code))
                                    : addFacility(suggestion.code, suggestion.label)
                                }
                                className={cn(
                                  "rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
                                  on
                                    ? "border-transparent bg-foreground text-background"
                                    : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                                )}
                              >
                                {suggestion.label}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="facilities-draft">Add your own</Label>
                  <div className="flex gap-2">
                    <Input
                      id="facilities-draft"
                      value={draft}
                      placeholder="Robotics Lab"
                      maxLength={80}
                      disabled={selected.length >= MAX_FACILITIES}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          add(draft);
                          setDraft("");
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!draft.trim() || selected.length >= MAX_FACILITIES}
                      onClick={() => {
                        add(draft);
                        setDraft("");
                      }}
                    >
                      <Plus className="size-3.5" />
                      Add
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The code is derived from the label:{" "}
                    <span className="font-mono text-[11px]">
                      {toFacilityCode(draft) || "robotics_lab"}
                    </span>
                    . {selected.length} of {MAX_FACILITIES} used.
                  </p>
                </div>
              </FieldGroup>

              <FieldGroup title={`Your facilities (${selected.length})`}>
                {selected.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                    No facilities listed yet. Add three to earn the facilities part of your score.
                  </p>
                ) : (
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {selected.map((facility, index) => {
                      const unmappable = UNMAPPABLE_LEGACY_CODES.includes(facility.code);

                      return (
                        <li key={facility.code} className="space-y-2 px-3 py-3">
                          <div className="flex flex-wrap items-center gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <p className="truncate text-sm font-medium">{facility.label}</p>
                                {unmappable ? (
                                  <Badge variant="outline" className="gap-1">
                                    <TriangleAlert className="size-3" />
                                    Needs re-picking
                                  </Badge>
                                ) : null}
                              </div>
                              <p className="font-mono text-[11px] text-muted-foreground">
                                {facility.code}
                              </p>
                            </div>

                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Switch
                                checked={facility.available !== false}
                                onCheckedChange={(checked) => update(index, { available: checked })}
                                aria-label={`${facility.label} available`}
                              />
                              {facility.available !== false ? "Available" : "Not available"}
                            </label>

                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove ${facility.label}`}
                              onClick={() =>
                                field.onChange(
                                  selected.filter((entry) => entry.code !== facility.code),
                                )
                              }
                            >
                              <X className="size-3.5" />
                            </Button>
                          </div>

                          {unmappable ? (
                            <p className="text-xs text-muted-foreground">
                              {UNMAPPABLE_FACILITY_NOTES[facility.code]}
                            </p>
                          ) : null}

                          <Input
                            value={facility.note ?? ""}
                            placeholder="Note — e.g. 12,000 titles, open until 6pm"
                            maxLength={200}
                            aria-label={`Note for ${facility.label}`}
                            onChange={(event) => update(index, { note: event.target.value })}
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}

                {errors.facilities?.message ? (
                  <p role="alert" className="text-xs text-foreground">
                    {errors.facilities.message}
                  </p>
                ) : null}
              </FieldGroup>
            </>
          );
        }}
      />
    </SectionForm>
  );
}
