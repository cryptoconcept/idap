"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { SidebarBody, type SidebarContext } from "./sidebar";

export function MobileNav({ context }: { context: SidebarContext }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Open navigation">
          <Menu className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[264px] bg-sidebar p-0">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarBody context={context} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
