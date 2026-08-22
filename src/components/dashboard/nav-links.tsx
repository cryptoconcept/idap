"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { navForRole } from "./nav-config";
import type { UserRole } from "@/lib/constants";

/**
 * The nav is resolved from the role inside this client component: icon
 * components cannot be serialised across the server/client boundary.
 */
export function NavLinks({
  role,
  onNavigate,
}: {
  role: UserRole;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { groups } = navForRole(role);

  function isActive(href: string, prefix?: boolean) {
    if (pathname === href) return true;
    return Boolean(prefix) && pathname.startsWith(`${href}/`);
  }

  return (
    <nav className="flex flex-col gap-5">
      {groups.map((group, index) => (
        <ul key={index} className="flex flex-col gap-0.5">
          {group.items.map((item) => {
            const active = isActive(item.href, item.prefix);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                  )}
                >
                  <item.icon className="size-4 shrink-0" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ))}
    </nav>
  );
}
