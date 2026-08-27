"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PLATFORM_LABELS, type Platform } from "@/lib/constants";
import { formatDateTime } from "@/lib/utils/format";

export type PlatformCredentialRow = {
  platform: Platform;
  baseUrl: string | null;
  active: boolean;
  /** Last 4 characters of the real key, prefixed with "…". The key itself never reaches the client. */
  keyMasked: string | null;
  updatedAt: string | null;
};

function CredentialCard({ row }: { row: PlatformCredentialRow }) {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState(row.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [active, setActive] = useState(row.active);
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  const connected = row.keyMasked !== null || row.baseUrl !== null;

  async function save() {
    if (!baseUrl.trim()) {
      toast.error("Enter a base URL before saving.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/admin/platform-credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // `key` is only sent when the admin actually typed one — leaving it
        // blank preserves whatever secret is already stored.
        body: JSON.stringify({
          platform: row.platform,
          baseUrl,
          active,
          ...(key.trim() ? { key: key.trim() } : {}),
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not save. Please try again.");
        return;
      }

      toast.success(`${PLATFORM_LABELS[row.platform]} saved`);
      setKey("");
      startTransition(() => router.refresh());
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        `Disconnect ${PLATFORM_LABELS[row.platform]}? IDAP will stop syncing with it until it is reconnected.`,
      )
    ) {
      return;
    }

    const response = await fetch(`/api/admin/platform-credentials/${row.platform}`, {
      method: "DELETE",
    });
    const payload = await response.json();

    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not disconnect. Please try again.");
      return;
    }

    toast.success(`${PLATFORM_LABELS[row.platform]} disconnected`);
    setBaseUrl("");
    setKey("");
    setActive(false);
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{PLATFORM_LABELS[row.platform]}</h3>
          <p className="text-xs text-muted-foreground">
            {connected
              ? row.updatedAt
                ? `Last saved ${formatDateTime(row.updatedAt)}`
                : "Configured"
              : "Not connected yet"}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={active}
            onCheckedChange={setActive}
            aria-label={`${PLATFORM_LABELS[row.platform]} active`}
          />
          {active ? "Active" : "Paused"}
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${row.platform}-baseUrl`}>Base URL</Label>
          <Input
            id={`${row.platform}-baseUrl`}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${row.platform}-key`}>API key</Label>
          <Input
            id={`${row.platform}-key`}
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={row.keyMasked ?? "Not set"}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        {connected ? (
          <Button variant="outline" size="sm" onClick={disconnect}>
            <Trash2 className="size-3.5" />
            Disconnect
          </Button>
        ) : null}
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function PlatformCredentialsPanel({
  vaultReady,
  credentials,
}: {
  vaultReady: boolean;
  credentials: PlatformCredentialRow[];
}) {
  return (
    <div className="space-y-4">
      {!vaultReady ? (
        <div className="flex items-start gap-3 rounded-lg border border-foreground/25 bg-mist px-4 py-3">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Platform connections are disabled</p>
            <p className="text-sm text-muted-foreground">
              Set the <code className="font-mono text-[11px]">IDAP_CREDENTIAL_KEY</code>{" "}
              environment variable — a 32-byte, base64-encoded secret — before a platform key can
              be saved. Base URLs and the active flag can still be edited.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {credentials.map((row) => (
          <CredentialCard key={row.platform} row={row} />
        ))}
      </div>
    </div>
  );
}
