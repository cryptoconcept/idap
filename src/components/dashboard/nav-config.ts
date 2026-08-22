import {
  Building2,
  FileText,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Plug,
  Settings,
} from "lucide-react";

import type { UserRole } from "@/lib/constants";

export type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Match nested routes, e.g. /applications/INS0001-APP-000001. */
  prefix?: boolean;
};

export type NavGroup = { items: NavItem[] };

const INSTITUTION_NAV: NavGroup[] = [
  {
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/enquiries", label: "Enquiries", icon: Inbox, prefix: true },
      { href: "/applications", label: "Applications", icon: FileText, prefix: true },
    ],
  },
  {
    items: [
      { href: "/integration", label: "Integration", icon: Plug },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

/**
 * The platform admin provisions institutions; they have no route to enquiry or
 * application data, so there is nothing here that would lead to one.
 */
const SUPER_ADMIN_NAV: NavGroup[] = [
  {
    items: [
      { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
      { href: "/admin/institutions", label: "Institutions", icon: Building2, prefix: true },
      { href: "/admin/api-clients", label: "API Clients", icon: KeyRound },
    ],
  },
  {
    items: [{ href: "/admin/settings", label: "Settings", icon: Settings }],
  },
];

export function navForRole(role: UserRole): { title: string; groups: NavGroup[] } {
  return role === "SUPER_ADMIN"
    ? { title: "Admin", groups: SUPER_ADMIN_NAV }
    : { title: "Lead Portal", groups: INSTITUTION_NAV };
}
