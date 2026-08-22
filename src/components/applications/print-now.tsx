"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PrintNow() {
  return (
    <Button type="button" size="sm" onClick={() => window.print()}>
      <Printer className="size-3.5" />
      Print
    </Button>
  );
}
