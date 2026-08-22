"use client";

import { useEffect } from "react";

/** Opens the browser print dialog once the document has painted. */
export function AutoPrint({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => window.print(), 350);
    return () => window.clearTimeout(timer);
  }, [enabled]);

  return null;
}
