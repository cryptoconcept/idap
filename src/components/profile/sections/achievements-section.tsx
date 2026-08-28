"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Award,
  Calendar,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  ImagePlus,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Upload,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import {
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_CATEGORY_LABELS,
  ACHIEVEMENT_LEVELS,
  ACHIEVEMENT_MAX_CERTIFICATES,
  ACHIEVEMENT_MAX_PHOTOS,
  ACHIEVEMENT_MAX_STUDENTS,
  SHOWCASE_MAX_PDF_BYTES,
  type AchievementCategory,
  type AchievementLevel,
} from "@/lib/constants";
import type { AchievementAssetKind, AchievementDTO } from "@/services/achievement.service";
import { ACCEPT_ATTRIBUTE, checkImageFile } from "@/components/profile/media-upload";

/**
 * Unlike media, achievements are not part of `ProfileDTO` — Tasks 3-10 gave
 * them their own collection and their own `/api/settings/achievements*`
 * routes, so this section owns its data end to end: it fetches its own list
 * on mount and keeps it in local state, rather than reading a slice of a
 * profile the page already loaded. Every action below is its own immediate
 * request, same as `media-section.tsx` — there is no draft to save and
 * nothing here participates in the "unsaved changes" dialog the field-based
 * sections use.
 */

type StudentDraft = { name: string; grade: string };
type DialogState = { mode: "create" } | { mode: "edit"; achievement: AchievementDTO };

/**
 * No `ACHIEVEMENT_LEVEL_LABELS` exists in `lib/constants.ts` (unlike
 * `ACHIEVEMENT_CATEGORY_LABELS`) — same reasoning as `media-section.tsx`'s
 * local `PROVIDER_LABELS`: a label map read by exactly one component belongs
 * beside its one caller, not bolted onto the shared constants file.
 */
const ACHIEVEMENT_LEVEL_LABELS: Record<AchievementLevel, string> = {
  SCHOOL: "School",
  TALUK: "Taluk",
  DISTRICT: "District",
  STATE: "State",
  NATIONAL: "National",
  INTERNATIONAL: "International",
};

/**
 * `AchievementDTO.category`/`.level` are typed as plain `string` on the
 * service (the model's enum constraint is the real guard, not this DTO), so
 * indexing the label records — keyed by the narrow literal unions — needs a
 * defensive cast with a fallback rather than an unchecked index.
 */
function categoryLabel(category: string): string {
  return ACHIEVEMENT_CATEGORY_LABELS[category as AchievementCategory] ?? category;
}

function levelLabel(level: string): string {
  return ACHIEVEMENT_LEVEL_LABELS[level as AchievementLevel] ?? level;
}

function formatEventDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Mirrors `checkPdfFile` (`media-upload.tsx`) but against
 * `SHOWCASE_MAX_PDF_BYTES` rather than `MEDIA_MAX_PDF_BYTES`. The two limits
 * are numerically equal today but are independent by design (see that
 * constant's comment in `lib/constants.ts`), so this achievement-specific
 * check must not silently borrow the media one's number.
 */
const CERTIFICATE_ACCEPT_ATTRIBUTE = "application/pdf";

function checkCertificateFile(file: File): string | null {
  if (file.type !== "application/pdf") {
    return `${file.name}: only PDF files can be uploaded.`;
  }
  if (file.size <= 0) return `${file.name}: the file is empty.`;
  if (file.size > SHOWCASE_MAX_PDF_BYTES) {
    return `${file.name}: files must be ${Math.floor(SHOWCASE_MAX_PDF_BYTES / (1024 * 1024))} MB or smaller.`;
  }
  return null;
}

/**
 * Blank means "clear it," not "leave it alone" — same three-state contract
 * `media-section.tsx`'s `saveCaption` documents for media captions, now also
 * true of `description` and `eventDate` on `achievementPatchSchema`
 * (`lib/validation/showcase.ts`). Sending `""` would pass through
 * `optionalText`/`optionalDateSchema` and collapse to `undefined`, which
 * `JSON.stringify` then drops from the request body entirely — indistin-
 * guishable from "not supplied," so the server would leave the old value in
 * place. Explicit `null` is the only way to actually clear either field on a
 * PATCH, which is why every edit-save below sends this, never `""`.
 */
function toClearable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The create-time counterpart: `achievementCreateSchema.description`/
 * `.eventDate` are NOT `.nullable()` (there is no stored value yet to clear),
 * so sending `null` there would fail validation. Blank means "omit the key,"
 * i.e. `undefined`, not `null`.
 */
function toOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function fetchAchievements(): Promise<AchievementDTO[] | null> {
  try {
    const response = await fetch("/api/settings/achievements");
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not load achievements. Please try again.");
      return null;
    }
    return payload.achievements as AchievementDTO[];
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

async function createAchievement(input: Record<string, unknown>): Promise<AchievementDTO | null> {
  try {
    const response = await fetch("/api/settings/achievements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not add the achievement. Please try again.");
      return null;
    }
    return payload.achievement as AchievementDTO;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

async function patchAchievement(
  achievementId: string,
  patch: Record<string, unknown>,
): Promise<AchievementDTO | null> {
  try {
    const response = await fetch(`/api/settings/achievements/${achievementId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not update the achievement. Please try again.");
      return null;
    }
    return payload.achievement as AchievementDTO;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

async function deleteAchievement(achievementId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/settings/achievements/${achievementId}`, {
      method: "DELETE",
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not delete the achievement. Please try again.");
      return false;
    }
    return true;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return false;
  }
}

async function uploadAchievementAsset(
  achievementId: string,
  kind: AchievementAssetKind,
  file: File,
): Promise<AchievementDTO | null> {
  const body = new FormData();
  body.append("file", file);
  body.append("kind", kind);
  try {
    const response = await fetch(`/api/settings/achievements/${achievementId}/assets`, {
      method: "POST",
      body,
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not upload the file. Please try again.");
      return null;
    }
    return payload.achievement as AchievementDTO;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

async function removeAchievementAsset(
  achievementId: string,
  kind: AchievementAssetKind,
  key: string,
): Promise<AchievementDTO | null> {
  try {
    const response = await fetch(`/api/settings/achievements/${achievementId}/assets`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, key }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not remove the file. Please try again.");
      return null;
    }
    return payload.achievement as AchievementDTO;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

/** Add/remove rows for the students list, capped at `ACHIEVEMENT_MAX_STUDENTS`. */
function StudentsEditor({
  students,
  onChange,
}: {
  students: StudentDraft[];
  onChange: (next: StudentDraft[]) => void;
}) {
  const atCap = students.length >= ACHIEVEMENT_MAX_STUDENTS;

  function addRow() {
    if (atCap) return;
    onChange([...students, { name: "", grade: "" }]);
  }

  function updateRow(index: number, patch: Partial<StudentDraft>) {
    onChange(students.map((student, position) => (position === index ? { ...student, ...patch } : student)));
  }

  function removeRow(index: number) {
    onChange(students.filter((_, position) => position !== index));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-normal text-muted-foreground">
          Students ({students.length} of {ACHIEVEMENT_MAX_STUDENTS})
        </p>
        <Button type="button" variant="outline" size="xs" disabled={atCap} onClick={addRow}>
          <Plus className="size-3" />
          Add student
        </Button>
      </div>
      {atCap ? (
        <p className="text-[11px] text-muted-foreground">
          Limit reached — remove a student to add another.
        </p>
      ) : null}

      {students.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No students listed.</p>
      ) : (
        <ul className="space-y-1.5">
          {students.map((student, index) => (
            // Rows have no stable id until saved — order is the only identity
            // they have before that, same as `TagsField`'s chip list.
            <li key={index} className="flex items-center gap-1.5">
              <Input
                value={student.name}
                placeholder="Student name"
                maxLength={100}
                aria-label={`Student ${index + 1} name`}
                onChange={(event) => updateRow(index, { name: event.target.value })}
                className="flex-1"
              />
              <Input
                value={student.grade}
                placeholder="Grade"
                maxLength={20}
                aria-label={`Student ${index + 1} grade`}
                onChange={(event) => updateRow(index, { grade: event.target.value })}
                className="w-24"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove student ${index + 1}`}
                onClick={() => removeRow(index)}
              >
                <X className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Photo or certificate management for one achievement — only ever rendered
 * once the record exists (edit mode), since both upload endpoints address an
 * `achievementId` that a not-yet-created record doesn't have. Each kind owns
 * its own array and its own cap (`ACHIEVEMENT_MAX_PHOTOS`/
 * `ACHIEVEMENT_MAX_CERTIFICATES` are separate counts, never a shared pool),
 * so the add control is disabled with a visible reason at its own cap —
 * never left to fail only after a file has already been picked.
 */
function AssetGroup({
  achievementId,
  kind,
  keys,
  onChanged,
}: {
  achievementId: string;
  kind: AchievementAssetKind;
  keys: string[];
  onChanged: (achievement: AchievementDTO) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);

  const isPhoto = kind === "PHOTO";
  const max = isPhoto ? ACHIEVEMENT_MAX_PHOTOS : ACHIEVEMENT_MAX_CERTIFICATES;
  const noun = isPhoto ? "photos" : "certificates";
  const atCap = keys.length >= max;

  async function onPick(file: File | undefined) {
    if (!file) return;
    const problem = isPhoto ? checkImageFile(file) : checkCertificateFile(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    setUploading(true);
    const next = await uploadAchievementAsset(achievementId, kind, file);
    setUploading(false);
    if (next) {
      toast.success(isPhoto ? "Photo added" : "Certificate added");
      onChanged(next);
    }
  }

  async function onRemove(key: string) {
    setRemovingKey(key);
    const next = await removeAchievementAsset(achievementId, kind, key);
    setRemovingKey(null);
    if (next) {
      toast.success(isPhoto ? "Photo removed" : "Certificate removed");
      onChanged(next);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-normal text-muted-foreground">
          {isPhoto ? "Photos" : "Certificates"} ({keys.length} of {max})
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={isPhoto ? ACCEPT_ATTRIBUTE : CERTIFICATE_ACCEPT_ATTRIBUTE}
          className="hidden"
          onChange={(event) => {
            void onPick(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={uploading || atCap}
          onClick={() => inputRef.current?.click()}
        >
          {isPhoto ? <ImagePlus className="size-3" /> : <Upload className="size-3" />}
          {uploading ? "Uploading…" : isPhoto ? "Add photo" : "Add certificate"}
        </Button>
      </div>
      {atCap ? (
        <p className="text-[11px] text-muted-foreground">Limit reached — delete one to add another.</p>
      ) : null}

      {keys.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No {noun} yet.</p>
      ) : isPhoto ? (
        <ul className="grid grid-cols-4 gap-2 sm:grid-cols-5">
          {keys.map((key, index) => (
            <li key={key} className="relative aspect-square overflow-hidden rounded-md border border-border bg-muted/40">
              <Image src={key} alt={`Achievement photo ${index + 1}`} fill unoptimized sizes="100px" className="object-cover" />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={removingKey === key}
                aria-label={`Remove photo ${index + 1}`}
                onClick={() => onRemove(key)}
                className="absolute top-1 right-1 bg-background/90 hover:bg-background"
              >
                <Trash2 className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-1">
          {keys.map((key, index) => (
            <li
              key={key}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
            >
              <a
                href={key}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 items-center gap-1 truncate underline-offset-4 hover:underline"
              >
                <FileText className="size-3 shrink-0" />
                <span className="truncate">Certificate {index + 1}</span>
                <ExternalLink className="size-3 shrink-0" />
              </a>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={removingKey === key}
                aria-label={`Remove certificate ${index + 1}`}
                onClick={() => onRemove(key)}
              >
                <Trash2 className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One form for create and edit, mirroring `media-section.tsx`'s dialog: plain
 * controlled state rather than `react-hook-form`, because the three-state
 * clearing rule for `description`/`eventDate` needs an explicit `null` built
 * by hand at submit time (`toClearable` above) — a `zodResolver` bound
 * straight to `achievementPatchSchema` would run `optionalText`/
 * `optionalDateSchema` on the raw `""` from a cleared field and silently
 * collapse it to `undefined` before this component ever saw it, which is
 * exactly the bug this task exists to avoid.
 *
 * Keyed by the caller on the achievement id (or `"create"`), so opening a
 * different achievement — or switching from edit back to create — remounts
 * this component with fresh draft state instead of needing an effect to
 * resync it.
 */
function AchievementDialog({
  state,
  onClose,
  onSaved,
  onAssetChanged,
}: {
  state: DialogState;
  onClose: () => void;
  onSaved: (achievement: AchievementDTO) => void;
  onAssetChanged: (achievement: AchievementDTO) => void;
}) {
  const editing = state.mode === "edit" ? state.achievement : null;

  const [category, setCategory] = useState<AchievementCategory>(
    (editing?.category as AchievementCategory) ?? "ACADEMIC",
  );
  const [title, setTitle] = useState(editing?.title ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [eventDate, setEventDate] = useState(editing?.eventDate?.slice(0, 10) ?? "");
  const [level, setLevel] = useState<AchievementLevel>((editing?.level as AchievementLevel) ?? "SCHOOL");
  const [students, setStudents] = useState<StudentDraft[]>(
    editing?.students?.map((student) => ({ name: student.name, grade: student.grade ?? "" })) ?? [],
  );
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error("Enter an achievement title.");
      return;
    }

    const studentsPayload = students
      .filter((student) => student.name.trim().length > 0)
      .map((student) => ({ name: student.name.trim(), grade: student.grade.trim() || undefined }));

    setSaving(true);
    const next = editing
      ? await patchAchievement(editing.id, {
          category,
          title: trimmedTitle,
          level,
          // Explicit `null` when cleared, never `""` — see `toClearable` above.
          description: toClearable(description),
          eventDate: toClearable(eventDate),
          students: studentsPayload,
        })
      : await createAchievement({
          category,
          title: trimmedTitle,
          level,
          description: toOptional(description),
          eventDate: toOptional(eventDate),
          students: studentsPayload,
        });
    setSaving(false);

    if (next) {
      toast.success(editing ? "Achievement updated" : "Achievement added");
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
          <DialogTitle>{editing ? "Edit achievement" : "Add an achievement"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes save immediately."
              : "Shown on the public profile once published, unless you hide it."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="achievement-category">Category</Label>
              <Select value={category} onValueChange={(value) => setCategory(value as AchievementCategory)}>
                <SelectTrigger id="achievement-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACHIEVEMENT_CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {ACHIEVEMENT_CATEGORY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="achievement-level">Level</Label>
              <Select value={level} onValueChange={(value) => setLevel(value as AchievementLevel)}>
                <SelectTrigger id="achievement-level" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACHIEVEMENT_LEVELS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {ACHIEVEMENT_LEVEL_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="achievement-title">Title</Label>
            <Input
              id="achievement-title"
              value={title}
              maxLength={120}
              disabled={saving}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="achievement-description">Description</Label>
            <Textarea
              id="achievement-description"
              value={description}
              maxLength={2000}
              disabled={saving}
              placeholder="What happened, and why it matters."
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="achievement-event-date">Event date</Label>
            <Input
              id="achievement-event-date"
              type="date"
              value={eventDate}
              disabled={saving}
              onChange={(event) => setEventDate(event.target.value)}
              className="max-w-[200px]"
            />
          </div>

          <StudentsEditor students={students} onChange={setStudents} />

          {editing ? (
            <div className="space-y-4 border-t border-border pt-4">
              <AssetGroup
                achievementId={editing.id}
                kind="PHOTO"
                keys={editing.photos ?? []}
                onChanged={onAssetChanged}
              />
              <AssetGroup
                achievementId={editing.id}
                kind="CERTIFICATE"
                keys={editing.certificates ?? []}
                onChanged={onAssetChanged}
              />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={saving} onClick={handleSubmit}>
            {saving ? "Saving…" : editing ? "Save changes" : "Add achievement"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One achievement in the list — summary plus the hide/edit/delete actions every record shares. */
function AchievementCard({
  achievement,
  busy,
  onToggleStatus,
  onEdit,
  onDeleteRequest,
}: {
  achievement: AchievementDTO;
  busy: boolean;
  onToggleStatus: () => void;
  onEdit: () => void;
  onDeleteRequest: () => void;
}) {
  const hidden = achievement.status === "HIDDEN";

  return (
    <li className="space-y-3 rounded-lg border border-border p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-medium">{achievement.title}</h3>
            {hidden ? <Badge variant="outline">Hidden</Badge> : null}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{categoryLabel(achievement.category)}</Badge>
            <Badge variant="outline">{levelLabel(achievement.level)}</Badge>
            {achievement.eventDate ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Calendar className="size-3" />
                {formatEventDate(achievement.eventDate)}
              </span>
            ) : null}
          </div>

          {achievement.description ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">{achievement.description}</p>
          ) : null}

          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Users className="size-3" />
              {achievement.students?.length ?? 0} students
            </span>
            <span className="inline-flex items-center gap-1">
              <ImagePlus className="size-3" />
              {achievement.photos?.length ?? 0} of {ACHIEVEMENT_MAX_PHOTOS} photos
            </span>
            <span className="inline-flex items-center gap-1">
              <FileText className="size-3" />
              {achievement.certificates?.length ?? 0} of {ACHIEVEMENT_MAX_CERTIFICATES} certificates
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button type="button" variant="outline" size="xs" disabled={busy} onClick={onToggleStatus}>
            {hidden ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
            {hidden ? "Show" : "Hide"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Edit ${achievement.title}`}
            onClick={onEdit}
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label={`Delete ${achievement.title}`}
            onClick={onDeleteRequest}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
    </li>
  );
}

export function AchievementsSection() {
  // `achievements` is `null` for both "still loading" and "the load failed" —
  // `loadFailed` is what tells those two apart. A failed fetch must NOT fall
  // back to `[]`: that reads identically to a genuine empty list, and an
  // admin who glances away sees "no achievements yet" for what is actually a
  // network hiccup — reasonable grounds to conclude their data is gone, or to
  // start re-entering records that still exist server-side.
  const [achievements, setAchievements] = useState<AchievementDTO[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AchievementDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dialogState, setDialogState] = useState<DialogState | null>(null);

  /**
   * Shared by the initial mount and the "Try again" retry control below.
   * Every `setState` here happens inside the `.then()` — after a real
   * `await`, never synchronously in the body — because a synchronous
   * `setState` called directly from an effect (this function is invoked as
   * `useEffect(() => loadAchievements(), ...)` below) trips the React
   * Compiler's "calling setState synchronously within an effect can trigger
   * cascading renders" check. `loadFailed` is only ever set to its next real
   * value (`true` on failure, `false` alongside the fresh data on success),
   * never pre-emptively reset before the request even starts.
   */
  const loadAchievements = useCallback(() => {
    let cancelled = false;
    void fetchAchievements().then((rows) => {
      if (cancelled) return;
      if (rows === null) {
        setLoadFailed(true);
      } else {
        setAchievements(rows);
        setLoadFailed(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => loadAchievements(), [loadAchievements]);

  async function toggleStatus(achievement: AchievementDTO) {
    const nextStatus = achievement.status === "HIDDEN" ? "ACTIVE" : "HIDDEN";
    setStatusBusyId(achievement.id);
    const next = await patchAchievement(achievement.id, { status: nextStatus });
    setStatusBusyId(null);
    if (next) {
      toast.success(nextStatus === "HIDDEN" ? "Hidden" : "Shown");
      setAchievements((prev) => (prev ? prev.map((row) => (row.id === next.id ? next : row)) : prev));
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    const ok = await deleteAchievement(pendingDelete.id);
    setDeleting(false);
    if (ok) {
      toast.success("Achievement deleted");
      const deletedId = pendingDelete.id;
      setAchievements((prev) => (prev ? prev.filter((row) => row.id !== deletedId) : prev));
      setPendingDelete(null);
    }
  }

  /** After an asset upload/remove: refresh the list and the open dialog's copy, but keep it open. */
  function syncAchievement(next: AchievementDTO) {
    setAchievements((prev) => (prev ? prev.map((row) => (row.id === next.id ? next : row)) : prev));
    setDialogState((prev) =>
      prev && prev.mode === "edit" && prev.achievement.id === next.id
        ? { mode: "edit", achievement: next }
        : prev,
    );
  }

  /** After Save/Create succeeds: update the list (insert or replace by id) and close the dialog. */
  function handleSaved(next: AchievementDTO) {
    setAchievements((prev) => {
      if (!prev) return [next];
      const exists = prev.some((row) => row.id === next.id);
      return exists ? prev.map((row) => (row.id === next.id ? next : row)) : [next, ...prev];
    });
    setDialogState(null);
  }

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold tracking-tight">Achievements</h2>
          <p className="text-xs text-muted-foreground">
            Academic, sports and cultural wins that show a parent your school&apos;s track record.
            Hidden achievements stay here but are left out of the public profile.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setDialogState({ mode: "create" })}>
          <Plus className="size-3.5" />
          Add achievement
        </Button>
      </div>

      {achievements === null && loadFailed ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
          <TriangleAlert className="size-4 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">Could not load achievements.</p>
          <p className="text-xs text-muted-foreground">
            This is a failed request, not an empty list — your existing achievements are safe.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => loadAchievements()}>
            Try again
          </Button>
        </div>
      ) : achievements === null ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : achievements.length === 0 ? (
        <EmptyState
          icon={Award}
          title="No achievements yet"
          description="Add a school, district, state or national win — with the students behind it — to show on your public profile."
        />
      ) : (
        <ul className="space-y-3">
          {achievements.map((achievement) => (
            <AchievementCard
              key={achievement.id}
              achievement={achievement}
              busy={statusBusyId === achievement.id}
              onToggleStatus={() => toggleStatus(achievement)}
              onEdit={() => setDialogState({ mode: "edit", achievement })}
              onDeleteRequest={() => setPendingDelete(achievement)}
            />
          ))}
        </ul>
      )}

      {dialogState ? (
        <AchievementDialog
          key={dialogState.mode === "edit" ? dialogState.achievement.id : "create"}
          state={dialogState}
          onClose={() => setDialogState(null)}
          onSaved={handleSaved}
          onAssetChanged={syncAchievement}
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
            <DialogTitle>Delete this achievement?</DialogTitle>
            <DialogDescription>
              &ldquo;{pendingDelete?.title ?? "Untitled"}&rdquo; and its photos and certificates will
              be removed and deleted from storage. This cannot be undone — to take it off the public
              profile without losing it, hide it instead.
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
