"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/constants";
import { APPLICATION_STATUS_LABELS } from "@/lib/utils/format";

/**
 * Status is a reviewed decision, so it is changed through a confirmation step
 * that also captures an optional note for the record.
 */
export function ApplicationStatusDialog({
  applicationNumber,
  status,
}: {
  applicationNumber: string;
  status: ApplicationStatus;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nextStatus, setNextStatus] = useState<ApplicationStatus>(status);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  async function save() {
    setSaving(true);
    try {
      const response = await fetch(
        `/api/applications/${encodeURIComponent(applicationNumber)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus, note: note.trim() || undefined }),
        },
      );
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not update the status. Please try again.");
        return;
      }

      toast.success(`Status changed to ${APPLICATION_STATUS_LABELS[nextStatus]}`);
      setNote("");
      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setNextStatus(status);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Change status
          <ChevronDown className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Change application status</DialogTitle>
          <DialogDescription>
            The change is recorded in the application&apos;s activity trail.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="status">Status</Label>
            <Select value={nextStatus} onValueChange={(value) => setNextStatus(value as ApplicationStatus)}>
              <SelectTrigger id="status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APPLICATION_STATUSES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {APPLICATION_STATUS_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="status-note">Note (optional)</Label>
            <Textarea
              id="status-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="Why is this application moving to this status?"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving || nextStatus === status}>
            {saving ? "Saving…" : "Save status"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
