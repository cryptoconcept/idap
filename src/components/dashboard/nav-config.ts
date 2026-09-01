import {
  Award,
  Building2,
  Cable,
  FileText,
  GraduationCap,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ListTree,
  Plug,
  Receipt,
  Settings,
  Ticket,
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

/**
 * `title` is optional: a group without one renders as a bare block, which is
 * what the first group wants — a heading above "Dashboard" would say nothing
 * the link does not already say.
 */
export type NavGroup = { title?: string; items: NavItem[] };

/**
 * Grouped by what someone is trying to do, not by which subsystem owns the
 * page. Daily work first, configuration last — `Settings` is the final item
 * because that is where people look for it.
 */
const INSTITUTION_NAV: NavGroup[] = [
  {
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/enquiries", label: "Enquiries", icon: Inbox, prefix: true },
      { href: "/applications", label: "Applications", icon: FileText, prefix: true, adminOnly: true },
    ],
  },
  {
    title: "Academics",
    items: [
      { href: "/results", label: "Results", icon: GraduationCap, prefix: true, adminOnly: true },
      { href: "/academic-structure", label: "Academic Structure", icon: ListTree, adminOnly: true },
    ],
  },
  {
    title: "Money & offers",
    items: [
      { href: "/fees", label: "Fees", icon: Receipt, adminOnly: true },
      { href: "/scholarships", label: "Scholarships", icon: Award, prefix: true, adminOnly: true },
      { href: "/offers", label: "Offers", icon: Ticket, prefix: true, adminOnly: true },
    ],
  },
  {
    title: "Institution setup",
    items: [
      { href: "/profile", label: "Institution Profile", icon: Building2, adminOnly: true },
      { href: "/staff", label: "Staff", icon: Users, adminOnly: true },
      { href: "/integration", label: "Integration", icon: Plug, adminOnly: true },
      { href: "/settings", label: "Settings", icon: Settings, adminOnly: true },
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
    ],
  },
  {
    // Both are credentials the platform admin issues to outside systems:
    // API Clients for callers into IDAP, Platforms for IDAP calling out.
    title: "Integrations",
    items: [
      { href: "/admin/api-clients", label: "API Clients", icon: KeyRound },
      { href: "/admin/platforms", label: "Platforms", icon: Cable },
    ],
  },
  {
    items: [{ href: "/admin/settings", label: "Settings", icon: Settings }],
  },
];

export function navForRole(role: UserRole): { title: string; groups: NavGroup[] } {
  if (role === "SUPER_ADMIN") return { title: "Admin", groups: SUPER_ADMIN_NAV };

  // Spread the group so `title` survives the filter, then drop any group left
  // empty — otherwise a non-admin session renders an "Academics" heading with
  // no links beneath it.
  const groups = INSTITUTION_NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.adminOnly || role === "INSTITUTION_ADMIN"),
  })).filter((group) => group.items.length > 0);

  return { title: "I-DAP", groups };
}
