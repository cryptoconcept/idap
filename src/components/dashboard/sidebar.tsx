import Link from "next/link";
import { navForRole } from "./nav-config";
import { NavLinks } from "./nav-links";
import { SignOutButton } from "./sign-out-button";
import { Ref } from "@/components/shared/ref";
import type { UserRole } from "@/lib/constants";

export type SidebarContext = {
  role: UserRole;
  userName: string;
  userEmail: string;
  institutionId?: string;
  institutionName?: string;
};

export function SidebarBody({
  context,
  onNavigate,
}: {
  context: SidebarContext;
  onNavigate?: () => void;
}) {
  const { title } = navForRole(context.role);
  const homeHref = context.role === "SUPER_ADMIN" ? "/admin" : "/dashboard";

  return (
    <div className="flex h-full flex-col gap-6 px-3 py-4">
      <Link
        href={homeHref}
        onClick={onNavigate}
        className="flex items-center gap-2.5 px-2.5 py-1"
      >
        <span
          className="flex size-6 items-center justify-center rounded bg-foreground text-[11px] font-semibold text-background"
          aria-hidden
        >
          A
        </span>
        <span className="text-[11px] font-semibold tracking-[0.14em] uppercase">{title}</span>
      </Link>

      <div className="flex-1 overflow-y-auto">
        <NavLinks role={context.role} onNavigate={onNavigate} />
      </div>

      <div className="space-y-3 border-t border-sidebar-border pt-3">
        <div className="space-y-0.5 px-2.5">
          {context.institutionId ? (
            <>
              <p className="truncate text-xs font-medium text-foreground">
                {context.institutionName ?? "Institution"}
              </p>
              <Ref className="text-[11px] text-muted-foreground">{context.institutionId}</Ref>
            </>
          ) : (
            <>
              <p className="truncate text-xs font-medium text-foreground">{context.userName}</p>
              <p className="truncate text-[11px] text-muted-foreground">{context.userEmail}</p>
            </>
          )}
        </div>
        <SignOutButton />
      </div>
    </div>
  );
}
