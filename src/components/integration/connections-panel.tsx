"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Plug,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/utils/format";
import {
  CONNECTION_STATUS_LABELS,
  PLATFORM_LABELS,
  type ConnectionStatus,
} from "@/lib/constants";
import type { ConnectionEntry, SyncRunDTO } from "@/services/connection.service";

/**
 * Six-state tone map for `ConnectionStatus`. Borrows the tone/`cn()`
 * vocabulary from `scholarship-status-badge.tsx` (outlined / filled / dashed
 * / destructive-tinted) but is its own component sized for six states, not
 * an extension of the three-state badge — PENDING, AWAITING_APPROVAL and
 * ERROR have no equivalent there.
 */
const STATUS_TONE: Record<ConnectionStatus, string> = {
  PENDING: "border-foreground/25 bg-background text-foreground",
  AWAITING_APPROVAL: "border-foreground/25 bg-background text-foreground",
  CONNECTED: "border-transparent bg-foreground text-background",
  REJECTED: "border-destructive/40 bg-destructive/10 text-destructive",
  DISCONNECTED: "border-dashed border-border bg-background text-muted-foreground",
  ERROR: "border-destructive/40 bg-destructive/10 text-destructive",
};

function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        STATUS_TONE[status],
      )}
    >
      {CONNECTION_STATUS_LABELS[status]}
    </span>
  );
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(payload: Record<string, unknown> | null): string | undefined {
  const error = payload?.error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

/**
 * One sync run's detail — steps and (prominently) warnings. Warnings are the
 * product surface here: they name channels PassPercent's schema mapping
 * skipped, not debug noise to bury.
 */
function RunRow({ run }: { run: SyncRunDTO }) {
  const statusTone = run.status === "FAILED" ? "text-destructive" : "text-foreground";

  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cn("text-sm font-medium", statusTone)}>
          {run.status} <span className="font-normal text-muted-foreground">· {run.trigger}</span>
        </span>
        <span className="text-xs text-muted-foreground tabular">
          {formatDateTime(run.startedAt)}
          {run.finishedAt ? ` – ${formatDateTime(run.finishedAt)}` : ""}
        </span>
      </div>

      {run.steps?.length ? (
        <ul className="space-y-1 text-xs">
          {run.steps.map((step, index) => (
            <li key={index} className="flex items-start gap-1.5">
              <span className={step.ok ? "text-foreground" : "text-destructive"} aria-hidden>
                {step.ok ? "✓" : "✗"}
              </span>
              <span className="text-muted-foreground">
                {step.step}
                {step.detail ? ` — ${step.detail}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {run.warnings?.length ? (
        <div className="space-y-1 rounded-md border border-foreground/25 bg-mist p-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            Warnings
          </p>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {run.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {run.error ? <p className="text-xs text-destructive">{run.error}</p> : null}
    </li>
  );
}

function PlatformCard({
  entry,
  onUpdate,
}: {
  entry: ConnectionEntry;
  onUpdate: (entry: ConnectionEntry) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runs, setRuns] = useState<SyncRunDTO[] | null>(null);

  const label = PLATFORM_LABELS[entry.platform];
  const status = entry.status;
  const isConnected = status === "CONNECTED";
  const isPendingApproval = status === "PENDING" || status === "AWAITING_APPROVAL";
  const showRequest = !status || status === "DISCONNECTED" || status === "REJECTED" || status === "ERROR";
  const canDisconnect = Boolean(status) && status !== "DISCONNECTED";

  async function loadRuns() {
    setRunsLoading(true);
    try {
      const response = await fetch(`/api/settings/connections/${entry.platform}/runs`);
      const payload = await readJson(response);
      if (!response.ok || !payload?.success) {
        toast.error(errorMessage(payload) ?? "Could not load sync history.");
        return;
      }
      setRuns((payload.runs as SyncRunDTO[] | undefined) ?? []);
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setRunsLoading(false);
    }
  }

  async function toggleRuns() {
    const next = !runsOpen;
    setRunsOpen(next);
    if (next && runs === null) await loadRuns();
  }

  async function requestConnection() {
    setBusy(true);
    try {
      const response = await fetch(`/api/settings/connections/${entry.platform}/initiate`, {
        method: "POST",
      });
      const payload = await readJson(response);
      if (!response.ok || !payload?.success) {
        toast.error(errorMessage(payload) ?? "Could not request the connection. Please try again.");
        return;
      }
      onUpdate(payload.connection as ConnectionEntry);
      toast.success(`${label} connection requested`);
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function checkStatus() {
    setBusy(true);
    try {
      const response = await fetch(`/api/settings/connections/${entry.platform}/refresh`, {
        method: "POST",
      });
      const payload = await readJson(response);
      if (!response.ok || !payload?.success) {
        toast.error(errorMessage(payload) ?? "Could not check status. Please try again.");
        return;
      }
      const connection = payload.connection as ConnectionEntry;
      onUpdate(connection);
      if (connection.status === "CONNECTED") {
        toast.success(`${label} connected`);
      } else if (connection.status === "REJECTED") {
        toast.error(`${label} rejected the connection request`);
      } else {
        toast.info("Still waiting on approval");
      }
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    try {
      const response = await fetch(`/api/settings/connections/${entry.platform}/sync`, {
        method: "POST",
      });
      const payload = await readJson(response);
      if (!response.ok || !payload?.success) {
        // Covers the "a sync is already running" refusal from a concurrent
        // call — surfaced as a toast, not a crash, same as any other
        // refusal here.
        toast.error(errorMessage(payload) ?? "Could not sync. Please try again.");
        return;
      }
      onUpdate(payload.connection as ConnectionEntry);
      const run = payload.run as SyncRunDTO;
      if (run.status === "SUCCESS") {
        toast.success(`${label} sync complete`);
      } else if (run.status === "PARTIAL") {
        toast.info(`${label} sync finished with warnings — see recent runs below`);
      } else {
        toast.error(`${label} sync failed${run.error ? `: ${run.error}` : ""}`);
      }
      if (runsOpen) await loadRuns();
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSyncing(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      const response = await fetch(`/api/settings/connections/${entry.platform}`, {
        method: "DELETE",
      });
      const payload = await readJson(response);
      if (!response.ok || !payload?.success) {
        toast.error(errorMessage(payload) ?? "Could not disconnect. Please try again.");
        return;
      }
      onUpdate(payload.connection as ConnectionEntry);
      toast.success(`${label} disconnected`);
      setConfirmDisconnect(false);
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{label}</h3>
            {status ? <ConnectionStatusBadge status={status} /> : null}
          </div>
          {isConnected && entry.remoteInstitution ? (
            <p className="text-xs text-muted-foreground">
              {entry.remoteInstitution.name}
              {entry.remoteInstitution.city ? ` · ${entry.remoteInstitution.city}` : ""}
            </p>
          ) : null}
        </div>
      </div>

      {!entry.configured ? (
        <p className="text-sm text-muted-foreground">
          Not configured. Ask a platform administrator to add a {label} API key before this can be
          connected.
        </p>
      ) : (
        <>
          {entry.lastError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {entry.lastError}
            </div>
          ) : null}

          {isPendingApproval ? (
            <p className="text-sm text-muted-foreground">
              A {label} administrator{status === "AWAITING_APPROVAL" ? ", and possibly the school itself," : ""}{" "}
              needs to approve this request before IDAP can sync data. Check back after they do.
            </p>
          ) : null}

          {status === "REJECTED" ? (
            <p className="text-sm text-muted-foreground">
              {label} rejected the previous request. You can request again.
            </p>
          ) : null}

          {isConnected ? (
            <div className="space-y-3">
              {entry.scopes?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {entry.scopes.map((scope) => (
                    <span
                      key={scope}
                      className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {scope}
                    </span>
                  ))}
                </div>
              ) : null}

              <p className="text-xs text-muted-foreground tabular">
                {entry.lastSyncAt
                  ? `Last synced ${formatDateTime(entry.lastSyncAt)} — ${entry.lastSyncStatus ?? "unknown"}`
                  : "Not synced yet"}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {showRequest ? (
              <Button size="sm" onClick={requestConnection} disabled={busy}>
                <Plug className="size-3.5" />
                {busy ? "Requesting…" : "Request connection"}
              </Button>
            ) : null}

            {isPendingApproval ? (
              <Button size="sm" variant="outline" onClick={checkStatus} disabled={busy}>
                <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
                {busy ? "Checking…" : "Check status"}
              </Button>
            ) : null}

            {isConnected ? (
              <Button size="sm" onClick={syncNow} disabled={syncing}>
                <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
                {syncing ? "Syncing…" : "Sync now"}
              </Button>
            ) : null}

            {isConnected ? (
              <Button size="sm" variant="outline" onClick={toggleRuns}>
                {runsOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                Recent runs
              </Button>
            ) : null}

            {canDisconnect ? (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDisconnect(true)}
                disabled={busy}
              >
                <Unplug className="size-3.5" />
                Disconnect
              </Button>
            ) : null}
          </div>

          {isConnected && runsOpen ? (
            <div className="space-y-2 border-t border-border pt-3">
              {runsLoading ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  Loading runs…
                </p>
              ) : runs && runs.length > 0 ? (
                <ul className="space-y-2">
                  {runs.map((run) => (
                    <RunRow key={run.id} run={run} />
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No sync runs yet.</p>
              )}
            </div>
          ) : null}
        </>
      )}

      <Dialog open={confirmDisconnect} onOpenChange={(open) => !open && setConfirmDisconnect(false)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Disconnect {label}?</DialogTitle>
            <DialogDescription>
              This only removes the connection on IDAP&apos;s side and stops future syncs. It does{" "}
              <strong>not</strong> revoke {label}&apos;s access on its own — the grant stays live until
              the school (or a {label} administrator) also revokes it from {label}&apos;s own
              dashboard.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={disconnect} disabled={busy}>
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ConnectionsPanel({ connections }: { connections: ConnectionEntry[] }) {
  const [entries, setEntries] = useState(connections);

  function updateEntry(next: ConnectionEntry) {
    setEntries((current) => current.map((entry) => (entry.platform === next.platform ? next : entry)));
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {entries.map((entry) => (
        <PlatformCard key={entry.platform} entry={entry} onUpdate={updateEntry} />
      ))}
    </div>
  );
}
