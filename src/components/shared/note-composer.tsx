"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function NoteComposer({ endpoint }: { endpoint: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;

    setSaving(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not add the note. Please try again.");
        return;
      }

      setNote("");
      toast.success("Note added");
      startTransition(() => router.refresh());
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Add a note for your team…"
        rows={3}
        maxLength={4000}
        aria-label="New note"
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={saving || !note.trim()}>
          {saving ? "Adding…" : "Add note"}
        </Button>
      </div>
    </form>
  );
}
