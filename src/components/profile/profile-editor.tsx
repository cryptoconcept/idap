"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Check, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROFILE_STATUS_LABELS, type ProfileStatus } from "@/lib/constants";
import type { ProfileCompletion } from "@/lib/profile/completion";
import type { DerivedOfferings } from "@/lib/academic/offerings";
import type { ProfileDTO } from "@/lib/types";
import { CompletionMeter } from "@/components/profile/completion-meter";
import { PublishDialog } from "@/components/profile/publish-dialog";
import { BasicSection } from "@/components/profile/sections/basic-section";
import { ContactSection } from "@/components/profile/sections/contact-section";
import { AddressSection } from "@/components/profile/sections/address-section";
import { AcademicSection } from "@/components/profile/sections/academic-section";
import { ManagementSection } from "@/components/profile/sections/management-section";
import { FacilitiesSection } from "@/components/profile/sections/facilities-section";
import { SocialSection } from "@/components/profile/sections/social-section";
import { MediaSection } from "@/components/profile/sections/media-section";
import { AchievementsSection } from "@/components/profile/sections/achievements-section";
import { AlumniSection } from "@/components/profile/sections/alumni-section";

/**
 * `groups` names the completion groups a section owns, so the tick beside it is
 * the server's judgement of that section and never a second opinion computed
 * here. Media is not scored, so it names none.
 */
