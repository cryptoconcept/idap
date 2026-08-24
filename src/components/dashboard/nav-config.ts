import {
  Building2,
  FileText,
  GraduationCap,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Plug,
  Receipt,
  Settings,
  Users,
} from "lucide-react";

import type { UserRole } from "@/lib/constants";

export type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Match nested routes, e.g. /applications/INS0001-APP-000001. */
  prefix?: boolean;
  /**
   * Hidden from Counselor and Front Desk sessions. Mirrors each target page's
   * own guard (Profile, Results, Integration, Settings, Staff are all
   * INSTITUTION_ADMIN-only — see the page-level fixes and the new /staff
   * route). This is a direct role check, not a `ROLE_PERMISSIONS` lookup —
   * that table only covers Leads and Staff-management actions, and repurposing
   * `STAFF_MANAGE` to also mean "is admin" for unrelated pages would be a
   * semantic mismatch.
   */
  adminOnly?: boolean;
};

export type NavGroup = { items: NavItem[] };

const INSTITUTION_NAV: NavGroup[] = [
  {
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/enquiries", label: "Enquiries", icon: Inbox, prefix: true },
      { href: "/applications", label: "Applications", icon: FileText, prefix: true },
      { href: "/results", label: "Results", icon: GraduationCap, prefix: true, adminOnly: true },
    ],
  },
  {
    items: [
      { href: "/staff", label: "Staff", icon: Users, adminOnly: true },
      { href: "/profile", label: "Institution Profile", icon: Building2, adminOnly: true },
      { href: "/integration", label: "Integration", icon: Plug, adminOnly: true },
      { href: "/settings", label: "Settings", icon: Settings, adminOnly: true },
      { href: "/fees", label: "Fees", icon: Receipt, adminOnly: true },
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
  if (role === "SUPER_ADMIN") return { title: "Admin", groups: SUPER_ADMIN_NAV };

  const groups = INSTITUTION_NAV.map((group) => ({
    items: group.items.filter((item) => !item.adminOnly || role === "INSTITUTION_ADMIN"),
  })).filter((group) => group.items.length > 0);

  return { title: "I-DAP", groups };
}
