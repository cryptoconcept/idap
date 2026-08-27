"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  ExternalLink,
  ImagePlus,
  Link2,
  Pencil,
  Trash2,
  Upload,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { cn } from "@/lib/utils";
import { MEDIA_CAPTION_MAX, MEDIA_KIND_LABELS, MEDIA_MAX_ITEMS, MEDIA_MAX_PDF_BYTES } from "@/lib/constants";
import type { MediaProvider } from "@/lib/constants";
import type { ProfileDTO } from "@/lib/types";
import { normalizeVideoUrl } from "@/lib/media/video-url";
import {
  ACCEPT_ATTRIBUTE,
  PDF_ACCEPT_ATTRIBUTE,
  addMediaVideo,
  checkImageFile,
  checkPdfFile,
  deleteMediaItem,
  patchMediaItem,
  titleFromFileName,
  uploadMedia,
} from "@/components/profile/media-upload";

type MediaItem = NonNullable<ProfileDTO["media"]>[number];
type DocumentKind = "BROCHURE" | "PROSPECTUS";

const PROVIDER_LABELS: Record<MediaProvider, string> = {
  YOUTUBE: "YouTube",
  VIMEO: "Vimeo",
};

/** Matches the server's own sort (`public-projection.ts`): by `sortOrder`, then `uploadedAt` to break ties. */
function byOrder(a: MediaItem, b: MediaItem): number {
  return a.sortOrder - b.sortOrder || a.uploadedAt.localeCompare(b.uploadedAt);
}

function kindNoun(item: MediaItem): string {
  switch (item.kind) {
    case "IMAGE":
      return "image";
    case "VIDEO":
      return "video";
    case "BROCHURE":
      return "brochure";
    case "PROSPECTUS":
      return "prospectus";
    default:
      return "item";
  }
}

/**
 * View/edit toggle for one item's caption. State (which item is being edited,
 * and the in-progress draft) lives in the parent so a save can refresh the
 * whole profile without this component needing to know about that request.
 */
function CaptionField({
  item,
  isEditing,
  draft,
  busy,
  onEdit,
  onDraftChange,
  onSave,
  onCancel,
}: {
  item: MediaItem;
  isEditing: boolean;
  draft: string;
  busy: boolean;
  onEdit: () => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (isEditing) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={draft}
          maxLength={MEDIA_CAPTION_MAX}
          disabled={busy}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSave();
            if (event.key === "Escape") onCancel();
          }}
          className="h-7 text-xs"
          aria-label={`Caption for ${item.title ?? kindNoun(item)}`}
        />
        <Button type="button" size="xs" disabled={busy} onClick={onSave}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={item.caption}>
        {item.caption ? item.caption : <span className="italic">No caption</span>}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={busy}
        aria-label={`Edit caption for ${item.title ?? kindNoun(item)}`}
        onClick={onEdit}
      >
        <Pencil className="size-3" />
      </Button>
    </div>
  );
}

