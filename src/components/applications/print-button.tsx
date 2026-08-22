"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Opens the print view in a new tab and triggers the browser print dialog from
 * there, so the dashboard page itself is never what gets printed.
 */
export function PrintButton({ applicationNumber }: { applicationNumber: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        window.open(
          `/applications/${encodeURIComponent(applicationNumber)}/print?autoprint=1`,
          "_blank",
          "noopener",
        )
      }
    >
      <Printer className="size-3.5" />
      Print application
    </Button>
  );
}
