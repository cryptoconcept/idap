"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const UNASSIGNED = "__unassigned__";

export function LeadAssignControl({
  leadId,
  assignedTo,
  assignees,
}: {
  leadId: string;
  assignedTo?: string;
  assignees: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(assignedTo ?? UNASSIGNED);
  const [saving, setSaving] = useState(false);

  async function change(next: string) {
    const previous = value;
    setValue(next);
    setSaving(true);

    try {
      const response = await fetch(`/api/leads/${leadId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedTo: next === UNASSIGNED ? null : next }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        setValue(previous);
        toast.error(payload?.error?.message ?? "Could not reassign. Please try again.");
        return;
      }

      toast.success(next === UNASSIGNED ? "Unassigned" : "Assigned");
      router.refresh();
    } catch {
      setValue(previous);
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Select value={value} onValueChange={change} disabled={saving}>
      <SelectTrigger size="sm" className="min-w-[168px]" aria-label="Assigned to">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
        {assignees.map((person) => (
          <SelectItem key={person.id} value={person.id}>{person.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