/** Move up/down, hide/show, and delete — the three actions every item shares. */
function ItemActions({
  item,
  index,
  count,
  busy,
  reorderDisabled,
  onMoveUp,
  onMoveDown,
  onToggleStatus,
  onDelete,
}: {
  item: MediaItem;
  index: number;
  count: number;
  busy: boolean;
  reorderDisabled: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
  const hidden = item.status === "HIDDEN";

  return (
    <div className="flex items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Move ${item.title ?? kindNoun(item)} up`}
        disabled={reorderDisabled || index <= 0}
        onClick={onMoveUp}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Move ${item.title ?? kindNoun(item)} down`}
        disabled={reorderDisabled || index >= count - 1}
        onClick={onMoveDown}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button type="button" variant="outline" size="xs" disabled={busy} onClick={onToggleStatus}>
        {hidden ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
        {hidden ? "Show" : "Hide"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={busy}
        aria-label={`Delete ${item.title ?? kindNoun(item)}`}
        onClick={onDelete}
      >
        <Trash2 className="size-3" />
      </Button>
    </div>
  );
}

/**
 * One kind's upload control. A component of its own (not a loop body) so its
 * `useRef`/`useState` are legal — there are exactly two of these (brochure,
 * prospectus), each a distinct element in the tree, never a variable-length
 * list of hooks.
 */
function DocumentUploadButton({
  kind,
  count,
  onFile,
}: {
  kind: DocumentKind;
  count: number;
  onFile: (file: File) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const atCap = count >= MEDIA_MAX_ITEMS[kind];
  const noun = kind === "BROCHURE" ? "brochure" : "prospectus";
  const plural = kind === "BROCHURE" ? "brochures" : "prospectuses";

  async function onPick(file: File | undefined) {
    if (!file) return;
    const problem = checkPdfFile(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    setUploading(true);
    await onFile(file);
    setUploading(false);
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <input
        ref={inputRef}
        type="file"
        accept={PDF_ACCEPT_ATTRIBUTE}
        className="hidden"
        onChange={(event) => {
          void onPick(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={uploading || atCap}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="size-3.5" />
        {uploading ? "Uploading…" : `Upload ${noun}`}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        {count} of {MEDIA_MAX_ITEMS[kind]} {plural}
        {atCap ? " — delete one to add another." : ""}
      </p>
    </div>
  );
}

type CaptionProps = {
  editingId: string | null;
  draft: string;
  onEdit: (item: MediaItem) => void;
  onDraftChange: (value: string) => void;
  onSave: (item: MediaItem) => void;
  onCancel: () => void;
};

type ItemProps = {
  busyId: string | null;
  onMove: (group: MediaItem[], item: MediaItem, direction: -1 | 1) => void;
  onToggleStatus: (item: MediaItem) => void;
  onDeleteRequest: (item: MediaItem) => void;
};

function PhotosGroup({
  items,
  uploading,
  onUpload,
  caption,
  actions,
}: {
  items: MediaItem[];
  uploading: boolean;
  onUpload: (files: FileList | null) => void;
  caption: CaptionProps;
  actions: ItemProps;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const atCap = items.length >= MEDIA_MAX_ITEMS.IMAGE;

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold tracking-tight">Photos</h3>
          <p className="text-xs text-muted-foreground">
            {items.length} of {MEDIA_MAX_ITEMS.IMAGE} images. Hidden images stay here but are left
            out of the public profile.
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          className="hidden"
          onChange={(event) => {
            onUpload(event.target.files);
            event.target.value = "";
          }}
        />
        <div className="flex flex-col items-end gap-1">
          <Button
            type="button"
            size="sm"
            disabled={uploading || atCap}
            onClick={() => inputRef.current?.click()}
          >
            <ImagePlus className="size-3.5" />
            {uploading ? "Uploading…" : "Upload images"}
          </Button>
          {atCap ? (
            <p className="text-[11px] text-muted-foreground">Limit reached — delete one to add another.</p>
          ) : null}
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={ImagePlus}
          title="No photos yet"
          description="Add photographs of the campus, classrooms and events. They are the first thing a parent looks at on your public profile. JPG, PNG or WEBP, up to 5 MB each."
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((item, index) => {
            const hidden = item.status === "HIDDEN";
            const busy = actions.busyId === item.id;
            const isEditingCaption = caption.editingId === item.id;

            return (
              <li
                key={item.id}
                className="space-y-2 overflow-hidden rounded-lg border border-border p-2"
              >
                <div className="relative aspect-[4/3] w-full overflow-hidden rounded bg-muted/40">
                  <Image
                    src={item.url}
                    alt={item.title ?? "Photo"}
                    fill
                    unoptimized
                    sizes="(min-width: 640px) 220px, 45vw"
                    className={hidden ? "object-cover opacity-40" : "object-cover"}
                  />
                  {hidden ? (
                    <span className="absolute top-1.5 left-1.5 rounded-full border border-dashed border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                      Hidden
                    </span>
                  ) : null}
                </div>

                <p className="truncate text-xs font-medium" title={item.title}>
                  {item.title ?? "Untitled"}
                </p>

                <CaptionField
                  item={item}
                  isEditing={isEditingCaption}
                  draft={caption.draft}
                  busy={busy}
                  onEdit={() => caption.onEdit(item)}
                  onDraftChange={caption.onDraftChange}
                  onSave={() => caption.onSave(item)}
                  onCancel={caption.onCancel}
                />

                <ItemActions
                  item={item}
                  index={index}
                  count={items.length}
                  busy={busy}
                  reorderDisabled={actions.busyId !== null}
                  onMoveUp={() => actions.onMove(items, item, -1)}
                  onMoveDown={() => actions.onMove(items, item, 1)}
                  onToggleStatus={() => actions.onToggleStatus(item)}
                  onDelete={() => actions.onDeleteRequest(item)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function VideosGroup({
  items,
  videoUrl,
  videoTitle,
  addingVideo,
  onVideoUrlChange,
  onVideoTitleChange,
  onAddVideo,
  caption,
  actions,
}: {
  items: MediaItem[];
  videoUrl: string;
  videoTitle: string;
  addingVideo: boolean;
  onVideoUrlChange: (value: string) => void;
  onVideoTitleChange: (value: string) => void;
  onAddVideo: () => void;
  caption: CaptionProps;
  actions: ItemProps;
}) {
  const atCap = items.length >= MEDIA_MAX_ITEMS.VIDEO;

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold tracking-tight">Videos</h3>
        <p className="text-xs text-muted-foreground">
          {items.length} of {MEDIA_MAX_ITEMS.VIDEO} videos. Paste a YouTube or Vimeo link — the
          video plays on the public profile, not here.
        </p>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onAddVideo();
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="min-w-[220px] flex-1 space-y-1">
          <Label htmlFor="media-video-url" className="text-xs font-normal text-muted-foreground">
            Video link
          </Label>
          <Input
            id="media-video-url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={videoUrl}
            disabled={addingVideo || atCap}
            onChange={(event) => onVideoUrlChange(event.target.value)}
          />
        </div>
        <div className="min-w-[160px] space-y-1">
          <Label htmlFor="media-video-title" className="text-xs font-normal text-muted-foreground">
            Title (optional)
          </Label>
          <Input
            id="media-video-title"
            value={videoTitle}
            disabled={addingVideo || atCap}
            onChange={(event) => onVideoTitleChange(event.target.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={addingVideo || atCap || videoUrl.trim().length === 0}>
          <Link2 className="size-3.5" />
          {addingVideo ? "Adding…" : "Add video"}
        </Button>
      </form>
      {atCap ? (
        <p className="text-[11px] text-muted-foreground">
          Limit reached — delete a video to add another.
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon={Video}
          title="No videos yet"
          description="Paste a link to a YouTube or Vimeo video — a campus tour or a message from the principal work well."
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {items.map((item, index) => {
            const hidden = item.status === "HIDDEN";
            const busy = actions.busyId === item.id;
            const isEditingCaption = caption.editingId === item.id;

            return (
              <li
                key={item.id}
                className="space-y-2 overflow-hidden rounded-lg border border-border p-2"
              >
                <div className="relative aspect-video w-full overflow-hidden rounded bg-muted/40">
                  {item.provider === "YOUTUBE" && item.videoId ? (
                    <Image
                      src={`https://img.youtube.com/vi/${item.videoId}/hqdefault.jpg`}
                      alt={item.title ?? "Video thumbnail"}
                      fill
                      unoptimized
                      sizes="(min-width: 640px) 260px, 90vw"
                      className={hidden ? "object-cover opacity-40" : "object-cover"}
                    />
                  ) : (
                    // Vimeo has no key-less public thumbnail endpoint the way YouTube
                    // does — its oEmbed API needs a network round trip this dashboard
                    // has no reason to make just to draw a preview. A neutral
                    // placeholder stands in instead of embedding a player.
                    <div
                      className={cn(
                        "flex h-full flex-col items-center justify-center gap-1.5 text-muted-foreground",
                        hidden && "opacity-40",
                      )}
                    >
                      <Video className="size-6" aria-hidden />
                      <span className="text-xs">Vimeo video</span>
                    </div>
                  )}
                  {hidden ? (
                    <span className="absolute top-1.5 left-1.5 rounded-full border border-dashed border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                      Hidden
                    </span>
                  ) : null}
                </div>

                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 flex-1 truncate text-xs font-medium" title={item.title}>
                    {item.title ?? "Untitled"}
                  </p>
                  <Badge variant="outline" className="shrink-0">
                    {item.provider ? PROVIDER_LABELS[item.provider] : "Video"}
                  </Badge>
                </div>

                <CaptionField
                  item={item}
                  isEditing={isEditingCaption}
                  draft={caption.draft}
                  busy={busy}
                  onEdit={() => caption.onEdit(item)}
                  onDraftChange={caption.onDraftChange}
                  onSave={() => caption.onSave(item)}
                  onCancel={caption.onCancel}
                />

                <div className="flex items-center justify-between gap-1">
                  <ItemActions
                    item={item}
                    index={index}
                    count={items.length}
                    busy={busy}
                    reorderDisabled={actions.busyId !== null}
                    onMoveUp={() => actions.onMove(items, item, -1)}
                    onMoveDown={() => actions.onMove(items, item, 1)}
                    onToggleStatus={() => actions.onToggleStatus(item)}
                    onDelete={() => actions.onDeleteRequest(item)}
                  />
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    Open
                    <ExternalLink className="size-3" />
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DocumentsGroup({
  items,
  onUploadDocument,
  caption,
  actions,
}: {
  items: MediaItem[];
  onUploadDocument: (file: File, kind: DocumentKind) => Promise<void>;
  caption: CaptionProps;
  actions: ItemProps;
}) {
  const brochures = items.filter((item) => item.kind === "BROCHURE");
  const prospectuses = items.filter((item) => item.kind === "PROSPECTUS");

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold tracking-tight">Documents</h3>
        <p className="text-xs text-muted-foreground">
          Brochures and prospectuses a parent can download from the public profile. PDF only, up
          to {Math.floor(MEDIA_MAX_PDF_BYTES / (1024 * 1024))} MB each.
        </p>
      </div>

      <div className="flex flex-wrap gap-4">
        <DocumentUploadButton
          kind="BROCHURE"
          count={brochures.length}
          onFile={(file) => onUploadDocument(file, "BROCHURE")}
        />
        <DocumentUploadButton
          kind="PROSPECTUS"
          count={prospectuses.length}
          onFile={(file) => onUploadDocument(file, "PROSPECTUS")}
        />
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Upload}
          title="No documents yet"
          description="Add a brochure or prospectus so a parent can download it before applying."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[110px]">Kind</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Caption</TableHead>
                {/* No "size" column: the media model and API never record byte
                    size for a document (`Institution.ts`'s `MediaItemSchema`
                    has no such field), so there is nothing to show here. */}
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const hidden = item.status === "HIDDEN";
                const busy = actions.busyId === item.id;
                const isEditingCaption = caption.editingId === item.id;
                const group = item.kind === "BROCHURE" ? brochures : prospectuses;
                const groupIndex = group.findIndex((entry) => entry.id === item.id);

                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Badge variant="outline">{MEDIA_KIND_LABELS[item.kind]}</Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                      >
                        {item.title ?? "Untitled"}
                        <ExternalLink className="size-3" />
                      </a>
                      {hidden ? (
                        <Badge variant="outline" className="ml-2">
                          Hidden
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-[280px]">
                      <CaptionField
                        item={item}
                        isEditing={isEditingCaption}
                        draft={caption.draft}
                        busy={busy}
                        onEdit={() => caption.onEdit(item)}
                        onDraftChange={caption.onDraftChange}
                        onSave={() => caption.onSave(item)}
                        onCancel={caption.onCancel}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end">
                        <ItemActions
                          item={item}
                          index={groupIndex}
                          count={group.length}
                          busy={busy}
                          reorderDisabled={actions.busyId !== null}
                          onMoveUp={() => actions.onMove(group, item, -1)}
                          onMoveDown={() => actions.onMove(group, item, 1)}
                          onToggleStatus={() => actions.onToggleStatus(item)}
                          onDelete={() => actions.onDeleteRequest(item)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

/**
 * Not a form: every action here is its own request against the media
 * endpoints, so there is nothing to save and nothing to make dirty. Replaces
 * the old flat-grid `GallerySection` with three kind-grouped sections —
 * Photos, Videos, Documents — each with its own add control, capped per
 * `MEDIA_MAX_ITEMS`.
 */
export function MediaSection({
  profile,
  onProfile,
}: {
  profile: ProfileDTO;
  onProfile: (profile: ProfileDTO) => void;
}) {
  const items = profile.media ?? [];
  const photos = items.filter((item) => item.kind === "IMAGE").sort(byOrder);
  const videos = items.filter((item) => item.kind === "VIDEO").sort(byOrder);
  const documents = items
    .filter((item) => item.kind === "BROCHURE" || item.kind === "PROSPECTUS")
    .sort(byOrder);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [editingCaptionId, setEditingCaptionId] = useState<string | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<MediaItem | null>(null);

  const [videoUrl, setVideoUrl] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [addingVideo, setAddingVideo] = useState(false);

  async function uploadPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;

    const chosen = Array.from(files);
    const remaining = MEDIA_MAX_ITEMS.IMAGE - photos.length;
    if (chosen.length > remaining) {
      toast.error(
        `Photos hold at most ${MEDIA_MAX_ITEMS.IMAGE} images. There is room for ${remaining} more.`,
      );
      return;
    }

    // Pre-checked before anything leaves the browser; the server checks again.
    for (const file of chosen) {
      const problem = checkImageFile(file);
      if (problem) {
        toast.error(problem);
        return;
      }
    }

    setUploadingPhotos(true);
    let uploaded = 0;
    for (const file of chosen) {
      const next = await uploadMedia({
        file,
        target: "MEDIA",
        title: titleFromFileName(file.name) || undefined,
      });
      if (!next) break;
      uploaded += 1;
      onProfile(next);
    }
    setUploadingPhotos(false);

    if (uploaded > 0) {
      toast.success(`${uploaded} image${uploaded === 1 ? "" : "s"} added`);
    }
  }

  async function uploadDocument(file: File, kind: DocumentKind) {
    const next = await uploadMedia({
      file,
      target: "MEDIA",
      kind,
      title: titleFromFileName(file.name) || undefined,
    });
    if (next) {
      onProfile(next);
      toast.success(kind === "BROCHURE" ? "Brochure added" : "Prospectus added");
    }
  }

  async function addVideo() {
    const url = videoUrl.trim();
    if (!url) return;

    // Pre-checked before anything leaves the browser; the server checks again.
    if (!normalizeVideoUrl(url)) {
      toast.error("Only YouTube and Vimeo links are supported.");
      return;
    }

    setAddingVideo(true);
    const next = await addMediaVideo({
      url,
      title: videoTitle.trim() || undefined,
    });
    setAddingVideo(false);

    if (next) {
      toast.success("Video added");
      onProfile(next);
      setVideoUrl("");
      setVideoTitle("");
    }
  }

  async function toggleStatus(item: MediaItem) {
    const nextStatus = item.status === "HIDDEN" ? "ACTIVE" : "HIDDEN";
    setBusyId(item.id);
    const next = await patchMediaItem(item.id, { status: nextStatus });
    setBusyId(null);
    if (next) {
      toast.success(nextStatus === "HIDDEN" ? "Hidden" : "Shown");
      onProfile(next);
    }
  }

  function startCaptionEdit(item: MediaItem) {
    setEditingCaptionId(item.id);
    setCaptionDraft(item.caption ?? "");
  }

  function cancelCaptionEdit() {
    setEditingCaptionId(null);
    setCaptionDraft("");
  }

  async function saveCaption(item: MediaItem) {
    const caption = captionDraft.trim();
    // The patch schema (`optionalText`, Tasks 5-6) treats an empty string as
    // "no value supplied" and leaves the stored caption untouched — so a
    // blank save would round-trip successfully, report "updated", and then
    // silently show the old caption again. Refusing it here, with a reason,
    // beats that quiet no-op.
    if (caption.length === 0) {
      toast.error(
        "A caption can't be cleared to blank here — type replacement text, or Cancel to leave it as is.",
      );
      return;
    }
    setBusyId(item.id);
    const next = await patchMediaItem(item.id, { caption });
    setBusyId(null);
    if (next) {
      toast.success("Caption updated");
      onProfile(next);
      setEditingCaptionId(null);
      setCaptionDraft("");
    }
  }

  /**
   * Swaps the `sortOrder` of two adjacent items within the same kind group.
   * Two sequential PATCHes, not one bulk call — the media API addresses items
   * one at a time and has no reorder endpoint of its own.
   */
  async function move(group: MediaItem[], item: MediaItem, direction: -1 | 1) {
    const index = group.findIndex((entry) => entry.id === item.id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= group.length) return;
    const other = group[targetIndex];

    setBusyId(item.id);
    const first = await patchMediaItem(item.id, { sortOrder: other.sortOrder });
    if (first) onProfile(first);
    if (first) {
      const second = await patchMediaItem(other.id, { sortOrder: item.sortOrder });
      if (second) onProfile(second);
    }
    setBusyId(null);
  }

  async function removeItem(item: MediaItem) {
    setBusyId(item.id);
    const next = await deleteMediaItem(item.id);
    setBusyId(null);
    if (next) {
      toast.success(`${MEDIA_KIND_LABELS[item.kind]} deleted`);
      onProfile(next);
      setPendingDelete(null);
    }
  }

  const captionProps: CaptionProps = {
    editingId: editingCaptionId,
    draft: captionDraft,
    onEdit: startCaptionEdit,
    onDraftChange: setCaptionDraft,
    onSave: saveCaption,
    onCancel: cancelCaptionEdit,
  };

  const actionProps: ItemProps = {
    busyId,
    onMove: move,
    onToggleStatus: toggleStatus,
    onDeleteRequest: setPendingDelete,
  };

  return (
    <div className="space-y-6">
      <PhotosGroup
        items={photos}
        uploading={uploadingPhotos}
        onUpload={uploadPhotos}
        caption={captionProps}
        actions={actionProps}
      />

      <VideosGroup
        items={videos}
        videoUrl={videoUrl}
        videoTitle={videoTitle}
        addingVideo={addingVideo}
        onVideoUrlChange={setVideoUrl}
        onVideoTitleChange={setVideoTitle}
        onAddVideo={addVideo}
        caption={captionProps}
        actions={actionProps}
      />

      <DocumentsGroup
        items={documents}
        onUploadDocument={uploadDocument}
        caption={captionProps}
        actions={actionProps}
      />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Delete this {pendingDelete ? kindNoun(pendingDelete) : "item"}?</DialogTitle>
            <DialogDescription>
              &ldquo;{pendingDelete?.title ?? "Untitled"}&rdquo; will be removed and deleted from
              storage. This cannot be undone — to take it off the public profile without losing it,
              hide it instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingDelete(null)}
              disabled={busyId !== null}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busyId !== null}
              onClick={() => pendingDelete && removeItem(pendingDelete)}
            >
              {busyId !== null ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
