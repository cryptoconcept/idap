"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Briefcase, IndianRupee, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import {
  VACANCY_BENEFITS,
  VACANCY_DESCRIPTION_MAX,
  VACANCY_MAX_RECORDS,
  VACANCY_STATUSES,
  VACANCY_SUBJECT_GROUPS,
  VACANCY_TITLE_MAX,
  type VacancyStatus,
  type VacancySubject,
} from "@/lib/constants";
import type { VacancyDTO } from "@/services/vacancy.service";

/**
 * Same shape as `achievements-section.tsx` / `alumni-section.tsx`: vacancies
 * are not part of `ProfileDTO` — Tasks 1-4 gave them their own collection and
 * their own `/api/settings/vacancies*` routes, so this section owns its data
 * end to end. It fetches its own list on mount and keeps it in local state;
 * every action below is its own immediate request, and nothing here
 * participates in the "unsaved changes" dialog the field-based sections use.
 */

type DialogState = { mode: "create" } | { mode: "edit"; vacancy: VacancyDTO };

/**
 * No `VACANCY_STATUS_LABELS` exists in `lib/constants.ts` (unlike
 * `VACANCY_SUBJECT_GROUPS`) — same reasoning as `achievements-section.tsx`'s
 * local `ACHIEVEMENT_LEVEL_LABELS`: a label map read by exactly one component
 * belongs beside its one caller, not bolted onto the shared constants file.
 */
const VACANCY_STATUS_LABELS: Record<VacancyStatus, string> = {
  DRAFT: "Draft",
  OPEN: "Open",
  FILLED: "Filled",
  CLOSED: "Closed",
};

/**
 * Parses a `<input type="number">`'s string value into either a real number
 * or `null`. A browser-native number input only ever reports a valid
 * floating-point string or `""` — never partial garbage — so `Number.isFinite`
 * is a belt-and-braces check, not the primary guard.
 *
 * Crucially, this treats an emptied field and a genuine `0` differently:
 * `parseNumberField("")` is `null`, `parseNumberField("0")` is `0`. A naive
 * `Number(value) || null` would collapse those two into the same thing —
 * `Number("") || null` and `Number("0") || null` are BOTH `null`, since `0` is
 * falsy — which would make it impossible to save a stipend-free vacancy
 * (`salaryMin: 0`) and just as impossible to tell "cleared" from "zero" when
 * reading the field back. Every helper below is built on this, never on a
 * truthiness check.
 */
