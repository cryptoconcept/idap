"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  variant = "outline",
  size = "sm",
  className,
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  variant?: "outline" | "ghost" | "secondary" | "default";
  size?: "xs" | "sm" | "default";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button type="button" variant={variant} size={size} onClick={copy} className={cn(className)}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? copiedLabel : label}
    </Button>
  );
}
