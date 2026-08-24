"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";

/** Renders followUpAt (an ISO datetime string) as a plain YYYY-MM-DD for the date input. */
function toDateInputValue(iso?: string): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

export function LeadFollowUpControl({
  leadId,
  followUpAt,
}: {
  leadId: string;
  followUpAt?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(toDateInputValue(followUpAt));
  const [saving, setSaving] = useState(false);

  async function save(next: string) {
    const previous = value;
    setValue(next);
    setSaving(true);

    try {
      const response = await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ followUpAt: next || null }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        setValue(previous);
        toast.error(payload?.error?.message ?? "Could not update the follow-up date. Please try again.");
        return;
      }

      toast.success(next ? "Follow-up date set" : "Follow-up date cleared");
      router.refresh();
    } catch {
      setValue(previous);
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Input
      type="date"
      value={value}
      disabled={saving}
      onChange={(event) => save(event.target.value)}
      className="w-40"
      aria-label="Follow-up date"
    />
  );
}
