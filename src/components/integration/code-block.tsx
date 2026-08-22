"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export function CodeBlock({
  code,
  label,
  copyLabel = "Copy",
  className,
}: {
  code: string;
  label?: string;
  copyLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-mist", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="eyebrow">{label ?? "Example"}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : copyLabel}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-3 text-[12px] leading-relaxed">
        <code className="font-mono text-foreground">{code}</code>
      </pre>
    </div>
  );
}
