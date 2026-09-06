"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, ExternalLink, Globe, Lock, Send, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ScholarshipDTO } from "@/services/scholarship.service";
import type { ScholarshipListingDTO } from "@/services/scholarship-publish.service";
import { scholarshipListingState } from "@/lib/scholarship/listing-display";

type DialogKind = "publish" | "unpublish" | "archive" | "delete" | null;

const HUB_LABEL = "Scholarship Hub";

/**
 * `lastPushedAt` is an ISO string from the server; rendering it needs the
 * browser's locale, and doing that during the server pass would produce a
 * different string than the client's and trip hydration. `ScholarshipActions`
 * is a client component, so the value only ever renders client-side and
 * there is no server render to disagree with — same convention as
 * `vacancies-section.tsx`'s own `formatPushedAt`.
 */
function formatPushedAt(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Everything Scholarship Hub knows about this listing — mirrors
 * `vacancies-section.tsx`'s `ListingPanel` (badge / `publicUrl` link /
 * verbatim `blockedReason`), adapted to Scholarship Hub's simpler contract
 * (no claim/conflict state — see `scholarship-publish.service.ts`'s own
 * docblock).
 *
 * The badge state comes from `scholarshipListingState`, NOT from reading
 * `listing.remoteStatus` directly here: `blockedReason` is authoritative
 * over `remoteStatus` (Task 8's forward contract — a blocked push can be
 * recorded as `remoteStatus: "published"` with `hubId: ""`), so a listing
 * carrying one must never show as "Live".
 *
 * `blockedReason` is printed **verbatim** when present. It is not a code and
 * not a developer string — it is written by the orchestrator
 * (`scholarship-publish.service.ts`'s `recordBlockedReason`) for an
 * institution admin to read, and rewording or hiding it would throw away the
 * only explanation of why nothing is live yet.
 */
function ListingPanel({ listing }: { listing: ScholarshipListingDTO }) {
  const state = scholarshipListingState(listing);

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={state === "live" ? "default" : "outline"}>
          {state === "live"
            ? `Live on ${HUB_LABEL}`
            : state === "blocked"
              ? `Blocked on ${HUB_LABEL}`
              : `Closed on ${HUB_LABEL}`}
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          Last pushed {formatPushedAt(listing.lastPushedAt)}
        </span>
      </div>

      {listing.publicUrl ? (
        <a
          href={listing.publicUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-primary underline underline-offset-2 break-all"
        >
          <ExternalLink className="size-3 shrink-0" aria-hidden />
          {listing.publicUrl}
        </a>
      ) : state === "live" ? (
        // Not every listing has one: `upsertScholarship`'s `OK` response
        // carries `publicUrl` only when Scholarship Hub actually created or
        // still serves the listing.
        <p className="text-[11px] text-muted-foreground">
          {HUB_LABEL} did not return a public link for this listing.
        </p>
      ) : null}

      {listing.blockedReason ? (
        <p className="flex items-start gap-1.5 text-[11px] text-destructive">
          <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
          {/* Verbatim — see this component's docblock. */}
          <span>{listing.blockedReason}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Mirrors `FeeStructureActions` — same confirm-dialog pattern, same
 * fetch/toast/router cycle, for a scholarship's three lifecycle actions
 * (publish/unpublish, archive, delete).
 */
export function ScholarshipActions({ scholarship }: { scholarship: ScholarshipDTO }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);
  const [hubBusy, setHubBusy] = useState(false);

  async function setStatus(action: "publish" | "unpublish" | "archive") {
    setBusy(true);
    try {
      const response = await fetch(`/api/settings/scholarships/${scholarship.id}/publish`, {
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
          ? "Scholarship published"
          : action === "unpublish"
            ? "Scholarship unpublished"
            : "Scholarship archived",
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
      const response = await fetch(`/api/settings/scholarships/${scholarship.id}`, {
        method: "DELETE",
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not delete. Please try again.");
        setBusy(false);
        return;
      }

      toast.success("Scholarship deleted");
      router.push("/scholarships");
    } catch {
      toast.error("Could not reach the server. Please try again.");
      setBusy(false);
    }
  }

  /**
   * A retry/resync request to Scholarship Hub, distinct from `setStatus`
   * above even though it POSTs the exact same route with the exact same
   * `{ action: "publish" }` body. `ScholarshipService.setStatus("publish")`
   * always attempts a best-effort `ScholarshipPublishService.publish` as a
   * side-effect (Task 9) — that already covers the FIRST publish, since the
   * local "Publish" button above calls this same handler while the
   * scholarship is not yet `PUBLISHED`. This control exists for the case
   * that button no longer covers: the scholarship is already `PUBLISHED`
   * (so the button above now reads "Unpublish"), and an admin wants to push
   * again — after fixing a `blockedReason`, after connecting to Scholarship
   * Hub for the first time, or just to pick up an edit that failed to
   * syndicate. `pushFields`'s upsert is idempotent by `externalRef`, so
   * pressing this repeatedly is always safe.
   *
   * Deliberately does not read the response's `scholarship` for the fresh
   * listing: `setStatus`'s server-side `enriched` DTO is computed BEFORE the
   * Hub push runs, so it would still be stale. `router.refresh()` re-renders
   * this page's server component, which re-fetches the scholarship and
   * picks up whatever `ScholarshipPublishService.publish` just wrote.
   */
  async function publishToHub() {
    setHubBusy(true);
    try {
      const response = await fetch(`/api/settings/scholarships/${scholarship.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "publish" }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? `Could not reach ${HUB_LABEL}. Please try again.`);
        return;
      }

      // This is a best-effort push (Task 9): a 200 here only means the local
      // request succeeded, not that Scholarship Hub actually listed it — a
      // `SKIPPED` (not yet Hub-publishable, or not connected) or `BLOCKED`
      // outcome looks identical from here. `router.refresh()` is what
      // actually shows the school what happened: a real listing, an updated
      // `blockedReason`, or neither.
      toast.success(`Sent to ${HUB_LABEL}`);
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setHubBusy(false);
    }
  }

  const published = scholarship.status === "PUBLISHED";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={published ? "outline" : "default"}
          onClick={() => setDialog(published ? "unpublish" : "publish")}
        >
          {published ? <Lock className="size-3.5" /> : <Globe className="size-3.5" />}
          {published ? "Unpublish" : "Publish"}
        </Button>
        {scholarship.status !== "ARCHIVED" ? (
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
        {published ? (
          <Button size="sm" variant="outline" onClick={publishToHub} disabled={hubBusy}>
            <Send className="size-3.5" />
            {hubBusy ? "Sending…" : `Publish to ${HUB_LABEL}`}
          </Button>
        ) : null}
      </div>

      {scholarship.listing ? <ListingPanel listing={scholarship.listing} /> : null}

      <Dialog open={dialog === "publish"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Publish {scholarship.name}?</DialogTitle>
            <DialogDescription>
              This makes the scholarship public to any website reading your API, with no login.
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
            <DialogTitle>Unpublish {scholarship.name}?</DialogTitle>
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
            <DialogTitle>Archive {scholarship.name}?</DialogTitle>
            <DialogDescription>
              {scholarship.status === "PUBLISHED"
                ? "This removes it from your public API. Nothing is deleted — you can publish again to bring it back."
                : "This moves the scholarship out of your active list. Nothing is deleted."}
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
            <DialogTitle>Delete {scholarship.name}?</DialogTitle>
            <DialogDescription>
              This permanently removes the scholarship. This cannot be undone.
              {scholarship.status === "PUBLISHED"
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
