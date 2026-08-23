import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { SidebarBody, type SidebarContext } from "@/components/dashboard/sidebar";
import { MobileNav } from "@/components/dashboard/mobile-nav";

export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const institution = await getCurrentInstitution();

  const context: SidebarContext = {
    role: user.role,
    userName: user.name,
    userEmail: user.email,
    institutionId: institution?.institutionId,
    institutionName: institution?.institutionName,
  };

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="hidden w-[248px] shrink-0 border-r border-sidebar-border bg-sidebar lg:sticky lg:top-0 lg:block lg:h-dvh">
        <SidebarBody context={context} />
      </aside>

      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-background/90 px-3 py-2 backdrop-blur lg:hidden">
        <MobileNav context={context} />
        <span className="text-[11px] font-semibold tracking-[0.14em] uppercase">
          {user.role === "SUPER_ADMIN" ? "Admin" : "Lead Platform"}
        </span>
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {institution?.institutionId ?? user.email}
        </span>
      </header>

      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
