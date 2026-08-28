"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Briefcase,
  ExternalLink,
  IndianRupee,
  Lock,
  Pencil,
  Plus,
  Send,
  Trash2,
  TriangleAlert,
} from "lucide-react";
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
  PLATFORM_LABELS,
  VACANCY_BENEFITS,
  VACANCY_DESCRIPTION_MAX,
  VACANCY_MAX_RECORDS,
  VACANCY_STATUSES,
  VACANCY_SUBJECT_GROUPS,
  VACANCY_TITLE_MAX,
  isTerminalClaim,
  type VacancyStatus,
  type VacancySubject,
} from "@/lib/constants";
import type { VacancyDTO } from "@/services/vacancy.service";
import type {
  VacancyListingDTO,
  VacancyPublishOutcome,
} from "@/services/vacancy-publish.service";

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
 * admin can clear one after having once given it a value. Explicit `null` is
 * the only way to actually clear any of the three on a PATCH, which is why
 * every edit-save below sends this.
 *
 * `vacancyPatchSchema`'s numeric fields (`src/lib/validation/vacancy.ts`)
 * are plain `z.number()`, never `z.coerce.number()` — unlike this repo's
 * `src/lib/validation/application.ts` (`previousPercentage`) or
 * `src/lib/validation/offer.ts` (its date fields), which do coerce. So a
 * `""` reaching the route 400s loudly; it is never coerced to `0`. The
 * actual `Number("") === 0` hazard lives one level up, in `parseNumberField`
 * above — a naive `Number(value) || null` would collapse an emptied field
 * and a genuine zero into the same result, which is why that helper
 * length-checks the trimmed string *before* calling `Number()` at all.
 *
 * `toClearableNumber` is otherwise a pure alias for `parseNumberField`; kept
 * as its own name so the call sites below read as "clearable PATCH value"
 * versus `toOptionalNumber`'s "omit-if-blank create value" a few lines down.
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

const EDUFLEET = PLATFORM_LABELS.EDUFLEET;

/**
 * Publishing is its own request, exactly like create/patch/delete above, and
 * it reads the SAME envelope — which is why nothing new is built here to
 * surface a failure. A refusal the service made before anything was sent (a
 * `DRAFT`, no city on the profile, a preflight reason, no eduFleet
 * credential) arrives as `!payload.success` with a message already written for
 * a school administrator, and `toast.error(payload.error.message)` puts that
 * message in front of them verbatim — the same line `deleteVacancy` uses for
 * Task 5's delete refusals.
 *
 * A push eduFleet actually answered is NOT a failure and does not come back
 * that way: `BLOCKED` and `CONFLICT` are 200s carrying an outcome, because the
 * request happened and a write unit was spent. The caller decides how to show
 * those — see `publish` below — rather than this helper flattening them into
 * "it worked" or "it failed", since they are neither.
 */
