"use client";

import { useRouter } from "next/navigation";
import { useFieldArray, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createScholarshipSchema, updateScholarshipSchema } from "@/lib/validation/scholarship";
import { pruneEmptyScholarshipSubdocs } from "@/lib/scholarship/prune-empty-subdocs";
import type { ScholarshipDTO } from "@/services/scholarship.service";
import type { AcademicUnitDTO } from "@/services/academic-structure.service";
import {
  HUB_SCHOLARSHIP_CATEGORIES,
  HUB_EDUCATION_LEVELS,
  HUB_GENDERS,
  HUB_COMMUNITY_CATEGORIES,
  HUB_QUESTION_TYPES,
  HUB_APPLICATION_MODES,
  HUB_STATE_CODES,
  HUB_KA_DISTRICT_CODES,
} from "@/lib/scholarship-hub/vocabulary";

type Values = z.input<typeof createScholarshipSchema>;
/** `Values["eligibility"]` is itself optional (`eligibilitySchema.optional()`),
 * so every enum-typed sub-field below is cast through this non-nullable
 * alias rather than through `Values["eligibility"]` directly. */
type EligibilityValues = NonNullable<Values["eligibility"]>;

/** Never a real academic-unit id — an ObjectId is 24 hex chars, so this sentinel
 * can't collide. Represents "institution-wide" (no `academicUnitId`) in the picker. */
const ALL_UNITS = "__all__";

// --- Small parsers for the free-text list fields below -----------------------
//
// None of Task 4's array fields (`tags`, `eligibility.classesOrCourses`,
// `eligibility.streams`, `eligibility.otherCriteria`, `applicationSteps`) are
// enum-constrained — only `categories`/`eligibility.stateCodes`/
// `eligibility.educationLevels`/`eligibility.genders`/
// `eligibility.communityCategories` are, and those are rendered as
// `VocabCheckboxGroup` below instead. A free-text list needs no vocabulary,
// so it is edited as a single delimited string rather than a repeater —
// commas for short, single-line values (tags, class/course names, streams),
// newlines for prose-shaped ones (criteria notes, ordered application steps).
function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * One free-text list field, uncontrolled like `academicUnitId`'s Select is
 * NOT — this one really does stay uncontrolled (`defaultValue` only, no
 * `value`) so a delimiter typed mid-edit (a trailing comma, a blank line) is
 * never reformatted out from under the caret. Parsing happens on `onChange`
 * and is written straight into `react-hook-form` state via `setValue`; the
 * input's own displayed text is independent of that array afterwards.
 */
