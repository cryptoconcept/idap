"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink, Globe, Lock } from "lucide-react";
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
import type { ResultStatus } from "@/lib/constants";
import { describeCycle } from "@/lib/results/label";
import { blockingPublishReasons } from "@/lib/results/publish-readiness";
import type { ResultDTO } from "@/services/result.service";
import { ResultStatusBadge } from "@/components/results/result-status-badge";
import { CycleSection } from "@/components/results/cycle-section";
import { OutcomeSection } from "@/components/results/outcome-section";
import { ToppersSection } from "@/components/results/toppers-section";

/**
 * One save per section, carrying only that section's fields. Resolves with the
 * result the server recomputed, or `null` when it refused — which is what lets
 * a section reset itself only on a save that actually landed.
 */
export type SaveSection = (patch: Record<string, unknown>) => Promise<ResultDTO | null>;

/** What every result section takes: the cycle it reads, a save, a dirty signal. */
export type ResultSectionProps = {
  result: ResultDTO;
  onSave: SaveSection;
  onDirtyChange: (dirty: boolean) => void;
};

const SECTIONS = [
  { key: "cycle", label: "Exam cycle" },
  { key: "outcome", label: "Outcome" },
  { key: "toppers", label: "Toppers" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

/** The create form has one section and no shell, so it has nothing to track. */
const IGNORE_DIRTY = () => {};

export function ResultEditor({
  initialResult,
  institutionId,
}: {
  initialResult: ResultDTO;
  institutionId: string;
}) {
  const [result, setResult] = useState<ResultDTO>(initialResult);

  const [active, setActive] = useState<SectionKey>("cycle");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<SectionKey | null>(null);

  /** One PATCH per section, carrying only that section's fields. */
  const saveSection = useCallback<SaveSection>(
    async (patch) => {
      try {
        const response = await fetch(`/api/settings/results/${result.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const payload = await response.json();

        if (!response.ok || !payload.success) {
          toast.error(payload?.error?.message ?? "Could not save. Please try again.");
          return null;
        }

        // The whole cycle comes back recomputed — pass rate included; nothing
        // on this screen is guessed from what was sent.
        const next = payload.result as ResultDTO;
        setResult(next);
        setDirty(false);
        toast.success("Section saved");
        return next;
      } catch {
        toast.error("Could not reach the server. Please try again.");
        return null;
      }
    },
    [result.id],
  );

  /** Photo uploads and publication return the cycle without a section save. */
  const applyResult = useCallback((next: ResultDTO) => setResult(next), []);

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

  const sectionProps = { result, onSave: saveSection, onDirtyChange };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <ResultStatusBadge status={result.status as ResultStatus} />
          {result.status === "PUBLISHED" ? (
            <a
              href={`/api/public/${institutionId}/results`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              View public results
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">
              Nothing is public until you publish.
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <PublishControl result={result} onResult={applyResult} />
          <ArchiveDeleteControl result={result} onResult={applyResult} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[228px_minmax(0,1fr)]">
        {/* Narrow viewports get the same list, collapsed into a select. */}
        <div className="lg:hidden">
          <Select value={active} onValueChange={(value) => requestSection(value as SectionKey)}>
            <SelectTrigger className="w-full" aria-label="Result section">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SECTIONS.map((section) => (
                <SelectItem key={section.key} value={section.key}>
                  {section.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <nav aria-label="Result sections" className="hidden lg:block">
          <ul className="flex flex-col gap-0.5">
            {SECTIONS.map((section) => {
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
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0">
          {active === "cycle" ? <CycleSection {...sectionProps} /> : null}
          {active === "outcome" ? <OutcomeSection {...sectionProps} /> : null}
          {active === "toppers" ? (
            <ToppersSection {...sectionProps} onResult={applyResult} />
          ) : null}
        </div>
      </div>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
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

/**
 * Publication, and the reasons it is not available yet. The reasons are named
 * rather than implied: the server refuses the same cases in `assertPublishable`,
 * and a disabled button with no explanation is how that refusal reads as a bug.
 */
function PublishControl({
  result,
  onResult,
}: {
  result: ResultDTO;
  onResult: (result: ResultDTO) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const published = result.status === "PUBLISHED";
  const action = published ? "unpublish" : "publish";
  const reasons = published ? [] : blockingPublishReasons(result);

  async function confirm() {
    setBusy(true);
    try {
      const response = await fetch(`/api/settings/results/${result.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not change publication. Please try again.");
        return;
      }

      toast.success(published ? "Results unpublished" : "Results published");
      onResult(payload.result as ResultDTO);
      setOpen(false);
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 sm:max-w-xs">
      <Button
        size="sm"
        variant={published ? "outline" : "default"}
        disabled={reasons.length > 0}
        onClick={() => setOpen(true)}
      >
        {published ? <Lock className="size-3.5" /> : <Globe className="size-3.5" />}
        {published ? "Unpublish" : "Publish results"}
      </Button>

      {reasons.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>
              {published ? "Unpublish these results?" : "Publish these results?"}
            </DialogTitle>
            {published ? (
              <DialogDescription>
                {describeCycle(result)} disappears from your public results endpoint immediately.
                Nothing you have entered is deleted, and you can publish again at any time.
              </DialogDescription>
            ) : (
              <DialogDescription>
                Publishing {describeCycle(result)} makes these public to any website reading your
                API, with no login: the number who appeared and passed, the pass rate, your score
                bands, and the name, score and photo of every topper whose consent you have
                confirmed.
              </DialogDescription>
            )}
          </DialogHeader>

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
    </div>
  );
}

/**
 * Archive keeps the record (same POST action-endpoint as publish/unpublish);
 * delete removes it permanently and leaves the page, since there is nothing
 * left to show.
 */
function ArchiveDeleteControl({
  result,
  onResult,
}: {
  result: ResultDTO;
  onResult: (result: ResultDTO) => void;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"archive" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirmArchive() {
    setBusy(true);
    try {
      const response = await fetch(`/api/settings/results/${result.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "archive" }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not archive. Please try again.");
        return;
      }

      toast.success("Result archived");
      onResult(payload.result as ResultDTO);
      setDialog(null);
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      const response = await fetch(`/api/settings/results/${result.id}`, {
        method: "DELETE",
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not delete. Please try again.");
        setBusy(false);
        return;
      }

      toast.success("Result deleted");
      router.push("/results");
    } catch {
      toast.error("Could not reach the server. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {result.status !== "ARCHIVED" ? (
        <Button variant="outline" size="sm" onClick={() => setDialog("archive")}>
          Archive
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={() => setDialog("delete")}
      >
        Delete
      </Button>

      <Dialog open={dialog === "archive"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Archive {describeCycle(result)}?</DialogTitle>
            <DialogDescription>
              {result.status === "PUBLISHED"
                ? "This removes it from your public results endpoint. Nothing is deleted — you can unarchive by publishing again."
                : "This moves the cycle out of your active list. Nothing is deleted."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={confirmArchive} disabled={busy}>
              {busy ? "Archiving…" : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "delete"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Delete {describeCycle(result)}?</DialogTitle>
            <DialogDescription>
              This permanently removes the cycle, its score data, and any topper
              photos. This cannot be undone.
              {result.status === "PUBLISHED"
                ? " It also disappears from your public results endpoint immediately."
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

/**
 * Creating a cycle is the cycle section on its own: a POST, then the editor.
 * The outcome numbers and the toppers wait for the result to exist, because a
 * topper's photograph has nowhere to attach itself until it does.
 */
export function NewResultForm() {
  const router = useRouter();

  const create = useCallback<SaveSection>(
    async (patch) => {
      try {
        const response = await fetch("/api/settings/results", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // A new cycle starts with an empty cohort — the create schema wants
          // both numbers, and the outcome section is where they are entered.
          body: JSON.stringify({ appeared: 0, passed: 0, ...patch }),
        });
        const payload = await response.json();

        if (!response.ok || !payload.success) {
          toast.error(payload?.error?.message ?? "Could not create the result. Please try again.");
          return null;
        }

        const created = payload.result as ResultDTO;
        toast.success("Result created");
        router.push(`/results/${created.id}`);
        return created;
      } catch {
        toast.error("Could not reach the server. Please try again.");
        return null;
      }
    },
    [router],
  );

  return <CycleSection result={null} onSave={create} onDirtyChange={IGNORE_DIRTY} />;
}