async function publishVacancy(vacancyId: string): Promise<VacancyPublishOutcome | null> {
  try {
    const response = await fetch(`/api/settings/vacancies/${vacancyId}/publish`, {
      method: "POST",
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? `Could not publish to ${EDUFLEET}. Please try again.`);
      return null;
    }
    return payload.outcome as VacancyPublishOutcome;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

/**
 * A terminally claimed advert is one IDAP is locked out of permanently: every
 * later push — a field update or a close — is answered with a `403`, so there
 * is nothing IDAP can send that will change what the public listing says.
 * This is the one listing state that makes the vacancy read-only here.
 *
 * `isTerminalClaim` (`constants.ts`) is deliberately narrower than "a push was
 * refused", and narrower than eduFleet's own single `403 claimed` reason,
 * which covers four states. `claim_pending` reverts on its own when an admin
 * rejects the claim, and a takedown under review clears when the takedown is
 * reversed — neither may freeze a row that will heal. `claimed` and
 * `withdrawn` do not heal.
 *
 * The value is only ever real because a push that got a `403 claimed` under
 * Contract One now follows it with eduFleet's free per-job list read and
 * records what came back (`edufleet.ts`'s `resolveClaimState`). Before that,
 * no response IDAP could read ever carried a claim state, so this whole
 * branch was unreachable outside test fixtures.
 */
function claimLock(listing?: VacancyListingDTO): "claimed" | "withdrawn" | null {
  if (!isTerminalClaim(listing?.claimState)) return null;
  return listing?.claimState === "withdrawn" ? "withdrawn" : "claimed";
}

/** A listing eduFleet still shows to teachers, as far as the last push knows. */
function isLive(listing?: VacancyListingDTO): boolean {
  return listing !== undefined && listing.remoteStatus === "active";
}

/**
 * What pressing the one eduFleet button on this card would actually do, or
 * `null` when it must not be offered at all. The label is the honest name for
 * the request `POST .../publish` will make against THIS vacancy's current
 * state, because the single service method behind it does four different
 * things and a button that always said "Publish" would be wrong three times:
 *
 * - `DRAFT` with nothing published — refused by the service outright, so no
 *   button. A half-written vacancy must never reach a public jobs board, and
 *   offering a control whose only outcome is a 400 teaches an admin to ignore
 *   errors.
 * - `DRAFT` still holding a live advert — the "Close" button below, and it
 *   works. The status control offers `DRAFT` for every vacancy, so a published
 *   one is a single click from here; until fix round 1 of Task 7 the button was
 *   shown and the service refused it with "set this vacancy to Open", leaving a
 *   live public advert and no wording that named the way out.
 * - terminally claimed (or withdrawn) and live — no button, for the reason
 *   in `claimLock`.
 * - `OPEN` — creates the listing, or PATCHes the live one, or (after a close)
 *   mints a NEW one, since eduFleet cannot reopen a closed advert.
 * - `FILLED`/`CLOSED` — pushes a close, but only when something is still live
 *   over there. With nothing live the service answers `NOT_LISTED` without an
 *   HTTP call, so the button would do nothing worth pressing.
 */
function publishAction(vacancy: VacancyDTO): { label: string; hint: string } | null {
  const listing = vacancy.listing;
  if (claimLock(listing) && isLive(listing)) return null;

  if (vacancy.status === "OPEN") {
    if (isLive(listing)) {
      return {
        label: `Update on ${EDUFLEET}`,
        hint: `Sends this vacancy's current title, description, salary, experience and benefits to the live advert. Subject changes cannot be sent — close the listing and publish it again to change it.`,
      };
    }
    return listing
      ? {
          label: `Publish again to ${EDUFLEET}`,
          hint: `The previous advert was closed and cannot be reopened, so this creates a new one.`,
        }
      : {
          label: `Publish to ${EDUFLEET}`,
          hint: `Posts this vacancy as a public job advert teachers can apply to.`,
        };
  }

  if (isLive(listing)) {
    return {
      label: `Close on ${EDUFLEET}`,
      hint: `This vacancy is no longer open, so the public advert should come down.`,
    };
  }
  return null;
}

/**
 * `lastPushedAt` is an ISO string from the server; rendering it needs the
 * browser's locale, and doing that during the server pass would produce a
 * different string than the client's and trip hydration. This section is a
 * client component that fetches its own data after mount, so the value only
 * ever exists client-side and there is no server render to disagree with.
 */
function formatPushedAt(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Everything eduFleet knows about this vacancy, on the card itself.
 *
 * `blockedReason` is printed **verbatim**. It is not a code and not a
 * developer string: `blockedMessage()` in the publish service writes each one
 * for a school administrator and names the action to take ("close one there or
 * upgrade the plan", "reconnect to eduFleet Exchange to grant it"). Rewording
 * it here — or replacing it with a generic "publishing failed" — would throw
 * away the only part that tells them what to do next.
 */
function ListingPanel({ listing }: { listing: VacancyListingDTO }) {
  const live = isLive(listing);
  const lock = claimLock(listing);

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={live ? "default" : "outline"}>
          {live ? `Live on ${EDUFLEET}` : `Closed on ${EDUFLEET}`}
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          Last pushed {formatPushedAt(listing.lastPushedAt)}
        </span>
      </div>

      {listing.publicUrl ? (
        <a
          href={listing.publicUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-primary underline underline-offset-2 break-all"
        >
          <ExternalLink className="size-3 shrink-0" aria-hidden />
          {listing.publicUrl}
        </a>
      ) : (
        // Not every listing has one, and saying so beats showing a dead space
        // where a link should be: eduFleet returns `publicUrl` only when it
        // CREATES a job, so a listing IDAP adopted from a duplicate-id conflict
        // — and any listing published before IDAP started recording the URL —
        // genuinely has no link to offer.
        <p className="text-[11px] text-muted-foreground">
          {EDUFLEET} did not return a public link for this listing — find it on {EDUFLEET} under
          job {listing.jobId}.
        </p>
      )}

      {lock ? (
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Lock className="mt-px size-3 shrink-0" aria-hidden />
          {lock === "withdrawn" ? (
            <span>
              {EDUFLEET} has taken this advert down, so IDAP can no longer change or close it.
              This vacancy is read-only here — take it up on {EDUFLEET} if that was not expected.
            </span>
          ) : (
            <span>
              Your school has claimed this advert on {EDUFLEET}, so it belongs to your {EDUFLEET}
              {" "}account now and IDAP can no longer change or close it. This vacancy is
              read-only here — edit or close the advert on {EDUFLEET}.
            </span>
          )}
        </p>
      ) : null}

      {listing.blockedReason ? (
        <p className="flex items-start gap-1.5 text-[11px] text-destructive">
          <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
          {/* Verbatim — see this component's docblock. */}
          <span>{listing.blockedReason}</span>
        </p>
      ) : null}
    </div>
  );
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
 * The one thing a school cannot work out from this form: **eduFleet cannot
 * remove a figure it already holds.**
 *
 * Both of eduFleet's patch types declare `salaryMin?: number` /
 * `salaryMax?: number` / `experienceRequired?: number` — never `null` — and
 * both update routes gate on `!== undefined`. So an omitted key means
 * "unchanged" and there is no value that means "remove". IDAP's mapping module
 * omits absent keys, which is correct and the only thing it can do; the
 * consequence is that clearing one of these fields here saves fine, reports
 * "Vacancy updated", pushes fine — and the public advert keeps showing the old
 * number, forever, until the listing is closed and published again.
 *
 * A school must not find that out by reading their own public listing. This
 * returns the warning lines to show **beside the fields being cleared**, at
 * the moment they are cleared, rather than after the fact.
 *
 * Every figure quoted is `remoteSalaryMin`/`remoteSalaryMax`/
 * `remoteExperienceRequired` — what eduFleet actually holds after the last
 * successful push, not what this vacancy currently stores. Those are the
 * numbers a candidate is really looking at, and after a refused push the two
 * genuinely differ.
 *
 * Only a LIVE listing is warned about: a closed one is republished as a brand
 * new advert (eduFleet has no reopen), and a new advert carries exactly the
 * fields sent at create time — including the cleared ones.
 */
function unclearableWarnings(
  listing: VacancyListingDTO | undefined,
  fields: { salaryMin: string; salaryMax: string; experienceRequired: string },
): string[] {
  if (!listing || !isLive(listing)) return [];

  const rupees = (value: number) => `₹${value.toLocaleString("en-IN")}`;
  const lines: string[] = [];

  // `== null` on the parsed value is "the box is empty", and `!= null` on the
  // remote bound is "eduFleet holds one" — a remote bound of 0 is a real
  // figure a candidate can see, so neither check may be a truthiness test.
  if (parseNumberField(fields.salaryMin) == null && listing.remoteSalaryMin != null) {
    lines.push(
      `${EDUFLEET} will keep showing a salary minimum of ${rupees(listing.remoteSalaryMin)} on the live advert.`,
    );
  }
  if (parseNumberField(fields.salaryMax) == null && listing.remoteSalaryMax != null) {
    lines.push(
      `${EDUFLEET} will keep showing a salary maximum of ${rupees(listing.remoteSalaryMax)} on the live advert.`,
    );
  }
  // Fix round 1: this used to lean on the vacancy's own stored value and
  // quote no figure, because none was recorded. `remoteExperienceRequired` is
  // recorded now, so this line reads exactly like the two above it — the same
  // hazard, stated the same way, naming the same kind of number. A school
  // reading a precise "₹35,000" beside a vague "the figure it already has"
  // has fair grounds to wonder whether IDAP actually knows.
  if (parseNumberField(fields.experienceRequired) == null && listing.remoteExperienceRequired != null) {
    const years = listing.remoteExperienceRequired;
    lines.push(
      `${EDUFLEET} will keep showing an experience requirement of ${years} ${years === 1 ? "year" : "years"} on the live advert.`,
    );
  }

  return lines;
}

/**
 * One form for create and edit, mirroring `achievements-section.tsx`'s
 * `AchievementDialog`: plain controlled state rather than `react-hook-form`,
 * because the three-state clearing rule for `salaryMin`/`salaryMax`/
 * `experienceRequired` needs an explicit `null` built by hand at submit time
 * (`toClearableNumber` above) — a cleared `<input type="number">` reports
 * `""`, and only an explicit `null` clears a bound on `vacancyPatchSchema`;
 * `""` itself is rejected with a 400 (that schema's numeric fields are plain
 * `z.number()`, never `z.coerce.number()` — see `toClearableNumber` above
 * for why that matters), not silently coerced to `0`.
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

  // Recomputed on every keystroke rather than memoised: it reads three strings
  // and one small object, and it has to appear the instant a box is emptied —
  // that timing is the entire point (see `unclearableWarnings`).
  const clearingWarnings = unclearableWarnings(editing?.listing, {
    salaryMin,
    salaryMax,
    experienceRequired,
  });

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

          {clearingWarnings.length > 0 ? (
            <div
              role="status"
              data-testid="vacancy-unclearable-warning"
              className="space-y-1 rounded-md border border-border bg-muted/40 p-2.5"
            >
              <p className="flex items-start gap-1.5 text-[11px] font-medium text-foreground">
                <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
                <span>Clearing this will not clear it on {EDUFLEET}.</span>
              </p>
              <ul className="ml-[18px] list-disc space-y-0.5 text-[11px] text-muted-foreground">
                {clearingWarnings.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="ml-[18px] text-[11px] text-muted-foreground">
                An update can change one of these figures but has no way to remove one. To publish
                this vacancy without it, close the {EDUFLEET} listing and publish it again.
              </p>
            </div>
          ) : null}

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

/**
 * One vacancy in the list — summary, the status control, edit/delete, and
 * everything eduFleet knows about it.
 *
 * **A terminally claimed live listing makes the card read-only**, and that is
 * the one place this component overrides what the vacancy's own status would
 * allow. Once a school claims an aggregated advert on eduFleet it owns it
 * there — or eduFleet withdraws it, which is equally final — and
 * every push IDAP could still make is answered `403` — so the title, subject,
 * description, salary and benefits shown here can never again be made to
 * match what the public sees. Leaving the Edit button live would offer an
 * admin a change that saves locally, reports success, and silently disagrees
 * with their own public advert for as long as it runs; leaving the status
 * control live would offer a "Filled" that never takes the advert down.
 * Neither is better than showing none, so both are disabled and
 * `ListingPanel` prints the reason directly under them.
 *
 * Delete stays available on purpose. It is not an edit that can quietly
 * diverge: `VacancyService.remove` closes the listing first and REFUSES the
 * delete when it cannot, in words that name the next step — so pressing it
 * either removes the vacancy safely or explains exactly why it will not. That
 * refusal is the school's only remaining route out of the row, and disabling
 * the button would replace an explanation with a dead end.
 */
function VacancyCard({
  vacancy,
  busy,
  publishing,
  onStatusChange,
  onEdit,
  onPublish,
  onDeleteRequest,
}: {
  vacancy: VacancyDTO;
  busy: boolean;
  publishing: boolean;
  onStatusChange: (status: VacancyStatus) => void;
  onEdit: () => void;
  onPublish: () => void;
  onDeleteRequest: () => void;
}) {
  const salaryLine = formatSalaryRange(vacancy.salaryMin, vacancy.salaryMax);
  const experienceLine = formatExperience(vacancy.experienceRequired);
  const listing = vacancy.listing;
  const readOnly = claimLock(listing) !== null && isLive(listing);
  const action = publishAction(vacancy);

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
            disabled={busy || readOnly}
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
            disabled={readOnly}
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

      {listing ? <ListingPanel listing={listing} /> : null}

      {action ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={publishing}
            aria-label={`${action.label} — ${vacancy.title}`}
            onClick={onPublish}
          >
            <Send className="size-3.5" />
            {publishing ? "Publishing…" : action.label}
          </Button>
          <p className="text-[11px] text-muted-foreground">{action.hint}</p>
        </div>
      ) : vacancy.status === "DRAFT" && !listing ? (
        // Said once, plainly, instead of a disabled button an admin has to
        // hover to understand: the service refuses a DRAFT push outright.
        <p className="text-[11px] text-muted-foreground">
          Move this vacancy to Open to publish it to {EDUFLEET}.
        </p>
      ) : null}
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
  const [publishingId, setPublishingId] = useState<string | null>(null);
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

  /**
   * One push, and the four answers it can come back with.
   *
   * The split between a toast and a card update is not cosmetic. `PUSHED` and
   * `CLOSED` changed the listing, so the card must take the listing the server
   * just recorded — that is where the public URL, the new `remoteStatus` and
   * the cleared `blockedReason` come from, and re-fetching the whole list to
   * learn them would be a second round trip for data already in hand.
   *
   * `BLOCKED` and `CONFLICT` are the ones worth being careful about. They are
   * NOT errors — eduFleet answered, the push happened, and one of the school's
   * daily write units is gone — so they are reported with their own message
   * (`toast.error` for visibility, since a school does need to act) and, when
   * the outcome carries a listing, that listing is stored too: it is the one
   * holding the `blockedReason` the card prints verbatim. A push that was
   * refused before the wire never reaches here at all — `publishVacancy`
   * toasts the service's own message and returns `null`.
   *
   * `outcome.listing` is assigned even when it is absent, never merged around.
   * Every branch that leaves it absent means this vacancy genuinely has no
   * listing: `NOT_LISTED` is "there was nothing to close", and a `BLOCKED` or
   * `CONFLICT` with no listing only happens on a create, which had none to
   * begin with. Keeping a stale one would be inventing state the server does
   * not have.
   */
  async function publish(vacancy: VacancyDTO) {
    setPublishingId(vacancy.id);
    const outcome = await publishVacancy(vacancy.id);
    setPublishingId(null);
    if (!outcome) return;

    if (outcome.status === "BLOCKED" || outcome.status === "CONFLICT") {
      toast.error(outcome.message);
    } else if (outcome.status === "PUSHED") {
      toast.success(`Published to ${EDUFLEET}`);
    } else if (outcome.status === "CLOSED") {
      toast.success(`Closed on ${EDUFLEET}`);
    } else {
      toast.info(`This vacancy has nothing published on ${EDUFLEET}`);
    }

    const listing = outcome.status === "NOT_LISTED" ? undefined : outcome.listing;
    setVacancies((prev) =>
      prev ? prev.map((row) => (row.id === vacancy.id ? { ...row, listing } : row)) : prev,
    );
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
              publishing={publishingId === vacancy.id}
              onStatusChange={(status) => changeStatus(vacancy, status)}
              onEdit={() => setDialogState({ mode: "edit", vacancy })}
              onPublish={() => void publish(vacancy)}
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
          {/*
            A claimed advert is the one case where deleting here leaves
            something behind. The server no longer refuses the delete — it
            cannot close a claimed listing and never will, so refusing would
            trap the row forever — but the school must not press Delete
            believing the public advert goes with it. It does not: the advert
            is on their own eduFleet account now, and only they can take it
            down. Said BEFORE the button, not in a toast afterwards.
          */}
          {claimLock(pendingDelete?.listing) === "claimed" && isLive(pendingDelete?.listing) ? (
            <p className="flex items-start gap-1.5 rounded-md border border-border bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
              <Lock className="mt-px size-3 shrink-0" aria-hidden />
              <span>
                Your school has claimed this vacancy&apos;s advert on {EDUFLEET}, so it belongs to
                your {EDUFLEET} account and IDAP cannot take it down. Deleting here removes only
                this record — <strong className="font-medium text-foreground">the advert stays
                live on {EDUFLEET}</strong> until you close it there.
              </span>
            </p>
          ) : null}
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
