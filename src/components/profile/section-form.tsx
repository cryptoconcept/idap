"use client";

import { useId, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import type { FieldErrors, FieldValues } from "react-hook-form";
import { cn } from "@/lib/utils";
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
import type { ProfileDTO } from "@/lib/types";

/**
 * The field-row composition every profile section is built from. One card, one
 * `react-hook-form` instance, one explicit save — the sections differ only in
 * which fields they own.
 */
export function SectionForm({
  title,
  description,
  onSubmit,
  isSubmitting,
  isDirty,
  children,
}: {
  title: string;
  description?: string;
  onSubmit: React.FormEventHandler<HTMLFormElement>;
  isSubmitting: boolean;
  isDirty: boolean;
  children: React.ReactNode;
}) {
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="space-y-5 rounded-lg border border-border bg-card p-4 sm:p-5"
    >
      <div className="space-y-1">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>

      <div className="space-y-6">{children}</div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button type="submit" size="sm" disabled={isSubmitting || !isDirty}>
          {isSubmitting ? "Saving…" : "Save section"}
        </Button>
        <p className="text-xs text-muted-foreground">
          {isSubmitting
            ? "Saving this section…"
            : isDirty
              ? "Unsaved changes in this section."
              : "Only this section's fields are sent when you save."}
        </p>
      </div>
    </form>
  );
}

/** A titled group of fields inside a section. */
export function FieldGroup({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      {title ? (
        <div className="space-y-1">
          <h3 className="eyebrow">{title}</h3>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function FieldRow({
  columns = 2,
  children,
}: {
  columns?: 1 | 2 | 3;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid gap-4",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-3",
      )}
    >
      {children}
    </div>
  );
}

function FieldMessage({ error, hint }: { error?: string; hint?: string }) {
  if (error) {
    return (
      <p role="alert" className="text-xs text-foreground">
        {error}
      </p>
    );
  }
  return hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null;
}

/** `ref` arrives through the spread, so `register(...)` works unchanged. */
export function TextField({
  id,
  label,
  error,
  hint,
  className,
  ...props
}: React.ComponentProps<typeof Input> & {
  id: string;
  label: string;
  error?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} aria-invalid={Boolean(error)} className={className} {...props} />
      <FieldMessage error={error} hint={hint} />
    </div>
  );
}

export function TextareaField({
  id,
  label,
  error,
  hint,
  ...props
}: React.ComponentProps<typeof Textarea> & {
  id: string;
  label: string;
  error?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} aria-invalid={Boolean(error)} {...props} />
      <FieldMessage error={error} hint={hint} />
    </div>
  );
}

/**
 * Controlled select for the enum fields. There is no "clear" option: the API
 * merges a patch and never unsets, so an empty choice would be a lie.
 */
export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  placeholder = "Select…",
  error,
  hint,
}: {
  id: string;
  label: string;
  value?: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  error?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value ?? ""} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full" aria-invalid={Boolean(error)}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldMessage error={error} hint={hint} />
    </div>
  );
}

/**
 * A list of short strings (mediums, classes, courses) edited as chips. Enter or
 * a comma commits the entry; the array replaces wholesale on save, which is the
 * editing model the API expects for arrays.
 */
export function TagsField({
  id,
  label,
  values,
  onChange,
  placeholder,
  error,
  hint,
  max = 60,
  maxLength,
}: {
  id: string;
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  error?: string;
  hint?: string;
  /** Most entries the list may hold. */
  max?: number;
  /** Longest a single entry may be — the schema's own limit for this list. */
  maxLength: number;
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();

  function commit(raw: string) {
    const entries = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (entries.length === 0) return;

    const next = [...values];
    for (const entry of entries) {
      if (next.length >= max) break;
      if (!next.some((existing) => existing.toLowerCase() === entry.toLowerCase())) {
        next.push(entry);
      }
    }
    onChange(next);
    setDraft("");
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>

      {values.length > 0 ? (
        <ul id={listId} className="flex flex-wrap gap-1.5 pt-0.5 pb-1">
          {values.map((value) => (
            <li key={value}>
              <span className="inline-flex items-center gap-1 rounded-full border border-foreground/25 py-0.5 pr-1 pl-2.5 text-xs">
                {value}
                <button
                  type="button"
                  onClick={() => onChange(values.filter((entry) => entry !== value))}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Remove ${value}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex gap-2">
        <Input
          id={id}
          value={draft}
          placeholder={placeholder}
          maxLength={maxLength}
          aria-describedby={values.length > 0 ? listId : undefined}
          aria-invalid={Boolean(error)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              commit(draft);
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => commit(draft)}>
          Add
        </Button>
      </div>

      <FieldMessage error={error} hint={hint ?? "Press Enter or comma to add."} />
    </div>
  );
}

/** Turns a free-form facility label into the stable code stored alongside it. */
export function toFacilityCode(label: string): string {
  return label
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * Depth-first search for the first message `react-hook-form` produced. Errors
 * on an array item live at a path no section renders — `facilities.0.note`,
 * `academic.coursesOffered.2` — so without this a failed submit would be
 * silent. `ref` holds a DOM node and `types` a duplicate map; neither is walked.
 */
export function firstErrorMessage(node: unknown, depth = 0): string | undefined {
  if (depth > 8 || node === null || typeof node !== "object") return undefined;

  const record = node as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message.trim();
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "ref" || key === "types") continue;
    const found = firstErrorMessage(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * The `onInvalid` half of every section's `handleSubmit`. Without it a blocked
 * save looks like a dead button: the request never goes out and, for an error
 * with no per-field slot to render into, nothing on screen changes.
 */
export function reportSectionErrors<T extends FieldValues>(errors: FieldErrors<T>): void {
  const message = firstErrorMessage(errors);
  toast.error(
    message
      ? `Check the highlighted fields — ${message}`
      : "Check the highlighted fields and try again.",
  );
}

/**
 * Every field section takes the same three things: the profile it reads its
 * defaults from, a save that PATCHes only its own fields, and a way to tell the
 * shell it has unsaved work.
 */
export type SectionProps = {
  profile: ProfileDTO;
  /** Resolves `true` when the server accepted the patch. */
  onSave: (patch: Record<string, unknown>) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
};
