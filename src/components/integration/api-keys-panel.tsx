"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { KeyRound, Plus, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CopyButton } from "@/components/shared/copy-button";
import { Ref } from "@/components/shared/ref";
import { CodeBlock } from "@/components/integration/code-block";
import { EmptyState } from "@/components/shared/empty-state";
import { API_PERMISSIONS, API_PERMISSION_LABELS, type ApiPermission } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/utils/format";
import type { ApiClientDTO } from "@/lib/types";

type Issued = { keyId: string; secret: string; bearerToken: string; name: string };

export function ApiKeysPanel({
  clients,
  showInstitution = false,
  canCreate = true,
  emptyDescription = "Create a key to let your website submit enquiries and applications to this institution.",
}: {
  clients: ApiClientDTO[];
  showInstitution?: boolean;
  /**
   * Platform admins can review and revoke credentials but not issue them: a key
   * carrying READ_APPLICATION would be a way around the rule that they cannot
   * read tenant data.
   */
  canCreate?: boolean;
  emptyDescription?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<ApiPermission[]>([
    "CREATE_LEAD",
    "CREATE_APPLICATION",
  ]);
  const [saving, setSaving] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [, startTransition] = useTransition();

  function togglePermission(permission: ApiPermission, checked: boolean) {
    setPermissions((current) =>
      checked ? [...new Set([...current, permission])] : current.filter((item) => item !== permission),
    );
  }

  async function create() {
    if (!name.trim()) {
      toast.error("Give the key a name so you can recognise it later.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/api-clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, permissions }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not create the key. Please try again.");
        return;
      }

      setIssued({
        keyId: payload.keyId,
        secret: payload.secret,
        bearerToken: payload.bearerToken,
        name,
      });
      setName("");
      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function revoke(client: ApiClientDTO) {
    if (
      !window.confirm(
        `Revoke "${client.name}"? Any website using this key will stop being able to submit.`,
      )
    ) {
      return;
    }

    const response = await fetch(`/api/api-clients/${client.id}`, { method: "DELETE" });
    const payload = await response.json();

    if (!response.ok || !payload.success) {
      toast.error(payload?.error?.message ?? "Could not revoke the key. Please try again.");
      return;
    }

    toast.success(`"${client.name}" revoked`);
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-4">
      {issued ? (
        <div className="space-y-3 rounded-lg border border-foreground/25 bg-mist p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Secret for &ldquo;{issued.name}&rdquo;</h3>
            <p className="text-xs text-muted-foreground">
              This is the only time the secret is shown. Store it in your server environment now —
              it cannot be recovered, only replaced.
            </p>
          </div>

          <dl className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <dt className="eyebrow">Key ID</dt>
              <dd className="flex items-center gap-2">
                <Ref className="truncate">{issued.keyId}</Ref>
                <CopyButton value={issued.keyId} size="xs" variant="ghost" label="" />
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="eyebrow">Secret</dt>
              <dd className="flex items-center gap-2">
                <Ref className="truncate">{issued.secret}</Ref>
                <CopyButton value={issued.secret} size="xs" variant="ghost" label="" />
              </dd>
            </div>
          </dl>

          <CodeBlock
            label="Authorization header"
            copyLabel="Copy token"
            code={`Authorization: Bearer ${issued.bearerToken}`}
          />

          <Button variant="outline" size="sm" onClick={() => setIssued(null)}>
            I have stored it
          </Button>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {clients.length === 0
            ? "No API credentials yet."
            : `${clients.length} credential${clients.length === 1 ? "" : "s"}`}
        </p>

        {canCreate ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="size-3.5" />
              Create API key
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[440px]">
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                The secret is shown once, immediately after creation.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Main website"
                />
              </div>


              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Permissions</legend>
                {API_PERMISSIONS.map((permission) => (
                  <label key={permission} className="flex items-center gap-2.5 text-sm">
                    <Checkbox
                      checked={permissions.includes(permission)}
                      onCheckedChange={(checked) =>
                        togglePermission(permission, checked === true)
                      }
                    />
                    {API_PERMISSION_LABELS[permission]}
                  </label>
                ))}
              </fieldset>
            </div>

            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={create} disabled={saving || permissions.length === 0}>
                {saving ? "Creating…" : "Create key"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        ) : null}
      </div>

      {clients.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API credentials yet"
          description={emptyDescription}
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {clients.map((client) => (
            <li key={client.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{client.name}</p>
                  {client.active ? (
                    <span className="rounded-full border border-foreground/25 px-2 py-0.5 text-[11px]">
                      Active
                    </span>
                  ) : (
                    <span className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                      Revoked {client.revokedAt ? formatDate(client.revokedAt) : ""}
                    </span>
                  )}
                  {showInstitution ? (
                    <span className="text-xs text-muted-foreground">
                      {client.institutionName ?? client.institutionId}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <Ref className="text-[11px] text-muted-foreground">{client.keyId}</Ref>
                  <span>{client.permissions.map((p) => API_PERMISSION_LABELS[p]).join(", ")}</span>
                  <span className="tabular">
                    {client.lastUsedAt
                      ? `Last used ${formatDateTime(client.lastUsedAt)}`
                      : "Never used"}
                  </span>
                  <span className="tabular">{client.requestCount} requests</span>
                </div>
              </div>

              {client.active ? (
                <Button variant="outline" size="sm" onClick={() => revoke(client)}>
                  <ShieldOff className="size-3.5" />
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
