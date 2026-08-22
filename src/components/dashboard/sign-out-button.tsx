"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LogOut } from "lucide-react";
import { cn } from "@/lib/utils";

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    startTransition(() => {
      router.replace("/login");
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy || pending}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground disabled:opacity-50",
        className,
      )}
    >
      <LogOut className="size-4 shrink-0" />
      {busy || pending ? "Signing out…" : "Logout"}
    </button>
  );
}
