"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { MEDIA_MAX_ITEMS } from "@/lib/constants";
import type { ProfileDTO } from "@/lib/types";
import {
  ACCEPT_ATTRIBUTE,
  checkImageFile,
  titleFromFileName,
  uploadMedia,
} from "@/components/profile/media-upload";

type GalleryItem = NonNullable<ProfileDTO["media"]>[number];

/**
 * Not a form: every action here is its own request against the media
 * endpoints, so there is nothing to save and nothing to make dirty.
 */
export function GallerySection({
  profile,
  onProfile,
}: {
  profile: ProfileDTO;
  onProfile: (profile: ProfileDTO) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GalleryItem | null>(null);

  const items = profile.media ?? [];
  const remaining = MEDIA_MAX_ITEMS.IMAGE - items.length;

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    const chosen = Array.from(files);
    if (chosen.length > remaining) {
      toast.error(
        `A gallery holds at most ${MEDIA_MAX_ITEMS.IMAGE} images. There is room for ${remaining} more.`,
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

    setUploading(true);
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
    setUploading(false);

    if (uploaded > 0) {
      toast.success(`${uploaded} image${uploaded === 1 ? "" : "s"} added`);
    }
  }

  async function setStatus(item: GalleryItem, status: "ACTIVE" | "HIDDEN") {
    setBusyId(item.id);
    try {
      const response = await fetch(`/api/settings/institution/media/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not change the image. Please try again.");
        return;
      }

      toast.success(status === "HIDDEN" ? "Image hidden" : "Image shown");
      onProfile(payload.profile as ProfileDTO);
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(item: GalleryItem) {
    setBusyId(item.id);
    try {
      const response = await fetch(`/api/settings/institution/media/${item.id}`, {
        method: "DELETE",
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not delete the image. Please try again.");
        return;
      }

      toast.success("Image deleted");
      onProfile(payload.profile as ProfileDTO);
      setPendingDelete(null);
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5 rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold tracking-tight">Gallery</h2>
          <p className="text-xs text-muted-foreground">
            {items.length} of {MEDIA_MAX_ITEMS.IMAGE} images. Hidden images stay here but are left out
            of the public profile.
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          className="hidden"
          onChange={(event) => {
            void onFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          size="sm"
          disabled={uploading || remaining <= 0}
          onClick={() => inputRef.current?.click()}
        >
          <ImagePlus className="size-3.5" />
          {uploading ? "Uploading…" : "Upload images"}
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={ImagePlus}
          title="No gallery images yet"
          description="Add photographs of the campus, classrooms and events. They are the first thing a parent looks at on your public profile. JPG, PNG or WEBP, up to 5 MB each."
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((item) => {
            const hidden = item.status === "HIDDEN";
            const busy = busyId === item.id;

            return (
              <li
                key={item.id}
                className="space-y-2 overflow-hidden rounded-lg border border-border p-2"
              >
                <div className="relative aspect-[4/3] w-full overflow-hidden rounded bg-muted/40">
                  <Image
                    src={item.url}
                    alt={item.title ?? "Gallery image"}
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

                <p className="truncate text-xs text-muted-foreground" title={item.title}>
                  {item.title ?? "Untitled"}
                </p>

                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={busy}
                    onClick={() => setStatus(item, hidden ? "ACTIVE" : "HIDDEN")}
                  >
                    {hidden ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                    {hidden ? "Show" : "Hide"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    aria-label={`Delete ${item.title ?? "gallery image"}`}
                    onClick={() => setPendingDelete(item)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Delete this image?</DialogTitle>
            <DialogDescription>
              &ldquo;{pendingDelete?.title ?? "Untitled"}&rdquo; will be removed from your gallery
              and deleted from storage. This cannot be undone — to take it off the public profile
              without losing it, hide it instead.
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
              onClick={() => pendingDelete && remove(pendingDelete)}
            >
              {busyId !== null ? "Deleting…" : "Delete image"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
