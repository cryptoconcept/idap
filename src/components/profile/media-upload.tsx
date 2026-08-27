"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProfileDTO } from "@/lib/types";

/** Mirrors the server's guard so an obviously wrong file never leaves the browser. */
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(",");
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Returns a message when the file cannot be uploaded, `null` when it can. */
export function checkImageFile(file: File): string | null {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name}: only JPG, PNG and WEBP images can be uploaded.`;
  }
  if (file.size <= 0) return `${file.name}: the file is empty.`;
  if (file.size > MAX_IMAGE_BYTES) return `${file.name}: images must be 5 MB or smaller.`;
  return null;
}

/** Strips the extension so an uploaded file arrives with a usable title. */
export function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 120);
}

/**
 * Posts one image and returns the refreshed profile, or `null` after reporting
 * the failure. The pre-check has already run; the server checks again.
 */
export async function uploadMedia(input: {
  file: File;
  target: "LOGO" | "COVER" | "MEDIA";
  title?: string;
  caption?: string;
}): Promise<ProfileDTO | null> {
  const body = new FormData();
  body.append("file", input.file);
  body.append("target", input.target);
  if (input.title) body.append("title", input.title);
  if (input.caption) body.append("caption", input.caption);

  try {
    const response = await fetch("/api/settings/institution/media", { method: "POST", body });
    const payload = await response.json();

    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not upload the image. Please try again.");
      return null;
    }
    return payload.profile as ProfileDTO;
  } catch {
    toast.error("Could not reach the server. Please try again.");
    return null;
  }
}

/**
 * A single replaceable image — the logo or the cover. Uploading replaces what
 * is there; the previous object is cleaned up server-side.
 */
export function ImageSlot({
  label,
  description,
  imageUrl,
  alt,
  target,
  fit = "contain",
  onUploaded,
}: {
  label: string;
  description: string;
  imageUrl?: string;
  alt: string;
  target: "LOGO" | "COVER";
  fit?: "contain" | "cover";
  onUploaded: (profile: ProfileDTO) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function onPick(file: File | undefined) {
    if (!file) return;
    const problem = checkImageFile(file);
    if (problem) {
      toast.error(problem);
      return;
    }

    setBusy(true);
    const profile = await uploadMedia({ file, target });
    setBusy(false);
    if (profile) {
      toast.success(`${label} updated`);
      onUploaded(profile);
    }
  }

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      <div
        className={cn(
          "relative aspect-[3/2] w-full overflow-hidden rounded-lg border",
          imageUrl ? "border-border bg-muted/40" : "border-dashed border-border bg-background",
        )}
      >
        {imageUrl ? (
          <Image
            src={imageUrl}
            alt={alt}
            fill
            unoptimized
            sizes="(min-width: 640px) 320px, 100vw"
            className={fit === "cover" ? "object-cover" : "object-contain p-3"}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
            <ImagePlus className="size-4" aria-hidden />
            <span className="text-xs">No {label.toLowerCase()} yet</span>
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
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "Uploading…" : imageUrl ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
      </Button>
    </div>
  );
}