function ListField({
  id,
  label,
  initial,
  placeholder,
  hint,
  multiline,
  onChange,
}: {
  id: string;
  label: string;
  initial: string[];
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  onChange: (next: string[]) => void;
}) {
  const joined = initial.join(multiline ? "\n" : ", ");
  const parse = multiline ? parseLines : parseCommaList;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {multiline ? (
        <Textarea
          id={id}
          rows={3}
          defaultValue={joined}
          placeholder={placeholder}
          onChange={(event) => onChange(parse(event.target.value))}
        />
      ) : (
        <Input
          id={id}
          defaultValue={joined}
          placeholder={placeholder}
          onChange={(event) => onChange(parse(event.target.value))}
        />
      )}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * One vendored-vocabulary multi-select, rendered as a checkbox grid — the
 * same shape `vacancies-section.tsx`'s `BenefitsEditor` uses for a fixed
 * option list, generalised to any `HUB_*` vocabulary (Task 1). Genuinely
 * controlled (`checked` from `selected`, not `defaultChecked`) because,
 * unlike `ListField` above, a checkbox's own state has nothing worth
 * preserving independently of the array it represents.
 */
function VocabCheckboxGroup<T extends string>({
  groupId,
  legend,
  options,
  selected,
  onChange,
}: {
  groupId: string;
  legend: string;
  options: readonly T[];
  selected: T[];
  onChange: (next: T[]) => void;
}) {
  function toggle(option: T, checked: boolean) {
    onChange(checked ? [...selected, option] : selected.filter((value) => value !== option));
  }

  return (
    // A <fieldset>/<legend> pair, not a <p> heading, so a screen reader on
    // any one checkbox in a multi-option group (States has 37, KA districts
    // 31) still announces the group's name. `border-0 p-0 m-0` resets the
    // browser's default fieldset chrome (border/margin/padding) and the
    // legend's own reset keeps its look identical to the `<p>` it replaces —
    // markup/semantics only, no visual change.
    <fieldset className="m-0 space-y-1.5 border-0 p-0">
      <legend className="p-0 text-sm font-medium">{legend}</legend>
      <div className="grid max-h-40 gap-x-4 gap-y-2 overflow-y-auto rounded-md border border-border p-2.5 sm:grid-cols-3">
        {options.map((option) => {
          const id = `${groupId}-${option}`;
          return (
            <div key={option} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={selected.includes(option)}
                onCheckedChange={(checked) => toggle(option, checked === true)}
              />
              <Label htmlFor={id} className="text-sm font-normal">
                {option}
              </Label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * One for the create and edit form, mirroring `FeeStructureForm`. Unlike a
 * fee structure's class/course — immutable there because it carries a unique
 * (unit, year) index — a scholarship's `academicUnitId` carries no unique
 * key, so it stays editable in both modes and there is no read-only branch.
 *
 * The structured fields below (Task 3's model, Task 4's validation) are all
 * optional at this layer — a draft needs only `name` — and only matter once
 * an institution tries to publish to Scholarship Hub, where
 * `scholarshipHubMissingFields` is the actual gate. Sourcing every enum
 * picker's options from `@/lib/scholarship-hub/vocabulary` (Task 1) rather
 * than hand-copying the lists keeps this form and the Hub's own validation
 * from silently drifting apart.
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
    control,
    handleSubmit,
    setValue,
    watch,
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
      summary: initialScholarship?.summary ?? "",
      description: initialScholarship?.description ?? "",
      // Cast at the DTO boundary, same reasoning throughout this block: the
      // DTO's arrays are plain `string[]` (read back from JSON with no
      // narrowing), while `Values` — derived from the Hub vocabulary enums —
      // wants the literal-union element type. A value that somehow drifted
      // off the vendored vocabulary would simply fail to render as a checked
      // box in `VocabCheckboxGroup` below, never crash.
      categories: (initialScholarship?.categories ?? []) as Values["categories"],
      tags: initialScholarship?.tags ?? [],
      benefits: {
        amountMin: initialScholarship?.benefits?.amountMin,
        amountMax: initialScholarship?.benefits?.amountMax,
        stipendMonthly: initialScholarship?.benefits?.stipendMonthly,
        awards: initialScholarship?.benefits?.awards,
        tuitionWaiver: initialScholarship?.benefits?.tuitionWaiver ?? false,
      },
      eligibility: {
        stateCodes: (initialScholarship?.eligibility?.stateCodes ?? []) as EligibilityValues["stateCodes"],
        districtCodes: initialScholarship?.eligibility?.districtCodes ?? [],
        educationLevels: (initialScholarship?.eligibility?.educationLevels ??
          []) as EligibilityValues["educationLevels"],
        classesOrCourses: initialScholarship?.eligibility?.classesOrCourses ?? [],
        streams: initialScholarship?.eligibility?.streams ?? [],
        genders: (initialScholarship?.eligibility?.genders ?? []) as EligibilityValues["genders"],
        ageMin: initialScholarship?.eligibility?.ageMin,
        ageMax: initialScholarship?.eligibility?.ageMax,
        minPercentage: initialScholarship?.eligibility?.minPercentage,
        maxAnnualIncome: initialScholarship?.eligibility?.maxAnnualIncome,
        communityCategories: (initialScholarship?.eligibility?.communityCategories ??
          []) as EligibilityValues["communityCategories"],
        disabilityRequired: initialScholarship?.eligibility?.disabilityRequired ?? false,
        otherCriteria: initialScholarship?.eligibility?.otherCriteria ?? [],
      },
      applicationMode: (initialScholarship?.applicationMode ??
        "platform") as Values["applicationMode"],
      externalUrl: initialScholarship?.externalUrl ?? "",
      requiredDocuments: initialScholarship?.requiredDocuments ?? [],
      customQuestions: (initialScholarship?.customQuestions ?? []) as Values["customQuestions"],
      applicationSteps: initialScholarship?.applicationSteps ?? [],
      dates: {
        // `<input type="date">` needs `YYYY-MM-DD`; the DTO's dates are full
        // ISO timestamps, so the display value is just their date portion —
        // `scholarshipHubMissingFields` only ever compares against midnight
        // anyway (`new Date("2026-10-01")` is a real, valid deadline).
        opensAt: initialScholarship?.dates?.opensAt?.slice(0, 10) ?? "",
        closesAt: initialScholarship?.dates?.closesAt?.slice(0, 10) ?? "",
        resultAt: initialScholarship?.dates?.resultAt?.slice(0, 10) ?? "",
      },
      selectionProcess: initialScholarship?.selectionProcess ?? "",
      terms: initialScholarship?.terms ?? "",
      faqs: initialScholarship?.faqs ?? [],
      sourceUrl: initialScholarship?.sourceUrl ?? "",
    },
  });

  const requiredDocuments = useFieldArray({ control, name: "requiredDocuments" });
  const customQuestions = useFieldArray({ control, name: "customQuestions" });
  const faqs = useFieldArray({ control, name: "faqs" });

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
    // `pruneEmptyScholarshipSubdocs` drops `benefits`/`eligibility`/`dates`
    // when the section was never touched: `defaultValues` above seeds them
    // as non-empty sub-objects (booleans `false`, arrays `[]`), and RHF keeps
    // those keys in form state even when the user opens nothing. Since
    // `JSON.stringify` only drops keys whose *value* is `undefined` (not
    // `false`/`[]`), submitting them as-is would give every save a spurious,
    // mostly-empty sub-document — a data-hygiene regression against the
    // pre-Task-10 baseline, where an untouched section left the field
    // genuinely absent. A section the user DID populate survives untouched.
    const body = pruneEmptyScholarshipSubdocs({
      ...values,
      academicUnitId: values.academicUnitId === ALL_UNITS ? null : values.academicUnitId,
    });

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
      <FormSection title="Basics">
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

        <div className="space-y-1.5">
          <Label htmlFor="summary">Summary</Label>
          <Textarea
            id="summary"
            rows={2}
            maxLength={500}
            placeholder="One or two sentences — shown wherever this listing is previewed"
            aria-invalid={Boolean(errors.summary)}
            {...register("summary")}
          />
          {errors.summary ? (
            <p className="text-xs text-destructive">{errors.summary.message}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            rows={6}
            maxLength={20000}
            placeholder="The full write-up a student sees on the listing page"
            aria-invalid={Boolean(errors.description)}
            {...register("description")}
          />
          {errors.description ? (
            <p className="text-xs text-destructive">{errors.description.message}</p>
          ) : null}
        </div>

        <VocabCheckboxGroup
          groupId="categories"
          legend="Categories"
          options={HUB_SCHOLARSHIP_CATEGORIES}
          selected={watch("categories") ?? []}
          onChange={(next) => setValue("categories", next, { shouldDirty: true })}
        />

        <ListField
          id="tags"
          label="Tags"
          initial={initialScholarship?.tags ?? []}
          placeholder="e.g. Karnataka, Girls, STEM"
          hint="Comma-separated."
          onChange={(next) => setValue("tags", next, { shouldDirty: true })}
        />
      </FormSection>

      <FormSection
        title="Benefits"
        description="What the scholarship actually gives a student. At least one is needed to publish to Scholarship Hub."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="benefits.amountMin">Amount — minimum (₹)</Label>
            <Input
              id="benefits.amountMin"
              type="number"
              inputMode="numeric"
              min={0}
              placeholder="Optional"
              aria-invalid={Boolean(errors.benefits?.amountMin)}
              {...register("benefits.amountMin", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="benefits.amountMax">Amount — maximum (₹)</Label>
            <Input
              id="benefits.amountMax"
              type="number"
              inputMode="numeric"
              min={0}
              placeholder="Optional"
              aria-invalid={Boolean(errors.benefits?.amountMax)}
              {...register("benefits.amountMax", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="benefits.stipendMonthly">Monthly stipend (₹)</Label>
            <Input
              id="benefits.stipendMonthly"
              type="number"
              inputMode="numeric"
              min={0}
              placeholder="Optional"
              aria-invalid={Boolean(errors.benefits?.stipendMonthly)}
              {...register("benefits.stipendMonthly", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="benefits.awards">Number of awards</Label>
            <Input
              id="benefits.awards"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              placeholder="Optional"
              aria-invalid={Boolean(errors.benefits?.awards)}
              {...register("benefits.awards", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="benefits.tuitionWaiver"
            checked={watch("benefits.tuitionWaiver") ?? false}
            onCheckedChange={(checked) =>
              setValue("benefits.tuitionWaiver", checked === true, { shouldDirty: true })
            }
          />
          <Label htmlFor="benefits.tuitionWaiver" className="text-sm font-normal">
            Includes a full or partial tuition waiver
          </Label>
        </div>
      </FormSection>

      <FormSection title="Eligibility">
        <VocabCheckboxGroup
          groupId="eligibility-state"
          legend="States"
          options={HUB_STATE_CODES}
          selected={watch("eligibility.stateCodes") ?? []}
          onChange={(next) => setValue("eligibility.stateCodes", next, { shouldDirty: true })}
        />

        <VocabCheckboxGroup
          groupId="eligibility-district"
          legend="Districts (Karnataka)"
          options={HUB_KA_DISTRICT_CODES}
          selected={watch("eligibility.districtCodes") ?? []}
          onChange={(next) => setValue("eligibility.districtCodes", next, { shouldDirty: true })}
        />

        <VocabCheckboxGroup
          groupId="eligibility-level"
          legend="Education levels"
          options={HUB_EDUCATION_LEVELS}
          selected={watch("eligibility.educationLevels") ?? []}
          onChange={(next) => setValue("eligibility.educationLevels", next, { shouldDirty: true })}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <ListField
            id="eligibility.classesOrCourses"
            label="Classes or courses"
            initial={initialScholarship?.eligibility?.classesOrCourses ?? []}
            placeholder="e.g. Class 10, B.Tech CSE"
            hint="Comma-separated. Leave blank when scoped by 'Applies to' above instead."
            onChange={(next) =>
              setValue("eligibility.classesOrCourses", next, { shouldDirty: true })
            }
          />
          <ListField
            id="eligibility.streams"
            label="Streams"
            initial={initialScholarship?.eligibility?.streams ?? []}
            placeholder="e.g. Science, Commerce"
            hint="Comma-separated."
            onChange={(next) => setValue("eligibility.streams", next, { shouldDirty: true })}
          />
        </div>

        <VocabCheckboxGroup
          groupId="eligibility-gender"
          legend="Genders"
          options={HUB_GENDERS}
          selected={watch("eligibility.genders") ?? []}
          onChange={(next) => setValue("eligibility.genders", next, { shouldDirty: true })}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="eligibility.ageMin">Age — minimum</Label>
            <Input
              id="eligibility.ageMin"
              type="number"
              inputMode="numeric"
              min={0}
              placeholder="Optional"
              {...register("eligibility.ageMin", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eligibility.ageMax">Age — maximum</Label>
            <Input
              id="eligibility.ageMax"
              type="number"
              inputMode="numeric"
              min={0}
              placeholder="Optional"
              {...register("eligibility.ageMax", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eligibility.minPercentage">Minimum percentage</Label>
            <Input
              id="eligibility.minPercentage"
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              placeholder="Optional"
              {...register("eligibility.minPercentage", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eligibility.maxAnnualIncome">Maximum annual family income (₹)</Label>
            <Input
              id="eligibility.maxAnnualIncome"
              type="number"
              inputMode="numeric"
              min={0}
              placeholder="Optional"
              {...register("eligibility.maxAnnualIncome", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>
        </div>

        <VocabCheckboxGroup
          groupId="eligibility-community"
          legend="Community categories"
          options={HUB_COMMUNITY_CATEGORIES}
          selected={watch("eligibility.communityCategories") ?? []}
          onChange={(next) =>
            setValue("eligibility.communityCategories", next, { shouldDirty: true })
          }
        />

        <div className="flex items-center gap-2">
          <Checkbox
            id="eligibility.disabilityRequired"
            checked={watch("eligibility.disabilityRequired") ?? false}
            onCheckedChange={(checked) =>
              setValue("eligibility.disabilityRequired", checked === true, { shouldDirty: true })
            }
          />
          <Label htmlFor="eligibility.disabilityRequired" className="text-sm font-normal">
            Requires a disability certificate
          </Label>
        </div>

        <ListField
          id="eligibility.otherCriteria"
          label="Other criteria"
          initial={initialScholarship?.eligibility?.otherCriteria ?? []}
          placeholder="One criterion per line"
          multiline
          hint="One per line."
          onChange={(next) => setValue("eligibility.otherCriteria", next, { shouldDirty: true })}
        />
      </FormSection>

      <FormSection title="Application">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="applicationMode">How students apply</Label>
            <Select
              defaultValue={initialScholarship?.applicationMode ?? "platform"}
              onValueChange={(value) =>
                setValue(
                  "applicationMode",
                  value as (typeof HUB_APPLICATION_MODES)[number],
                  { shouldDirty: true },
                )
              }
            >
              <SelectTrigger id="applicationMode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HUB_APPLICATION_MODES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value === "platform" ? "On this platform" : "On an external site"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="externalUrl">External application URL</Label>
            <Input
              id="externalUrl"
              type="url"
              placeholder="https://…"
              aria-invalid={Boolean(errors.externalUrl)}
              {...register("externalUrl")}
            />
            {errors.externalUrl ? (
              <p className="text-xs text-destructive">{errors.externalUrl.message}</p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Required to publish to Scholarship Hub when applying externally.
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Required documents</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                requiredDocuments.append({ key: "", label: "", required: true })
              }
            >
              <Plus className="size-3.5" />
              Add document
            </Button>
          </div>
          {requiredDocuments.fields.length === 0 ? (
            <p className="text-xs text-muted-foreground">No documents required yet.</p>
          ) : (
            <div className="space-y-2">
              {requiredDocuments.fields.map((field, index) => (
                <div
                  key={field.id}
                  className="grid items-end gap-2 rounded-md border border-border p-2.5 sm:grid-cols-[1fr_1fr_auto_auto]"
                >
                  <div className="space-y-1">
                    <Label htmlFor={`requiredDocuments.${index}.key`} className="text-xs">
                      Key
                    </Label>
                    <Input
                      id={`requiredDocuments.${index}.key`}
                      placeholder="marksheet"
                      {...register(`requiredDocuments.${index}.key` as const)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`requiredDocuments.${index}.label`} className="text-xs">
                      Label
                    </Label>
                    <Input
                      id={`requiredDocuments.${index}.label`}
                      placeholder="Marksheet"
                      {...register(`requiredDocuments.${index}.label` as const)}
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Checkbox
                      id={`requiredDocuments.${index}.required`}
                      checked={watch(`requiredDocuments.${index}.required` as const) ?? true}
                      onCheckedChange={(checked) =>
                        setValue(
                          `requiredDocuments.${index}.required` as const,
                          checked === true,
                          { shouldDirty: true },
                        )
                      }
                    />
                    <Label
                      htmlFor={`requiredDocuments.${index}.required`}
                      className="text-xs font-normal"
                    >
                      Required
                    </Label>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => requiredDocuments.remove(index)}
                    aria-label="Remove document"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Custom questions</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                customQuestions.append({
                  key: "",
                  label: "",
                  type: HUB_QUESTION_TYPES[0],
                  options: [],
                  required: false,
                  helpText: "",
                })
              }
            >
              <Plus className="size-3.5" />
              Add question
            </Button>
          </div>
          {customQuestions.fields.length === 0 ? (
            <p className="text-xs text-muted-foreground">No custom questions yet.</p>
          ) : (
            <div className="space-y-2">
              {customQuestions.fields.map((field, index) => (
                <div key={field.id} className="space-y-2 rounded-md border border-border p-2.5">
                  <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_140px_auto]">
                    <div className="space-y-1">
                      <Label htmlFor={`customQuestions.${index}.key`} className="text-xs">
                        Key
                      </Label>
                      <Input
                        id={`customQuestions.${index}.key`}
                        placeholder="whyApply"
                        {...register(`customQuestions.${index}.key` as const)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`customQuestions.${index}.label`} className="text-xs">
                        Question
                      </Label>
                      <Input
                        id={`customQuestions.${index}.label`}
                        placeholder="Why are you applying?"
                        {...register(`customQuestions.${index}.label` as const)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`customQuestions.${index}.type`} className="text-xs">
                        Type
                      </Label>
                      <Select
                        value={watch(`customQuestions.${index}.type` as const)}
                        onValueChange={(value) =>
                          setValue(
                            `customQuestions.${index}.type` as const,
                            value as (typeof HUB_QUESTION_TYPES)[number],
                            { shouldDirty: true },
                          )
                        }
                      >
                        <SelectTrigger id={`customQuestions.${index}.type`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {HUB_QUESTION_TYPES.map((value) => (
                            <SelectItem key={value} value={value}>
                              {value}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => customQuestions.remove(index)}
                      aria-label="Remove question"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <div className="space-y-1">
                      <Label htmlFor={`customQuestions.${index}.options`} className="text-xs">
                        Options (for select/radio/checkbox)
                      </Label>
                      <Input
                        id={`customQuestions.${index}.options`}
                        placeholder="Comma-separated"
                        defaultValue={(field.options ?? []).join(", ")}
                        onChange={(event) =>
                          setValue(
                            `customQuestions.${index}.options` as const,
                            parseCommaList(event.target.value),
                            { shouldDirty: true },
                          )
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`customQuestions.${index}.helpText`} className="text-xs">
                        Help text
                      </Label>
                      <Input
                        id={`customQuestions.${index}.helpText`}
                        placeholder="Optional"
                        {...register(`customQuestions.${index}.helpText` as const)}
                      />
                    </div>
                    <div className="flex items-center gap-1.5 self-end pb-1.5">
                      <Checkbox
                        id={`customQuestions.${index}.required`}
                        checked={watch(`customQuestions.${index}.required` as const) ?? false}
                        onCheckedChange={(checked) =>
                          setValue(
                            `customQuestions.${index}.required` as const,
                            checked === true,
                            { shouldDirty: true },
                          )
                        }
                      />
                      <Label
                        htmlFor={`customQuestions.${index}.required`}
                        className="text-xs font-normal"
                      >
                        Required
                      </Label>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <ListField
          id="applicationSteps"
          label="Application steps"
          initial={initialScholarship?.applicationSteps ?? []}
          placeholder="One step per line, in order"
          multiline
          hint="One per line, in the order a student should follow them."
          onChange={(next) => setValue("applicationSteps", next, { shouldDirty: true })}
        />
      </FormSection>

      <FormSection title="Dates">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="dates.opensAt">Opens</Label>
            <Input
              id="dates.opensAt"
              type="date"
              {...register("dates.opensAt", {
                setValueAs: (value) => (value === "" ? undefined : value),
              })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dates.closesAt">Closing date</Label>
            <Input
              id="dates.closesAt"
              type="date"
              {...register("dates.closesAt", {
                setValueAs: (value) => (value === "" ? undefined : value),
              })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dates.resultAt">Result</Label>
            <Input
              id="dates.resultAt"
              type="date"
              {...register("dates.resultAt", {
                setValueAs: (value) => (value === "" ? undefined : value),
              })}
            />
          </div>
        </div>
      </FormSection>

      <FormSection title="Details">
        <div className="space-y-1.5">
          <Label htmlFor="selectionProcess">Selection process</Label>
          <Textarea
            id="selectionProcess"
            rows={4}
            maxLength={5000}
            placeholder="How winners are chosen"
            {...register("selectionProcess")}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="terms">Terms and conditions</Label>
          <Textarea
            id="terms"
            rows={4}
            maxLength={20000}
            placeholder="Any fine print"
            {...register("terms")}
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">FAQs</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => faqs.append({ q: "", a: "" })}
            >
              <Plus className="size-3.5" />
              Add FAQ
            </Button>
          </div>
          {faqs.fields.length === 0 ? (
            <p className="text-xs text-muted-foreground">No FAQs yet.</p>
          ) : (
            <div className="space-y-2">
              {faqs.fields.map((field, index) => (
                <div key={field.id} className="space-y-2 rounded-md border border-border p-2.5">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 space-y-1">
                      <Label htmlFor={`faqs.${index}.q`} className="text-xs">
                        Question
                      </Label>
                      <Input
                        id={`faqs.${index}.q`}
                        {...register(`faqs.${index}.q` as const)}
                      />
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="mt-5 text-destructive"
                      onClick={() => faqs.remove(index)}
                      aria-label="Remove FAQ"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`faqs.${index}.a`} className="text-xs">
                      Answer
                    </Label>
                    <Textarea
                      id={`faqs.${index}.a`}
                      rows={2}
                      {...register(`faqs.${index}.a` as const)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sourceUrl">Source URL</Label>
          <Input
            id="sourceUrl"
            type="url"
            placeholder="https://… (where this scholarship is officially announced)"
            aria-invalid={Boolean(errors.sourceUrl)}
            {...register("sourceUrl")}
          />
          {errors.sourceUrl ? (
            <p className="text-xs text-destructive">{errors.sourceUrl.message}</p>
          ) : null}
        </div>
      </FormSection>

      <Button type="submit" size="sm" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : isEditing ? "Save changes" : "Create scholarship"}
      </Button>
    </form>
  );
}
