"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SCHOLARSHIP_APPLICATION_REVIEW_STATUSES, type ScholarshipApplicationReviewStatus } from "@/lib/constants";

const REVIEW_STATUS_LABELS: Record<ScholarshipApplicationReviewStatus, string> = {
  NEW: "New",
  UNDER_REVIEW: "Under review",
  SHORTLISTED: "Shortlisted",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export function ScholarshipApplicationReviewStatusControl({
  id,
  reviewStatus,
}: {
  id: string;
  reviewStatus: ScholarshipApplicationReviewStatus;
}) {
  const router = useRouter();
  const [value, setValue] = useState<ScholarshipApplicationReviewStatus>(reviewStatus);
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  async function change(next: string) {
    const nextStatus = next as ScholarshipApplicationReviewStatus;
    const previous = value;
    setValue(nextStatus);
    setSaving(true);

    try {
      const response = await fetch(`/api/scholarship-applications/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewStatus: nextStatus }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        setValue(previous);
        toast.error(payload?.error?.message ?? "Could not update the status. Please try again.");
        return;
      }

      toast.success(`Status changed to ${REVIEW_STATUS_LABELS[nextStatus]}`);
      startTransition(() => router.refresh());
    } catch {
      setValue(previous);
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Select value={value} onValueChange={change} disabled={saving}>
      <SelectTrigger size="sm" className="min-w-[168px]" aria-label="Review status">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SCHOLARSHIP_APPLICATION_REVIEW_STATUSES.map((option) => (
          <SelectItem key={option} value={option}>
            {REVIEW_STATUS_LABELS[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
