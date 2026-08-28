"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Eye,
  EyeOff,
  GraduationCap,
  ImagePlus,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  User,
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
import { ALUMNI_CATEGORIES, ALUMNI_CATEGORY_LABELS, type AlumniCategory } from "@/lib/constants";
import type { AlumnusDTO } from "@/services/alumni.service";
import { ACCEPT_ATTRIBUTE, checkImageFile } from "@/components/profile/media-upload";

/**
 * Same shape as `achievements-section.tsx`: alumni are not part of
 * `ProfileDTO` — Task 9 gave them their own collection and their own
 * `/api/settings/alumni*` routes, so this section owns its data end to end.
 * It fetches its own list on mount and keeps it in local state; every action
 * below is its own immediate request, and nothing here participates in the
 * "unsaved changes" dialog the field-based sections use.
 */

type DialogState = { mode: "create" } | { mode: "edit"; alumnus: AlumnusDTO };

/**
 * `AlumnusDTO.category` is typed as plain `string` on the service (the
 * model's enum constraint is the real guard, not this DTO), so indexing
 * `ALUMNI_CATEGORY_LABELS` — keyed by the narrow literal union — needs a
 * defensive cast with a fallback rather than an unchecked index. Same
 * reasoning as `achievements-section.tsx`'s `categoryLabel`.
 */
function categoryLabel(category: string): string {
  return ALUMNI_CATEGORY_LABELS[category as AlumniCategory] ?? category;
}

/**
 * Blank means "clear it," not "leave it alone." `batch`, `currentRole`,
 * `org` and `note` are all `.nullable()` on `alumnusPatchSchema`
 * (`lib/validation/showcase.ts`) precisely so an admin can blank one out
 * after having once given it a value — a mis-entered cohort, a role that's
 * no longer current, an org typed by mistake, a stale note. Sending `""`
 * instead would pass through `optionalText` and collapse to `undefined`,
 * which `JSON.stringify` then drops from the request body — indistinguishable
 * from "not supplied," so the server would leave the old value in place.
 * Explicit `null` is the only way to actually clear any of the four on a
 * PATCH, which is why every edit-save below sends this, never `""`. Same
 * convention as `achievements-section.tsx`'s `toClearable`, which documents
 * the media-caption bug this pattern exists to avoid.
 */
function toClearable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The create-time counterpart: `alumnusCreateSchema`'s `batch`/`currentRole`/
 * `org`/`note` are NOT `.nullable()` (there is no stored value yet to
 * clear), so sending `null` there would fail validation. Blank means "omit
 * the key," i.e. `undefined`, not `null`.
 */
function toOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function fetchAlumni(): Promise<AlumnusDTO[] | null> {
  try {
    const response = await fetch("/api/settings/alumni");
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not load alumni. Please try again.");
      return null;
    }
    return payload.alumni as AlumnusDTO[];
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

async function createAlumnus(input: Record<string, unknown>): Promise<AlumnusDTO | null> {
  try {
    const response = await fetch("/api/settings/alumni", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not add the alumnus. Please try again.");
      return null;
    }
    return payload.alumnus as AlumnusDTO;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

async function patchAlumnus(
  alumnusId: string,
  patch: Record<string, unknown>,
): Promise<AlumnusDTO | null> {
  try {
    const response = await fetch(`/api/settings/alumni/${alumnusId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not update the alumnus. Please try again.");
      return null;
    }
    return payload.alumnus as AlumnusDTO;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

async function deleteAlumnus(alumnusId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/settings/alumni/${alumnusId}`, {
      method: "DELETE",
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not delete the alumnus. Please try again.");
      return false;
    }
    return true;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return false;
  }
}

async function uploadAlumnusPhoto(alumnusId: string, file: File): Promise<AlumnusDTO | null> {
  const body = new FormData();
  body.append("file", file);
  try {
    const response = await fetch(`/api/settings/alumni/${alumnusId}/photo`, {
      method: "POST",
      body,
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not upload the photo. Please try again.");
      return null;
    }
    return payload.alumnus as AlumnusDTO;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

/**
 * Only ever rendered once the record exists (edit mode), since the upload
 * endpoint addresses an `alumnusId` a not-yet-created record doesn't have —
 * same constraint as `achievements-section.tsx`'s `AssetGroup`.
 *
 * Unlike achievements' photos, an alumnus has exactly one: `AlumniService.
 * setPhoto` replaces it and deletes whatever object the write displaced.
 * There is no photo-removal endpoint (a known, already-flagged product gap),
 * so this offers only "Add photo" / "Replace photo" — never a clear/remove
 * control, and never a DELETE call.
 */
function AlumnusPhotoField({
  alumnusId,
  photo,
  onChanged,
}: {
  alumnusId: string;
  photo?: string;
  onChanged: (alumnus: AlumnusDTO) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function onPick(file: File | undefined) {
    if (!file) return;
    const problem = checkImageFile(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    setUploading(true);
    const next = await uploadAlumnusPhoto(alumnusId, file);
    setUploading(false);
    if (next) {
      toast.success("Photo updated");
      onChanged(next);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-normal text-muted-foreground">Photo</p>
      <div className="flex items-center gap-3">
        <div className="relative size-16 shrink-0 overflow-hidden rounded-md border border-border bg-muted/40">
          {photo ? (
            <Image src={photo} alt="" fill unoptimized sizes="64px" className="object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <User className="size-6" aria-hidden />
            </div>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
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
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          <ImagePlus className="size-3" />
          {uploading ? "Uploading…" : photo ? "Replace photo" : "Add photo"}
        </Button>
      </div>
    </div>
  );
}

/**
 * One form for create and edit, mirroring `achievements-section.tsx`'s
 * `AchievementDialog`: plain controlled state rather than `react-hook-form`,
 * because the three-state clearing rule for `batch`/`currentRole`/`org`/
 * `note` needs an explicit `null` built by hand at submit time (`toClearable`
 * above) — a `zodResolver` bound straight to `alumnusPatchSchema` would run
 * `optionalText` on the raw `""` from a cleared field and silently collapse
 * it to `undefined` before this component ever saw it.
 *
 * Keyed by the caller on the alumnus id (or `"create"`), so opening a
 * different alumnus — or switching from edit back to create — remounts this
 * component with fresh draft state instead of needing an effect to resync it.
 */
function AlumnusDialog({
  state,
  onClose,
  onSaved,
  onPhotoChanged,
}: {
  state: DialogState;
  onClose: () => void;
  onSaved: (alumnus: AlumnusDTO) => void;
  onPhotoChanged: (alumnus: AlumnusDTO) => void;
}) {
  const editing = state.mode === "edit" ? state.alumnus : null;

  const [category, setCategory] = useState<AlumniCategory>(
    (editing?.category as AlumniCategory) ?? "OTHER",
  );
  const [name, setName] = useState(editing?.name ?? "");
  const [batch, setBatch] = useState(editing?.batch ?? "");
  const [currentRole, setCurrentRole] = useState(editing?.currentRole ?? "");
  const [org, setOrg] = useState(editing?.org ?? "");
  const [note, setNote] = useState(editing?.note ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Enter the alumnus's name.");
      return;
    }

    setSaving(true);
    const next = editing
      ? await patchAlumnus(editing.id, {
          category,
          name: trimmedName,
          // Explicit `null` when cleared, never `""` — see `toClearable` above.
          batch: toClearable(batch),
          currentRole: toClearable(currentRole),
          org: toClearable(org),
          note: toClearable(note),
        })
      : await createAlumnus({
          category,
          name: trimmedName,
          batch: toOptional(batch),
          currentRole: toOptional(currentRole),
          org: toOptional(org),
          note: toOptional(note),
        });
    setSaving(false);

    if (next) {
      toast.success(editing ? "Alumnus updated" : "Alumnus added");
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
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit alumnus" : "Add an alumnus"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes save immediately."
              : "Shown on the public profile once published, unless you hide it."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="alumnus-name">Name</Label>
              <Input
                id="alumnus-name"
                value={name}
                maxLength={100}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="alumnus-category">Category</Label>
              <Select value={category} onValueChange={(value) => setCategory(value as AlumniCategory)}>
                <SelectTrigger id="alumnus-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALUMNI_CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {ALUMNI_CATEGORY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            {/*
             * Free text, deliberately: "2015" or "2012-2015" are both valid
             * and neither is a date. No date picker, no year dropdown, no
             * range validation — `alumnusCreateSchema`/`alumnusPatchSchema`
             * treat `batch` as an ordinary string, and normalising it here
             * would reject inputs the server happily accepts.
             */}
            <Label htmlFor="alumnus-batch">Batch</Label>
            <Input
              id="alumnus-batch"
              value={batch}
              maxLength={20}
              disabled={saving}
              placeholder="e.g. 2015 or 2012-2015"
              onChange={(event) => setBatch(event.target.value)}
              className="max-w-[220px]"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="alumnus-role">Current role</Label>
              <Input
                id="alumnus-role"
                value={currentRole}
                maxLength={120}
                disabled={saving}
                onChange={(event) => setCurrentRole(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="alumnus-org">Organisation</Label>
              <Input
                id="alumnus-org"
                value={org}
                maxLength={120}
                disabled={saving}
                onChange={(event) => setOrg(event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="alumnus-note">Note</Label>
            <Textarea
              id="alumnus-note"
              value={note}
              maxLength={500}
              disabled={saving}
              placeholder="Anything else worth mentioning about this alumnus."
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          {editing ? (
            <div className="border-t border-border pt-4">
              <AlumnusPhotoField
                alumnusId={editing.id}
                photo={editing.photo}
                onChanged={onPhotoChanged}
              />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={saving} onClick={handleSubmit}>
            {saving ? "Saving…" : editing ? "Save changes" : "Add alumnus"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One alumnus in the list — photo, summary, and the hide/edit/delete actions every record shares. */
function AlumnusCard({
  alumnus,
  busy,
  onToggleStatus,
  onEdit,
  onDeleteRequest,
}: {
  alumnus: AlumnusDTO;
  busy: boolean;
  onToggleStatus: () => void;
  onEdit: () => void;
  onDeleteRequest: () => void;
}) {
  const hidden = alumnus.status === "HIDDEN";
  const roleLine = [alumnus.currentRole, alumnus.org].filter(Boolean).join(" · ");

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border p-3 sm:p-4">
      <div className="relative size-12 shrink-0 overflow-hidden rounded-full border border-border bg-muted/40">
        {alumnus.photo ? (
          <Image src={alumnus.photo} alt="" fill unoptimized sizes="48px" className="object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <User className="size-5" aria-hidden />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="text-sm font-medium">{alumnus.name}</h3>
          {hidden ? <Badge variant="outline">Hidden</Badge> : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{categoryLabel(alumnus.category)}</Badge>
          {alumnus.batch ? <Badge variant="outline">{alumnus.batch}</Badge> : null}
        </div>

        {roleLine ? <p className="text-xs text-muted-foreground">{roleLine}</p> : null}
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
          aria-label={`Edit ${alumnus.name}`}
          onClick={onEdit}
        >
          <Pencil className="size-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          aria-label={`Delete ${alumnus.name}`}
          onClick={onDeleteRequest}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </li>
  );
}

export function AlumniSection() {
  // `alumni` is `null` for both "still loading" and "the load failed" —
  // `loadFailed` is what tells those two apart. A failed fetch must NOT fall
  // back to `[]`: that reads identically to a genuine empty list, and an
  // admin who glances away sees "no alumni yet" for what is actually a
  // network hiccup — reasonable grounds to conclude their data is gone, or
  // to start re-entering records that still exist server-side. Same
  // convention as `achievements-section.tsx`.
  const [alumni, setAlumni] = useState<AlumnusDTO[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AlumnusDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dialogState, setDialogState] = useState<DialogState | null>(null);

  /**
   * Shared by the initial mount and the "Try again" retry control below.
   * Every `setState` here happens inside the `.then()` — after a real
   * `await`, never synchronously in the body — because a synchronous
   * `setState` called directly from an effect (this function is invoked as
   * `useEffect(() => loadAlumni(), ...)` below) trips the React Compiler's
   * "calling setState synchronously within an effect can trigger cascading
   * renders" check. `loadFailed` is only ever set to its next real value
   * (`true` on failure, `false` alongside the fresh data on success), never
   * pre-emptively reset before the request even starts.
   */
  const loadAlumni = useCallback(() => {
    let cancelled = false;
    void fetchAlumni().then((rows) => {
      if (cancelled) return;
      if (rows === null) {
        setLoadFailed(true);
      } else {
        setAlumni(rows);
        setLoadFailed(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => loadAlumni(), [loadAlumni]);

  async function toggleStatus(alumnus: AlumnusDTO) {
    const nextStatus = alumnus.status === "HIDDEN" ? "ACTIVE" : "HIDDEN";
    setStatusBusyId(alumnus.id);
    const next = await patchAlumnus(alumnus.id, { status: nextStatus });
    setStatusBusyId(null);
    if (next) {
      toast.success(nextStatus === "HIDDEN" ? "Hidden" : "Shown");
      setAlumni((prev) => (prev ? prev.map((row) => (row.id === next.id ? next : row)) : prev));
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    const ok = await deleteAlumnus(pendingDelete.id);
    setDeleting(false);
    if (ok) {
      toast.success("Alumnus deleted");
      const deletedId = pendingDelete.id;
      setAlumni((prev) => (prev ? prev.filter((row) => row.id !== deletedId) : prev));
      setPendingDelete(null);
    }
  }

  /** After a photo upload: refresh the list and the open dialog's copy, but keep it open. */
  function syncAlumnus(next: AlumnusDTO) {
    setAlumni((prev) => (prev ? prev.map((row) => (row.id === next.id ? next : row)) : prev));
    setDialogState((prev) =>
      prev && prev.mode === "edit" && prev.alumnus.id === next.id
        ? { mode: "edit", alumnus: next }
        : prev,
    );
  }

  /** After Save/Create succeeds: update the list (insert or replace by id) and close the dialog. */
  function handleSaved(next: AlumnusDTO) {
    setAlumni((prev) => {
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
          <h2 className="text-sm font-semibold tracking-tight">Notable alumni</h2>
          <p className="text-xs text-muted-foreground">
            Doctors, engineers, civil servants and other alumni who show a parent what your
            school&apos;s students go on to become. Hidden alumni stay here but are left out of
            the public profile.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setDialogState({ mode: "create" })}>
          <Plus className="size-3.5" />
          Add alumnus
        </Button>
      </div>

      {alumni === null && loadFailed ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
          <TriangleAlert className="size-4 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">Could not load alumni.</p>
          <p className="text-xs text-muted-foreground">
            This is a failed request, not an empty list — your existing alumni are safe.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => loadAlumni()}>
            Try again
          </Button>
        </div>
      ) : alumni === null ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : alumni.length === 0 ? (
        <EmptyState
          icon={GraduationCap}
          title="No alumni yet"
          description="Add a notable alumnus — with their batch, current role and organisation — to show on your public profile."
        />
      ) : (
        <ul className="space-y-3">
          {alumni.map((alumnus) => (
            <AlumnusCard
              key={alumnus.id}
              alumnus={alumnus}
              busy={statusBusyId === alumnus.id}
              onToggleStatus={() => toggleStatus(alumnus)}
              onEdit={() => setDialogState({ mode: "edit", alumnus })}
              onDeleteRequest={() => setPendingDelete(alumnus)}
            />
          ))}
        </ul>
      )}

      {dialogState ? (
        <AlumnusDialog
          key={dialogState.mode === "edit" ? dialogState.alumnus.id : "create"}
          state={dialogState}
          onClose={() => setDialogState(null)}
          onSaved={handleSaved}
          onPhotoChanged={syncAlumnus}
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
            <DialogTitle>Delete this alumnus?</DialogTitle>
            <DialogDescription>
              &ldquo;{pendingDelete?.name ?? "Untitled"}&rdquo; and their photo will be removed
              and deleted from storage. This cannot be undone — to take them off the public
              profile without losing the record, hide them instead.
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
