"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Globe, Lock } from "lucide-react";
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
import type { ProfileCompletion } from "@/lib/profile/completion";
import type { ProfileDTO } from "@/lib/types";

/**
 * Exactly what the public projection lets out, named in the words an institute
 * admin would use. If this list and `toPublicProfile` ever disagree, this list
 * is the one that is wrong.
 */
const GOES_PUBLIC: { label: string; detail: string }[] = [
  { label: "Identity", detail: "Name, legal and short name, type, tagline, description, year established, your slug and region code" },
  { label: "Images", detail: "Logo, cover image and every gallery image that is not hidden" },
  { label: "Address", detail: "Street, locality, area, city, taluk, district, state, country, pincode, map location" },
  { label: "Contact", detail: "Phone, secondary phone, WhatsApp, email, alternate email, website, contact person" },
  { label: "Academics", detail: "Board, affiliation, recognition, UDISE code, medium, classes and courses offered" },
  { label: "Management", detail: "Management type, trust or society, principal and head designation — names only" },
  { label: "Facilities", detail: "Every facility you have listed, with its note" },
  { label: "Social links", detail: "Facebook, Instagram, YouTube, LinkedIn, X and any link you added" },
];

const STAYS_PRIVATE =
  "The head's direct email and phone, your account details, enquiries, applications and whether the account is active are never published.";

export function PublishDialog({
  profile,
  completion,
  onChanged,
}: {
  profile: ProfileDTO;
  completion: ProfileCompletion;
  onChanged: (profile: ProfileDTO) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const published = profile.profileStatus === "PUBLISHED";
  const action = published ? "unpublish" : "publish";
  const missing = completion.missing;

  async function confirm() {
    setBusy(true);
    try {
      const response = await fetch("/api/settings/institution/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not change publication. Please try again.");
        return;
      }

      toast.success(published ? "Profile unpublished" : "Profile published");
      onChanged(payload.profile as ProfileDTO);
      setOpen(false);
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={published ? "outline" : "default"}>
          {published ? <Lock className="size-3.5" /> : <Globe className="size-3.5" />}
          {published ? "Unpublish" : "Publish profile"}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{published ? "Unpublish this profile?" : "Publish this profile?"}</DialogTitle>
          <DialogDescription>
            {published
              ? "The public profile endpoint will start returning 404 immediately. Nothing you have entered is deleted, and you can publish again at any time."
              : "Anyone will be able to read the details below from your public profile endpoint, with no API key."}
          </DialogDescription>
        </DialogHeader>

        {published ? (
          <p className="text-sm text-muted-foreground">
            Any website that reads{" "}
            <span className="font-mono text-[13px] text-foreground">
              /api/public/{profile.institutionId}/profile
            </span>{" "}
            will stop receiving your details until you publish again.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="eyebrow">What becomes public</p>
              <dl className="divide-y divide-border rounded-lg border border-border">
                {GOES_PUBLIC.map((entry) => (
                  <div key={entry.label} className="grid gap-0.5 px-3 py-2 sm:grid-cols-[130px_1fr] sm:gap-3">
                    <dt className="text-xs font-medium text-foreground">{entry.label}</dt>
                    <dd className="text-xs text-muted-foreground">{entry.detail}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-muted-foreground">{STAYS_PRIVATE}</p>
            </div>

            {missing.length > 0 ? (
              <div className="space-y-1.5 rounded-lg border border-dashed border-border p-3">
                <p className="text-xs font-medium text-foreground">
                  {completion.percent}% complete — {missing.length} detail
                  {missing.length === 1 ? "" : "s"} missing
                </p>
                <p className="text-xs text-muted-foreground">
                  You can publish anyway. Missing details are simply left out of the public
                  response: {missing.join(", ")}.
                </p>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={confirm} disabled={busy}>
            {busy
              ? published
                ? "Unpublishing…"
                : "Publishing…"
              : published
                ? "Unpublish"
                : "Publish now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