function parseNumberField(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The edit-time helper: `salaryMin`/`salaryMax`/`experienceRequired` are the
 * three fields `vacancyPatchSchema` marks `.nullable()`, precisely so an
 * admin can clear one after having once given it a value. Sending `""`
 * instead would coerce to `0` (`Number("")` is `0`, not `NaN`) and silently
 * store a zero salary rather than clearing it — exactly the bug this task
 * exists to avoid. Explicit `null` is the only way to actually clear any of
 * the three on a PATCH, which is why every edit-save below sends this.
 */
function toClearableNumber(value: string): number | null {
  return parseNumberField(value);
}

/**
 * The create-time counterpart: `vacancyCreateSchema`'s `salaryMin`/
 * `salaryMax`/`experienceRequired` are NOT `.nullable()` (there is no stored
 * value yet to clear), so sending `null` there would fail validation. Blank
 * means "omit the key," i.e. `undefined`, not `null` — `JSON.stringify` keeps
 * an explicit `null` but drops an `undefined` key, which is what makes the
 * two create-time states (a value, or nothing at all) expressible over HTTP.
 */
function toOptionalNumber(value: string): number | undefined {
  return parseNumberField(value) ?? undefined;
}

/**
 * `min`/`max` are read with `!= null`, never `??` on the pair together and
 * never a truthiness check: a real `salaryMin: 0` must render as "₹0", not be
 * treated as absent alongside an unset `salaryMax`.
 */
function formatSalaryRange(min?: number, max?: number): string | null {
  if (min == null && max == null) return null;
  const rupees = (value: number) => `₹${value.toLocaleString("en-IN")}`;
  if (min != null && max != null) return `${rupees(min)} – ${rupees(max)}`;
  if (min != null) return `From ${rupees(min)}`;
  return `Up to ${rupees(max as number)}`;
}

function formatExperience(years?: number): string | null {
  if (years == null) return null;
  if (years === 0) return "No prior experience required";
  return `${years}+ ${years === 1 ? "year" : "years"} experience`;
}

async function fetchVacancies(): Promise<VacancyDTO[] | null> {
  try {
    const response = await fetch("/api/settings/vacancies");
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not load vacancies. Please try again.");
      return null;
    }
    return payload.vacancies as VacancyDTO[];
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

async function createVacancy(input: Record<string, unknown>): Promise<VacancyDTO | null> {
  try {
    const response = await fetch("/api/settings/vacancies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not add the vacancy. Please try again.");
      return null;
    }
    return payload.vacancy as VacancyDTO;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

async function patchVacancy(
  vacancyId: string,
  patch: Record<string, unknown>,
): Promise<VacancyDTO | null> {
  try {
    const response = await fetch(`/api/settings/vacancies/${vacancyId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not update the vacancy. Please try again.");
      return null;
    }
    return payload.vacancy as VacancyDTO;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

async function deleteVacancy(vacancyId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/settings/vacancies/${vacancyId}`, {
      method: "DELETE",
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not delete the vacancy. Please try again.");
      return false;
    }
    return true;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return false;
  }
}

/**
 * Fixed toggles, never free text: eduFleet's `sanitizeFacilities()` silently
 * discards any label it does not recognise off `VACANCY_BENEFITS` — no error,
 * no signal — so a free-text benefit would vanish from the published advert
 * with nothing reporting it. Every id is a stable index into the fixed
 * `VACANCY_BENEFITS` array, not derived from the label text, so it stays
 * valid even for benefits whose text contains characters unsafe in an id.
 */
function BenefitsEditor({
  selected,
  onChange,
  disabled,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  function toggle(benefit: string, checked: boolean) {
    onChange(checked ? [...selected, benefit] : selected.filter((value) => value !== benefit));
  }

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">Benefits</p>
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        {VACANCY_BENEFITS.map((benefit, index) => {
          const id = `vacancy-benefit-${index}`;
          return (
            <div key={benefit} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={selected.includes(benefit)}
                disabled={disabled}
                onCheckedChange={(checked) => toggle(benefit, checked === true)}
              />
              <Label htmlFor={id} className="text-sm font-normal">
                {benefit}
              </Label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One form for create and edit, mirroring `achievements-section.tsx`'s
 * `AchievementDialog`: plain controlled state rather than `react-hook-form`,
 * because the three-state clearing rule for `salaryMin`/`salaryMax`/
 * `experienceRequired` needs an explicit `null` built by hand at submit time
 * (`toClearableNumber` above) — a `zodResolver` bound straight to
 * `vacancyPatchSchema` would run the raw `""` from a cleared number field
 * through `Number()` before this component ever saw it, coercing it to `0`.
 *
 * `status` is deliberately absent from this form: `vacancyCreateSchema` has
 * no `status` field (a fresh vacancy is always `DRAFT`), and changing an
 * existing vacancy's status is a card-level action (`VacancyCard` below), not
 * a field you edit alongside the description.
 *
 * Keyed by the caller on the vacancy id (or `"create"`), so opening a
 * different vacancy — or switching from edit back to create — remounts this
 * component with fresh draft state instead of needing an effect to resync it.
 */
function VacancyDialog({
  state,
  onClose,
  onSaved,
}: {
  state: DialogState;
  onClose: () => void;
  onSaved: (vacancy: VacancyDTO) => void;
}) {
  const editing = state.mode === "edit" ? state.vacancy : null;

  const [title, setTitle] = useState(editing?.title ?? "");
  const [subject, setSubject] = useState<VacancySubject>(
    (editing?.subject as VacancySubject) ?? VACANCY_SUBJECT_GROUPS[0].subjects[0],
  );
  const [description, setDescription] = useState(editing?.description ?? "");
  const [salaryMin, setSalaryMin] = useState(editing?.salaryMin != null ? String(editing.salaryMin) : "");
  const [salaryMax, setSalaryMax] = useState(editing?.salaryMax != null ? String(editing.salaryMax) : "");
  const [experienceRequired, setExperienceRequired] = useState(
    editing?.experienceRequired != null ? String(editing.experienceRequired) : "",
  );
  const [benefits, setBenefits] = useState<string[]>(editing?.facilities ?? []);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error("Enter a vacancy title.");
      return;
    }
    const trimmedDescription = description.trim();
    if (!trimmedDescription) {
      toast.error("Enter a description.");
      return;
    }

    // Mirrors `vacancyCreateSchema`/`vacancyPatchSchema`'s `salaryOrder`
    // refine client-side, so a school sees this as a form error rather than
    // as a request that round-tripped to the server only to be refused.
    const minValue = parseNumberField(salaryMin);
    const maxValue = parseNumberField(salaryMax);
    if (minValue !== null && maxValue !== null && minValue > maxValue) {
      toast.error("The minimum salary may not exceed the maximum salary.");
      return;
    }

    setSaving(true);
    const next = editing
      ? await patchVacancy(editing.id, {
          title: trimmedTitle,
          subject,
          description: trimmedDescription,
          // Explicit `null` when cleared, never `""` — see `toClearableNumber` above.
          salaryMin: toClearableNumber(salaryMin),
          salaryMax: toClearableNumber(salaryMax),
          experienceRequired: toClearableNumber(experienceRequired),
          // `facilities` is not part of the three-state contract: `[]`
          // already expresses "none", so it is always sent as-is.
          facilities: benefits,
        })
      : await createVacancy({
          title: trimmedTitle,
          subject,
          description: trimmedDescription,
          salaryMin: toOptionalNumber(salaryMin),
          salaryMax: toOptionalNumber(salaryMax),
          experienceRequired: toOptionalNumber(experienceRequired),
          facilities: benefits,
        });
    setSaving(false);

    if (next) {
      toast.success(editing ? "Vacancy updated" : "Vacancy added");
      onSaved(next);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit vacancy" : "Add a vacancy"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes save immediately."
              : "Saved as a draft. Move it to Open when you're ready to hire against it."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="vacancy-title">Title</Label>
            <Input
              id="vacancy-title"
              value={title}
              maxLength={VACANCY_TITLE_MAX}
              disabled={saving}
              placeholder="e.g. Mathematics Teacher — Senior Section"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="vacancy-subject">Subject</Label>
            <Select value={subject} onValueChange={(value) => setSubject(value as VacancySubject)}>
              <SelectTrigger id="vacancy-subject" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VACANCY_SUBJECT_GROUPS.map((group) => (
                  <SelectGroup key={group.group}>
                    <SelectLabel>{group.group}</SelectLabel>
                    {group.subjects.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="vacancy-description">Description</Label>
            <Textarea
              id="vacancy-description"
              value={description}
              maxLength={VACANCY_DESCRIPTION_MAX}
              disabled={saving}
              placeholder="Responsibilities, qualifications, and anything else a candidate should know."
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="vacancy-salary-min">Salary min (₹/month)</Label>
              <Input
                id="vacancy-salary-min"
                type="number"
                inputMode="numeric"
                min={0}
                value={salaryMin}
                disabled={saving}
                placeholder="Optional"
                onChange={(event) => setSalaryMin(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vacancy-salary-max">Salary max (₹/month)</Label>
              <Input
                id="vacancy-salary-max"
                type="number"
                inputMode="numeric"
                min={0}
                value={salaryMax}
                disabled={saving}
                placeholder="Optional"
                onChange={(event) => setSalaryMax(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vacancy-experience">Experience (years)</Label>
              <Input
                id="vacancy-experience"
                type="number"
                inputMode="numeric"
                min={0}
                value={experienceRequired}
                disabled={saving}
                placeholder="Optional"
                onChange={(event) => setExperienceRequired(event.target.value)}
              />
            </div>
          </div>

          <BenefitsEditor selected={benefits} onChange={setBenefits} disabled={saving} />
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={saving} onClick={handleSubmit}>
            {saving ? "Saving…" : editing ? "Save changes" : "Add vacancy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One vacancy in the list — summary, the status control, and edit/delete. */
function VacancyCard({
  vacancy,
  busy,
  onStatusChange,
  onEdit,
  onDeleteRequest,
}: {
  vacancy: VacancyDTO;
  busy: boolean;
  onStatusChange: (status: VacancyStatus) => void;
  onEdit: () => void;
  onDeleteRequest: () => void;
}) {
  const salaryLine = formatSalaryRange(vacancy.salaryMin, vacancy.salaryMax);
  const experienceLine = formatExperience(vacancy.experienceRequired);

  return (
    <li className="space-y-3 rounded-lg border border-border p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-medium">{vacancy.title}</h3>
            <Badge variant="secondary">{vacancy.subject}</Badge>
          </div>

          <p className="line-clamp-2 text-xs text-muted-foreground">{vacancy.description}</p>

          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {salaryLine ? (
              <span className="inline-flex items-center gap-1">
                <IndianRupee className="size-3" />
                {salaryLine}
              </span>
            ) : null}
            {experienceLine ? <span>{experienceLine}</span> : null}
          </div>

          {vacancy.facilities && vacancy.facilities.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {vacancy.facilities.map((benefit) => (
                <Badge key={benefit} variant="outline">
                  {benefit}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          <Select
            value={vacancy.status}
            disabled={busy}
            onValueChange={(value) => onStatusChange(value as VacancyStatus)}
          >
            <SelectTrigger size="sm" aria-label={`Status for ${vacancy.title}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VACANCY_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {VACANCY_STATUS_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Edit ${vacancy.title}`}
            onClick={onEdit}
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label={`Delete ${vacancy.title}`}
            onClick={onDeleteRequest}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
    </li>
  );
}

export function VacanciesSection() {
  // `vacancies` is `null` for both "still loading" and "the load failed" —
  // `loadFailed` is what tells those two apart. A failed fetch must NOT fall
  // back to `[]`: that reads identically to a genuine empty list, and an
  // admin who glances away sees "no vacancies yet" for what is actually a
  // network hiccup — reasonable grounds to conclude their data is gone, or to
  // start re-entering records that still exist server-side. Same convention
  // as `achievements-section.tsx` / `alumni-section.tsx`.
  const [vacancies, setVacancies] = useState<VacancyDTO[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<VacancyDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dialogState, setDialogState] = useState<DialogState | null>(null);

  /**
   * Shared by the initial mount and the "Try again" retry control below.
   * Every `setState` here happens inside the `.then()` — after a real
   * `await`, never synchronously in the body — because a synchronous
   * `setState` called directly from an effect (this function is invoked as
   * `useEffect(() => loadVacancies(), ...)` below) trips the React
   * Compiler's "calling setState synchronously within an effect can trigger
   * cascading renders" check. `loadFailed` is only ever set to its next real
   * value (`true` on failure, `false` alongside the fresh data on success),
   * never pre-emptively reset before the request even starts.
   */
  const loadVacancies = useCallback(() => {
    let cancelled = false;
    void fetchVacancies().then((rows) => {
      if (cancelled) return;
      if (rows === null) {
        setLoadFailed(true);
      } else {
        setVacancies(rows);
        setLoadFailed(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => loadVacancies(), [loadVacancies]);

  async function changeStatus(vacancy: VacancyDTO, status: VacancyStatus) {
    if (status === vacancy.status) return;
    setStatusBusyId(vacancy.id);
    const next = await patchVacancy(vacancy.id, { status });
    setStatusBusyId(null);
    if (next) {
      toast.success(`Marked ${VACANCY_STATUS_LABELS[status].toLowerCase()}`);
      setVacancies((prev) => (prev ? prev.map((row) => (row.id === next.id ? next : row)) : prev));
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    const ok = await deleteVacancy(pendingDelete.id);
    setDeleting(false);
    if (ok) {
      toast.success("Vacancy deleted");
      const deletedId = pendingDelete.id;
      setVacancies((prev) => (prev ? prev.filter((row) => row.id !== deletedId) : prev));
      setPendingDelete(null);
    }
  }

  /** After Save/Create succeeds: update the list (insert or replace by id) and close the dialog. */
  function handleSaved(next: VacancyDTO) {
    setVacancies((prev) => {
      if (!prev) return [next];
      const exists = prev.some((row) => row.id === next.id);
      return exists ? prev.map((row) => (row.id === next.id ? next : row)) : [next, ...prev];
    });
    setDialogState(null);
  }

  // The service enforces this at create with a `validationError`; disabling
  // the control here surfaces the reason before an admin fills out a form
  // only to have it refused, same as the achievements/alumni sections' asset
  // caps.
  const atCap = vacancies !== null && vacancies.length >= VACANCY_MAX_RECORDS;

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold tracking-tight">Vacancies</h2>
          <p className="text-xs text-muted-foreground">
            Teacher and staff openings for your institution. New vacancies start as drafts —
            move one to Open once it&apos;s ready.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            type="button"
            size="sm"
            disabled={atCap}
            onClick={() => setDialogState({ mode: "create" })}
          >
            <Plus className="size-3.5" />
            Add vacancy
          </Button>
          {atCap ? (
            <p className="text-[11px] text-muted-foreground">
              Limit reached ({VACANCY_MAX_RECORDS} of {VACANCY_MAX_RECORDS}) — delete one to add
              another.
            </p>
          ) : null}
        </div>
      </div>

      {vacancies === null && loadFailed ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
          <TriangleAlert className="size-4 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">Could not load vacancies.</p>
          <p className="text-xs text-muted-foreground">
            This is a failed request, not an empty list — your existing vacancies are safe.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => loadVacancies()}>
            Try again
          </Button>
        </div>
      ) : vacancies === null ? (
        <div className="space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : vacancies.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title="No vacancies yet"
          description="Post a teacher or staff opening — its subject, salary and benefits — to keep track of who you're hiring for."
        />
      ) : (
        <ul className="space-y-3">
          {vacancies.map((vacancy) => (
            <VacancyCard
              key={vacancy.id}
              vacancy={vacancy}
              busy={statusBusyId === vacancy.id}
              onStatusChange={(status) => changeStatus(vacancy, status)}
              onEdit={() => setDialogState({ mode: "edit", vacancy })}
              onDeleteRequest={() => setPendingDelete(vacancy)}
            />
          ))}
        </ul>
      )}

      {dialogState ? (
        <VacancyDialog
          key={dialogState.mode === "edit" ? dialogState.vacancy.id : "create"}
          state={dialogState}
          onClose={() => setDialogState(null)}
          onSaved={handleSaved}
        />
      ) : null}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Delete this vacancy?</DialogTitle>
            <DialogDescription>
              &ldquo;{pendingDelete?.title ?? "Untitled"}&rdquo; will be removed. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={deleting} onClick={confirmDelete}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
