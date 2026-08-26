"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ImagePlus } from "lucide-react";
import type { ResultDTO } from "@/services/result.service";
import { Button } from "@/components/ui/button";
import { ACCEPT_ATTRIBUTE, checkImageFile } from "@/components/profile/media-upload";

/**
 * One topper's photograph. Uploaded straight away against the saved topper's
 * id, so it is never part of a section's Save — which is also why it only
 * appears once the row exists on the server.
 *
 * `topperId` is a Mongo ObjectId, globally unique regardless of which array
 * on the result document the topper lives in — a top-level topper, a
 * combination's, or a selection's. The endpoint below is unaware of which;
 * the service widens its own lookup instead (see result.service.ts).
 */
export function TopperPhoto({
  resultId,
  topper,
  onResult,
  position,
}: {
  resultId: string;
  topper: { id: string; name: string; photoUrl?: string };
  onResult: (result: ResultDTO) => void;
  position: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/settings/results/${resultId}/toppers/${topper.id}/photo`;
  const label = topper.name.trim() || `topper ${position}`;

  async function send(init: RequestInit, success: string) {
    setBusy(true);
    try {
      const response = await fetch(endpoint, init);
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not change the photo. Please try again.");
        return;
      }

      toast.success(success);
      onResult(payload.result as ResultDTO);
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    // Pre-checked before anything leaves the browser; the server checks again.
    const problem = checkImageFile(file);
    if (problem) {
      toast.error(problem);
      return;
    }

    const body = new FormData();
    body.append("file", file);
    await send({ method: "POST", body }, `Photo updated for ${label}`);
  }

  return (
    <div className="flex items-center gap-3">
      <div className="relative size-14 shrink-0 overflow-hidden rounded-lg border border-border bg-muted/40">
        {topper.photoUrl ? (
          <Image
            src={topper.photoUrl}
            alt={`${label} photograph`}
            fill
            unoptimized
            sizes="56px"
            className="object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <ImagePlus className="size-4" aria-hidden />
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        className="hidden"
        onChange={(event) => {
          void upload(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Working…" : topper.photoUrl ? "Replace photo" : "Upload photo"}
        </Button>
        {topper.photoUrl ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void send({ method: "DELETE" }, `Photo removed for ${label}`)}
          >
            Remove
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground">JPG, PNG or WEBP, up to 5 MB.</p>
      </div>
    </div>
  );
}