const SECTIONS = [
  { key: "basic", label: "Basic information", groups: ["identity", "logo", "cover"] },
  { key: "contact", label: "Contact", groups: ["contact"] },
  { key: "address", label: "Address", groups: ["address"] },
  { key: "academic", label: "Academic", groups: ["academic"] },
  { key: "management", label: "Management", groups: ["management"] },
  { key: "facilities", label: "Facilities", groups: ["facilities"] },
  { key: "social", label: "Social links", groups: ["social"] },
  { key: "media", label: "Media", groups: [] },
  { key: "achievements", label: "Achievements", groups: [] },
  { key: "alumni", label: "Notable alumni", groups: [] },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

function missingForSection(
  section: (typeof SECTIONS)[number],
  completion: ProfileCompletion,
): string[] | null {
  if (section.groups.length === 0) return null;
  return completion.groups
    .filter((group) => (section.groups as readonly string[]).includes(group.key))
    .flatMap((group) => group.missing);
}

export function ProfileEditor({
  initialProfile,
  initialCompletion,
  initialOfferings,
}: {
  initialProfile: ProfileDTO;
  initialCompletion: ProfileCompletion;
  /**
   * Derived from the academic structure tree, for the read-only summary the
   * Academic section renders. Nothing in this editor can change it — that
   * only happens on `/academic-structure` — so it is read once at page load
   * rather than refreshed on every section save.
   */
  initialOfferings: DerivedOfferings | null;
}) {
  const [profile, setProfile] = useState<ProfileDTO>(initialProfile);
  const [completion, setCompletion] = useState<ProfileCompletion>(initialCompletion);

  const [active, setActive] = useState<SectionKey>("basic");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<SectionKey | null>(null);

  /** Re-reads profile and completion together, for writes that return only one. */
  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/institution");
      const payload = await response.json();
      if (!response.ok || !payload.success) return;

      setProfile(payload.profile as ProfileDTO);
      setCompletion(payload.completion as ProfileCompletion);
    } catch {
      // The caller has already applied the profile it was handed; a failed
      // refresh leaves the meter stale rather than losing the write.
    }
  }, []);

  /** One PATCH per section, carrying only that section's fields. */
  const saveSection = useCallback(async (patch: Record<string, unknown>) => {
    try {
      const response = await fetch("/api/settings/institution", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not save. Please try again.");
        return false;
      }

      // Profile and completion both come back recomputed; nothing is guessed here.
      setProfile(payload.profile as ProfileDTO);
      setCompletion(payload.completion as ProfileCompletion);
      setDirty(false);
      toast.success("Section saved");
      return true;
    } catch {
      toast.error("Could not reach the server. Please try again.");
      return false;
    }
  }, []);

  /**
   * The media and publish endpoints return the profile but not the completion,
   * which a logo or a cover changes — so take the profile, then re-read both.
   */
  const applyProfile = useCallback(
    (next: ProfileDTO) => {
      setProfile(next);
      void reload();
    },
    [reload],
  );

  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);

  function requestSection(key: SectionKey) {
    if (key === active) return;
    if (dirty) {
      setPending(key);
      return;
    }
    setActive(key);
  }

  function discardAndMove() {
    if (!pending) return;
    setActive(pending);
    setPending(null);
    setDirty(false);
  }

  const sectionProps = { profile, onSave: saveSection, onDirtyChange };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <ProfileStatusChip status={profile.profileStatus} />
          {profile.profileStatus === "PUBLISHED" ? (
            <a
              href={`/api/public/${profile.institutionId}/profile`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              View public profile
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">
              Nothing is public until you publish.
            </span>
          )}
        </div>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <CompletionMeter
            percent={completion.percent}
            missingCount={completion.missing.length}
            className="sm:w-56"
          />
          <PublishDialog profile={profile} completion={completion} onChanged={applyProfile} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[228px_minmax(0,1fr)]">
        {/* Narrow viewports get the same list, collapsed into a select. */}
        <div className="lg:hidden">
          <Select value={active} onValueChange={(value) => requestSection(value as SectionKey)}>
            <SelectTrigger className="w-full" aria-label="Profile section">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SECTIONS.map((section) => {
                const missing = missingForSection(section, completion);
                return (
                  <SelectItem key={section.key} value={section.key}>
                    {section.label}
                    {missing && missing.length > 0 ? ` · ${missing.length} to add` : ""}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        <nav aria-label="Profile sections" className="hidden lg:block">
          <ul className="flex flex-col gap-0.5">
            {SECTIONS.map((section) => {
              const missing = missingForSection(section, completion);
              const complete = missing !== null && missing.length === 0;
              const isActive = section.key === active;

              return (
                <li key={section.key}>
                  <button
                    type="button"
                    onClick={() => requestSection(section.key)}
                    aria-current={isActive ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                      isActive
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <span className="truncate">{section.label}</span>
                    {complete ? (
                      <Check className="size-3.5 shrink-0" aria-label="Complete" />
                    ) : missing && missing.length > 0 ? (
                      <span
                        className="tabular shrink-0 rounded-full border border-border px-1.5 text-[11px] text-muted-foreground"
                        title={missing.join(", ")}
                      >
                        {missing.length}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0">
          {active === "basic" ? <BasicSection {...sectionProps} onProfile={applyProfile} /> : null}
          {active === "contact" ? <ContactSection {...sectionProps} /> : null}
          {active === "address" ? <AddressSection {...sectionProps} /> : null}
          {active === "academic" ? (
            <AcademicSection {...sectionProps} offerings={initialOfferings} />
          ) : null}
          {active === "management" ? <ManagementSection {...sectionProps} /> : null}
          {active === "facilities" ? <FacilitiesSection {...sectionProps} /> : null}
          {active === "social" ? <SocialSection {...sectionProps} /> : null}
          {active === "media" ? (
            <MediaSection profile={profile} onProfile={applyProfile} />
          ) : null}
          {active === "achievements" ? <AchievementsSection /> : null}
          {active === "alumni" ? <AlumniSection /> : null}
        </div>
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => {
          if (!open) setPending(null);
        }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Leave without saving?</DialogTitle>
            <DialogDescription>
              This section has changes that have not been saved. Leaving now discards them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
              Keep editing
            </Button>
            <Button size="sm" onClick={discardAndMove}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProfileStatusChip({ status }: { status: ProfileStatus }) {
  const tone =
    status === "PUBLISHED"
      ? "border-transparent bg-foreground text-background"
      : status === "SUSPENDED" || status === "ARCHIVED"
        ? "border-dashed border-border bg-background text-muted-foreground"
        : "border-foreground/25 bg-background text-foreground";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tone,
      )}
    >
      {PROFILE_STATUS_LABELS[status]}
    </span>
  );
}
