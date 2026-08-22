"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/constants";
import { LEAD_STATUS_LABELS } from "@/lib/utils/format";

export function LeadStatusControl({
  leadNumber,
  status,
}: {
  leadNumber: string;
  status: LeadStatus;
}) {
  const router = useRouter();
  const [value, setValue] = useState<LeadStatus>(status);
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  async function change(next: string) {
    const nextStatus = next as LeadStatus;
    const previous = value;
    setValue(nextStatus);
    setSaving(true);

    try {
      const response = await fetch(`/api/leads/${encodeURIComponent(leadNumber)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        setValue(previous);
        toast.error(payload?.error?.message ?? "Could not update the status. Please try again.");
        return;
      }

      toast.success(`Status changed to ${LEAD_STATUS_LABELS[nextStatus]}`);
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
      <SelectTrigger size="sm" className="min-w-[168px]" aria-label="Enquiry status">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LEAD_STATUSES.map((option) => (
          <SelectItem key={option} value={option}>
            {LEAD_STATUS_LABELS[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
