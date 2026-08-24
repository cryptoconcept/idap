"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, Globe, Lock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FeeStructureDTO } from "@/services/fee-structure.service";

type DialogKind = "publish" | "unpublish" | "archive" | "delete" | null;

/**
 * Mirrors `ArchiveDeleteControl`/`PublishControl` from
 * `src/components/results/result-editor.tsx` — same confirm-dialog pattern,
 * same fetch/toast/router cycle, combined into one component since a fee
 * structure has three lifecycle actions (publish/unpublish, archive, delete)
 * rather than two.
 */
export function FeeStructureActions({ feeStructure }: { feeStructure: FeeStructureDTO }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);

  async function setStatus(action: "publish" | "unpublish" | "archive") {
    setBusy(true);
    try {
      const response = await fetch(`/api/settings/fees/${feeStructure.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not update. Please try again.");
        return;
      }

      toast.success(
        action === "publish"
          ? "Fee structure published"
          : action === "unpublish"
            ? "Fee structure unpublished"
            : "Fee structure archived",
      );
      setDialog(null);
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      const response = await fetch(`/api/settings/fees/${feeStructure.id}`, { method: "DELETE" });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not delete. Please try again.");
        setBusy(false);
        return;
      }

      toast.success("Fee structure deleted");
      router.push("/fees");
    } catch {
      toast.error("Could not reach the server. Please try again.");
      setBusy(false);
    }
  }

  const published = feeStructure.status === "PUBLISHED";

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant={published ? "outline" : "default"}
        onClick={() => setDialog(published ? "unpublish" : "publish")}
      >
        {published ? <Lock className="size-3.5" /> : <Globe className="size-3.5" />}
        {published ? "Unpublish" : "Publish"}
      </Button>
      {feeStructure.status !== "ARCHIVED" ? (
        <Button size="sm" variant="outline" onClick={() => setDialog("archive")}>
          <Archive className="size-3.5" />
          Archive
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        className="text-destructive hover:text-destructive"
        onClick={() => setDialog("delete")}
      >
        <Trash2 className="size-3.5" />
        Delete
      </Button>

      <Dialog open={dialog === "publish"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Publish {feeStructure.classOrCourse}&apos;s fees?</DialogTitle>
            <DialogDescription>
              This makes every line item public to any website reading your API, with no login.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => setStatus("publish")} disabled={busy}>
              {busy ? "Publishing…" : "Publish now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "unpublish"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Unpublish {feeStructure.classOrCourse}&apos;s fees?</DialogTitle>
            <DialogDescription>
              This removes it from your public API immediately. Nothing is deleted, and you can
              publish again at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => setStatus("unpublish")} disabled={busy}>
              {busy ? "Unpublishing…" : "Unpublish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "archive"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Archive {feeStructure.classOrCourse}&apos;s fees?</DialogTitle>
            <DialogDescription>
              {feeStructure.status === "PUBLISHED"
                ? "This removes it from your public API. Nothing is deleted — you can publish again to bring it back."
                : "This moves the structure out of your active list. Nothing is deleted."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => setStatus("archive")} disabled={busy}>
              {busy ? "Archiving…" : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "delete"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Delete {feeStructure.classOrCourse}&apos;s fees?</DialogTitle>
            <DialogDescription>
              This permanently removes the fee structure and every line item. This cannot be
              undone.
              {feeStructure.status === "PUBLISHED"
                ? " It also disappears from your public API immediately."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmDelete} disabled={busy}>
              {busy ? "Deleting…" : "Delete permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
